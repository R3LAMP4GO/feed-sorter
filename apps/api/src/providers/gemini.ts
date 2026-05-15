// Google Gemini 1.5 Flash provider — cloud LLM for the managed API.
//
// Shape mirrors the existing Groq path in `background.js` (`llmChatGroq`,
// around line 1837) so the call site in routes/workers stays uniform with
// the extension's local providers: pass `{ messages, schema, options, ... }`
// → receive `{ text, json, tokensIn, tokensOut, model, durationMs }`.
//
// One endpoint serves both modalities — `chatVision` is `chatText` plus
// `inlineData` parts inside the user message. Gemini's API:
//   POST https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent
// with `?key=<API_KEY>` for auth and a body of
//   { systemInstruction, contents[], generationConfig }
// Response surfaces tokens under `usageMetadata.{promptTokenCount,candidatesTokenCount}`.
//
// Cost / rate-limit handling is intentionally light here — wrapping retries
// and 429-aware backoff is the caller's job, mirroring how `groq.ts` works.

import { env } from '../env.js';

const GEMINI_ENDPOINT =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent';

const DEFAULT_MODEL = 'gemini-1.5-flash';
const DEFAULT_TIMEOUT_MS = 60_000;

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  // Ollama-style alias accepted for parity with `background.js` callers.
  num_predict?: number;
}

export interface ChatTextPayload {
  messages: ChatMessage[];
  /**
   * When truthy, asks Gemini for `application/json` output. If an object is
   * passed (a JSON Schema), it's forwarded as `responseSchema` — Gemini will
   * constrain the output to that shape.
   */
  schema?: unknown;
  options?: ChatOptions | null;
  model?: string;
  timeoutMs?: number;
  /** Used for structured logging; passed through unchanged. */
  kind?: string;
  /** Override `process.env.GEMINI_API_KEY` (tests, multi-tenant). */
  apiKey?: string;
}

export interface ImageInput {
  /** e.g. 'image/jpeg', 'image/png'. */
  mimeType: string;
  /** Base64-encoded image bytes (no `data:` prefix). */
  data: string;
}

export interface ChatVisionPayload extends ChatTextPayload {
  images: ImageInput[];
}

export interface ChatResult {
  text: string;
  json: unknown | null;
  tokensIn: number;
  tokensOut: number;
  model: string;
  durationMs: number;
}

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiContent {
  role?: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiGenerationConfig {
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
  responseSchema?: unknown;
}

interface GeminiRequest {
  systemInstruction?: { parts: Array<{ text: string }> };
  contents: GeminiContent[];
  generationConfig?: GeminiGenerationConfig;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[]; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
}

class GeminiError extends Error {
  status?: number;
  kind?: 'auth' | 'rate-limit' | 'config' | 'parse';
  retryAfter?: string;
  provider = 'gemini';
}

function resolveApiKey(payload: { apiKey?: string }): string {
  const key = (payload.apiKey ?? env.GEMINI_API_KEY ?? '').trim();
  if (!key) {
    const err = new GeminiError('gemini: GEMINI_API_KEY not configured');
    err.kind = 'config';
    throw err;
  }
  return key;
}

// Split a free-form messages[] array into Gemini's two-slot shape:
// `systemInstruction` (the concatenated system turns) and `contents` (the
// alternating user/model turns). Multiple system messages are joined with a
// blank line, matching how the OpenAI-compat layer in `groq.ts` would treat
// them.
function partitionMessages(messages: ChatMessage[]): {
  systemText: string | null;
  contents: GeminiContent[];
} {
  const sys: string[] = [];
  const contents: GeminiContent[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      if (m.content) sys.push(m.content);
      continue;
    }
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    });
  }
  return {
    systemText: sys.length ? sys.join('\n\n') : null,
    contents,
  };
}

function buildGenerationConfig(
  options: ChatOptions | null | undefined,
  schema: unknown,
): GeminiGenerationConfig | undefined {
  const cfg: GeminiGenerationConfig = {};
  if (options) {
    if (typeof options.temperature === 'number') cfg.temperature = options.temperature;
    if (typeof options.top_p === 'number') cfg.topP = options.top_p;
    const max =
      typeof options.max_tokens === 'number'
        ? options.max_tokens
        : typeof options.num_predict === 'number'
          ? options.num_predict
          : undefined;
    if (typeof max === 'number') cfg.maxOutputTokens = max;
  }
  if (schema) {
    cfg.responseMimeType = 'application/json';
    // Boolean/`true` means "JSON mode" without a schema; an object is a
    // full JSON Schema that Gemini will enforce.
    if (typeof schema === 'object' && schema !== null) {
      cfg.responseSchema = schema;
    }
  }
  return Object.keys(cfg).length ? cfg : undefined;
}

function parseJsonOrThrow(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Gemini occasionally fences JSON even in `responseMimeType=application/json`
    // mode when the system prompt suggests Markdown; salvage that.
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) {
      try {
        return JSON.parse(fence[1]);
      } catch {
        /* fall through */
      }
    }
    const err = new GeminiError('gemini: structured-output JSON parse failed');
    err.kind = 'parse';
    throw err;
  }
}

async function postGenerateContent(
  body: GeminiRequest,
  apiKey: string,
  timeoutMs: number,
): Promise<GeminiResponse> {
  const ctrl = new AbortController();
  const timer =
    timeoutMs > 0
      ? setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
      : null;
  try {
    const resp = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      if (resp.status === 429) {
        const err = new GeminiError(
          `gemini: rate limited${detail ? `: ${detail.slice(0, 160)}` : ''}`,
        );
        err.status = 429;
        err.kind = 'rate-limit';
        const ra = resp.headers.get('retry-after');
        if (ra) err.retryAfter = ra;
        throw err;
      }
      if (resp.status === 401 || resp.status === 403) {
        const err = new GeminiError(`gemini: auth failed (${resp.status})`);
        err.status = resp.status;
        err.kind = 'auth';
        throw err;
      }
      const err = new GeminiError(`gemini ${resp.status}: ${detail.slice(0, 200)}`);
      err.status = resp.status;
      throw err;
    }
    return (await resp.json()) as GeminiResponse;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function buildResult(raw: GeminiResponse, fallbackModel: string, t0: number, hasSchema: boolean): ChatResult {
  const parts = raw.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('');
  const tokensIn = Number(raw.usageMetadata?.promptTokenCount) || 0;
  const tokensOut = Number(raw.usageMetadata?.candidatesTokenCount) || 0;
  const model = raw.modelVersion || fallbackModel;
  const json = hasSchema ? parseJsonOrThrow(text) : null;
  return {
    text,
    json,
    tokensIn,
    tokensOut,
    model,
    durationMs: Date.now() - t0,
  };
}

export async function chatText(payload: ChatTextPayload): Promise<ChatResult> {
  if (!Array.isArray(payload?.messages) || payload.messages.length === 0) {
    throw new GeminiError('gemini.chatText: messages[] required');
  }
  const apiKey = resolveApiKey(payload);
  const model = payload.model ?? DEFAULT_MODEL;
  const timeoutMs = payload.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const { systemText, contents } = partitionMessages(payload.messages);
  const body: GeminiRequest = {
    contents,
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
  };
  const cfg = buildGenerationConfig(payload.options, payload.schema);
  if (cfg) body.generationConfig = cfg;

  const t0 = Date.now();
  const raw = await postGenerateContent(body, apiKey, timeoutMs);
  return buildResult(raw, model, t0, Boolean(payload.schema));
}

export async function chatVision(payload: ChatVisionPayload): Promise<ChatResult> {
  if (!Array.isArray(payload?.messages) || payload.messages.length === 0) {
    throw new GeminiError('gemini.chatVision: messages[] required');
  }
  if (!Array.isArray(payload.images) || payload.images.length === 0) {
    throw new GeminiError('gemini.chatVision: images[] required');
  }
  const apiKey = resolveApiKey(payload);
  const model = payload.model ?? DEFAULT_MODEL;
  const timeoutMs = payload.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const { systemText, contents } = partitionMessages(payload.messages);
  // Attach images to the final user turn. If the last turn isn't a user,
  // append a dedicated user turn carrying just the images — same pattern
  // `llmAttachImages` uses in `background.js`.
  const last = contents[contents.length - 1];
  const imageParts: GeminiPart[] = payload.images.map((img) => ({
    inlineData: { mimeType: img.mimeType, data: img.data },
  }));
  if (last && last.role === 'user') {
    last.parts.push(...imageParts);
  } else {
    contents.push({ role: 'user', parts: imageParts });
  }

  const body: GeminiRequest = {
    contents,
    ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
  };
  const cfg = buildGenerationConfig(payload.options, payload.schema);
  if (cfg) body.generationConfig = cfg;

  const t0 = Date.now();
  const raw = await postGenerateContent(body, apiKey, timeoutMs);
  return buildResult(raw, model, t0, Boolean(payload.schema));
}

export { GeminiError };
