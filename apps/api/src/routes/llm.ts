// /v1/llm/* \u2014 cache-fronted Gemini wrappers for hook+topic analysis and
// cover-image vision classification.
//
// Two routes, both:
//   1. Hash the input into a stable content-addressed cache key.
//   2. SELECT from `analyses` via `services/cache.ts` \u2014 hit \u2192 return cached.
//   3. Miss \u2192 one Gemini call \u2192 upsert into cache \u2192 signal the middleware
//      so it bumps the per-user monthly counter.
//
// Schemas mirror the extension-side definitions exactly so the managed API
// surface is drop-in compatible with `src/analysis/post-analysis.js` and
// `src/analysis/cover-analysis.js`:
//   - HOOK_SCHEMA + TOPIC_SCHEMA \u2192 merged into one ANALYZE_SCHEMA so we save a
//     round-trip vs the local-Ollama path (which does them in parallel).
//   - COVER_SCHEMA \u2192 unchanged.
//
// All adapters (chat, vision, cache, fetch) are injected via `buildLlmRoutes`
// so the unit tests can swap them for in-memory fakes without standing up
// Postgres or hitting Gemini.

import { Hono } from 'hono';
import { createHash } from 'node:crypto';

import {
  chatText as defaultChatText,
  chatVision as defaultChatVision,
  type ChatMessage,
  type ChatResult,
  type ChatTextPayload,
  type ChatVisionPayload,
} from '../providers/gemini.js';
import {
  getCached as defaultGetCached,
  putCached as defaultPutCached,
} from '../services/cache.js';
import { LLM_CACHE_MISS_KEY } from '../middleware/usage-counter.js';
import { log } from '../log.js';

// -------- Schemas (mirror src/analysis/post-analysis.js + cover-analysis.js)

const HOOK_TYPES = [
  'question',
  'contrarian',
  'listicle',
  'curiosity-gap',
  'stat-drop',
  'story-open',
  'other',
] as const;
type HookType = (typeof HOOK_TYPES)[number];

const COVER_EXPRESSIONS = [
  'happy',
  'serious',
  'surprised',
  'neutral',
  'other',
  'none',
] as const;
type CoverExpression = (typeof COVER_EXPRESSIONS)[number];

const COVER_COMPOSITIONS = [
  'closeup',
  'wide',
  'split',
  'text-heavy',
  'product',
  'other',
] as const;
type CoverComposition = (typeof COVER_COMPOSITIONS)[number];

// Combined hook + topic schema. One Gemini call, four fields.
const ANALYZE_SCHEMA = {
  type: 'object',
  properties: {
    hook: { type: 'string', description: 'The opening line of the post (\u226412 words)' },
    hookType: { type: 'string', enum: HOOK_TYPES as unknown as string[] },
    topic: { type: 'string', description: 'The subject (1\u20133 words, e.g. \'macros\')' },
    angle: { type: 'string', description: 'The treatment (1\u20134 words, e.g. \'myth-busting\')' },
  },
  required: ['hook', 'hookType', 'topic', 'angle'],
};

const COVER_SCHEMA = {
  type: 'object',
  properties: {
    hasFace: { type: 'boolean' },
    faceCount: { type: 'integer', minimum: 0 },
    expression: { type: 'string', enum: COVER_EXPRESSIONS as unknown as string[] },
    hasTextOverlay: { type: 'boolean' },
    textContent: { type: ['string', 'null'] },
    dominantColor: { type: 'string' },
    composition: { type: 'string', enum: COVER_COMPOSITIONS as unknown as string[] },
  },
  required: [
    'hasFace',
    'faceCount',
    'expression',
    'hasTextOverlay',
    'textContent',
    'dominantColor',
    'composition',
  ],
};

const ANALYZE_SYSTEM = [
  'You analyze short-form social-media posts and extract HOOK + TOPIC in one pass.',
  'Return strict JSON matching the schema. No commentary, no markdown.',
  '',
  'Field rules:',
  "  hook      \u2014 the opening sentence (or implied opening), \u226412 words, lightly normalized.",
  "  hookType  \u2014 one of:",
  '              question       \u2014 opens with an interrogative',
  '              contrarian    \u2014 challenges common belief',
  '              listicle      \u2014 promises N items / steps / reasons',
  '              curiosity-gap \u2014 withholds info to bait the watch',
  '              stat-drop     \u2014 leads with a number / statistic',
  '              story-open    \u2014 sets a scene / personal anecdote',
  '              other         \u2014 none of the above',
  "  topic     \u2014 the subject in 1\u20133 lowercase words (e.g. 'macros', 'cold plunges').",
  "  angle     \u2014 the treatment in 1\u20134 lowercase words (e.g. 'myth-busting',",
  "              'how-to', 'before/after', 'rant', 'reaction', 'tutorial', 'storytime').",
].join('\n');

const COVER_SYSTEM = [
  'You are a cover-image classifier for short-form-video thumbnails.',
  'You are shown ONE cover frame. Return strict JSON matching the schema.',
  'No commentary, no markdown fences.',
  '',
  'Field rules:',
  '  hasFace          \u2014 true if at least one human face is clearly visible.',
  '  faceCount        \u2014 integer count of distinct faces (0 if hasFace=false).',
  "  expression       \u2014 dominant facial expression: 'happy' | 'serious' |",
  "                     'surprised' | 'neutral' | 'other' | 'none' (no face).",
  '  hasTextOverlay   \u2014 true if there is significant graphic text burned',
  '                     into the image (NOT the caption \u2014 the cover itself).',
  '  textContent      \u2014 verbatim text overlay (\u226480 chars) or null when absent.',
  "  dominantColor    \u2014 single short color name (e.g. 'red', 'navy', 'beige').",
  "  composition      \u2014 'closeup' | 'wide' | 'split' | 'text-heavy' |",
  "                     'product' | 'other'.",
].join('\n');

// -------- Pure helpers ------------------------------------------------------

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Normalize a caption for stable cache identity:
 *   - NFKC unicode normalization (compatibility \u2192 single codepoints)
 *   - trim, collapse whitespace, lowercase
 *
 * Two captions that differ only in whitespace / case yield the same hash and
 * therefore share a cache row \u2014 desirable since the LLM output should be
 * identical.
 */
export function normalizeCaption(s: string): string {
  return String(s ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

const PREFIX_MAP: Record<string, string> = {
  ig: 'instagram',
  tt: 'tiktok',
  yt: 'youtube',
};

/**
 * Split a namespaced post id (`ig_<pk>`, `tt_<id>`, `yt_<videoId>`) into its
 * `platform` + `nativeId` parts for the hash payload. Unknown prefixes pass
 * through verbatim so the hash is still deterministic.
 */
export function parsePostId(postId: string): { platform: string; nativeId: string } {
  const m = /^([a-z]{2,3})_(.+)$/.exec(postId);
  if (!m) return { platform: 'unknown', nativeId: postId };
  return { platform: PREFIX_MAP[m[1]] ?? m[1], nativeId: m[2] };
}

export function analyzeHash(postId: string, caption: string): string {
  const { platform, nativeId } = parsePostId(postId);
  const captionNormHash = sha256Hex(normalizeCaption(caption));
  return `sha256:${sha256Hex(`analyze:${platform}:${nativeId}:${captionNormHash}`)}`;
}

export function coverHash(coverUrl: string): string {
  return `sha256:${sha256Hex(`cover:${coverUrl}`)}`;
}

function trimWords(s: string, max: number): string {
  return String(s || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, max)
    .join(' ');
}

function buildAnalyzeUserContent(caption: string, transcript: string | null): string {
  const c = caption.trim() || '(no caption)';
  const parts = [`CAPTION:\n${c}`];
  if (transcript?.trim()) {
    // Cap transcript at ~600 chars so we don't blow the prompt budget for
    // long videos. The hook is in the first few seconds anyway.
    parts.push(`TRANSCRIPT (opening):\n${transcript.trim().slice(0, 600)}`);
  }
  return parts.join('\n\n');
}

interface AnalyzeResult {
  hook: string;
  hookType: HookType;
  topic: string;
  angle: string;
}

interface CoverResult {
  hasFace: boolean;
  faceCount: number;
  expression: CoverExpression;
  hasTextOverlay: boolean;
  textContent: string | null;
  dominantColor: string;
  composition: CoverComposition;
}

function normalizeAnalyzeJson(raw: unknown): AnalyzeResult {
  const j = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawHookType = String(j.hookType ?? 'other');
  const hookType = (HOOK_TYPES as readonly string[]).includes(rawHookType)
    ? (rawHookType as HookType)
    : 'other';
  return {
    hook: trimWords(String(j.hook ?? ''), 12),
    hookType,
    topic: String(j.topic ?? '').toLowerCase().trim(),
    angle: String(j.angle ?? '').toLowerCase().trim(),
  };
}

function normalizeCoverJson(raw: unknown): CoverResult {
  const j = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const hasFace = !!j.hasFace;
  const faceCountRaw = Number(j.faceCount);
  const faceCount = Number.isFinite(faceCountRaw)
    ? Math.max(0, Math.min(50, Math.round(faceCountRaw)))
    : hasFace
      ? 1
      : 0;
  const rawExpression = String(j.expression ?? '').toLowerCase().trim();
  const expression: CoverExpression = (COVER_EXPRESSIONS as readonly string[]).includes(
    rawExpression,
  )
    ? (rawExpression as CoverExpression)
    : hasFace
      ? 'neutral'
      : 'none';
  const hasTextOverlay = !!j.hasTextOverlay;
  let textContent: string | null = null;
  if (hasTextOverlay && typeof j.textContent === 'string') {
    const t = j.textContent.trim();
    if (t) textContent = t.slice(0, 80);
  }
  const dominantColor =
    String(j.dominantColor ?? '')
      .trim()
      .slice(0, 24)
      .toLowerCase() || 'unknown';
  const rawComposition = String(j.composition ?? '').toLowerCase().trim();
  const composition: CoverComposition = (COVER_COMPOSITIONS as readonly string[]).includes(
    rawComposition,
  )
    ? (rawComposition as CoverComposition)
    : 'other';
  return {
    hasFace,
    faceCount: hasFace ? Math.max(1, faceCount) : 0,
    expression: hasFace ? expression : 'none',
    hasTextOverlay,
    textContent,
    dominantColor,
    composition,
  };
}

// -------- Injectable adapters ----------------------------------------------

type ChatTextFn = (payload: ChatTextPayload) => Promise<ChatResult>;
type ChatVisionFn = (payload: ChatVisionPayload) => Promise<ChatResult>;
type GetCachedFn = typeof defaultGetCached;
type PutCachedFn = typeof defaultPutCached;
type FetchFn = typeof fetch;

export interface LlmRouteDeps {
  chatText: ChatTextFn;
  chatVision: ChatVisionFn;
  getCached: GetCachedFn;
  putCached: PutCachedFn;
  fetchImpl: FetchFn;
}

function resolveDeps(partial: Partial<LlmRouteDeps>): LlmRouteDeps {
  return {
    chatText: partial.chatText ?? defaultChatText,
    chatVision: partial.chatVision ?? defaultChatVision,
    getCached: partial.getCached ?? defaultGetCached,
    putCached: partial.putCached ?? defaultPutCached,
    fetchImpl: partial.fetchImpl ?? ((...args) => globalThis.fetch(...args)),
  };
}

// -------- Routes ------------------------------------------------------------

export function buildLlmRoutes(partial: Partial<LlmRouteDeps> = {}): Hono {
  const deps = resolveDeps(partial);
  const app = new Hono();

  // POST /v1/llm/analyze --------------------------------------------------
  app.post('/analyze', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const postId = String(body?.postId ?? '').trim();
    const caption = typeof body?.caption === 'string' ? body.caption : '';
    const transcript = typeof body?.transcript === 'string' ? body.transcript : null;

    if (!postId) return c.json({ error: 'missing-postId' }, 400);

    const hash = analyzeHash(postId, caption);

    // 1) Cache lookup \u2014 hits skip the provider AND the counter.
    const cached = await deps.getCached(hash);
    if (cached) {
      const r = normalizeAnalyzeJson(cached.result);
      return c.json({ ...r, cached: true });
    }

    // 2) Miss \u2014 one Gemini call.
    const messages: ChatMessage[] = [
      { role: 'system', content: ANALYZE_SYSTEM },
      { role: 'user', content: buildAnalyzeUserContent(caption, transcript) },
    ];

    let result: ChatResult;
    try {
      result = await deps.chatText({
        messages,
        schema: ANALYZE_SCHEMA,
        options: { temperature: 0.1 },
        kind: 'analyze',
      });
    } catch (err) {
      log.error({ postId, hash, err: (err as Error).message }, 'gemini analyze failed');
      return c.json({ error: 'llm-failed', message: (err as Error).message }, 502);
    }

    if (!result.json) {
      log.error({ postId, hash }, 'gemini analyze: no JSON');
      return c.json({ error: 'llm-failed', message: 'no-json' }, 502);
    }

    const out = normalizeAnalyzeJson(result.json);

    await deps.putCached({
      hash,
      kind: 'analyze',
      provider: 'gemini',
      model: result.model,
      result: out,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
    });

    // 3) Signal the usageCounter middleware to bump analyze_calls.
    c.set(LLM_CACHE_MISS_KEY, 'analyze_calls');

    return c.json({ ...out, cached: false });
  });

  // POST /v1/llm/cover ----------------------------------------------------
  app.post('/cover', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const postId = String(body?.postId ?? '').trim();
    const coverUrl = String(body?.coverUrl ?? '').trim();

    if (!postId) return c.json({ error: 'missing-postId' }, 400);
    if (!coverUrl) return c.json({ error: 'missing-coverUrl' }, 400);

    const hash = coverHash(coverUrl);

    const cached = await deps.getCached(hash);
    if (cached) {
      const r = normalizeCoverJson(cached.result);
      return c.json({ ...r, cached: true });
    }

    // Server-side fetch \u2014 the extension can't hit IG/TT CDNs cross-origin,
    // and Gemini wants raw base64 bytes anyway.
    let imageB64: string;
    let mimeType = 'image/jpeg';
    try {
      const resp = await deps.fetchImpl(coverUrl, { redirect: 'follow' });
      if (!resp.ok) {
        log.error({ coverUrl, status: resp.status }, 'cover fetch: non-2xx');
        return c.json({ error: 'cover-fetch-failed', status: resp.status }, 502);
      }
      const arrayBuf = await resp.arrayBuffer();
      imageB64 = Buffer.from(arrayBuf).toString('base64');
      const ct = resp.headers.get('content-type') || '';
      const ctTrim = ct.split(';')[0]?.trim();
      if (ctTrim) mimeType = ctTrim;
    } catch (err) {
      log.error({ coverUrl, err: (err as Error).message }, 'cover fetch failed');
      return c.json({ error: 'cover-fetch-failed', message: (err as Error).message }, 502);
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: COVER_SYSTEM },
      { role: 'user', content: 'Classify the cover frame attached to this message.' },
    ];

    let result: ChatResult;
    try {
      result = await deps.chatVision({
        messages,
        schema: COVER_SCHEMA,
        images: [{ mimeType, data: imageB64 }],
        options: { temperature: 0.1 },
        kind: 'cover',
      });
    } catch (err) {
      log.error({ postId, hash, err: (err as Error).message }, 'gemini cover failed');
      return c.json({ error: 'llm-failed', message: (err as Error).message }, 502);
    }

    if (!result.json) {
      log.error({ postId, hash }, 'gemini cover: no JSON');
      return c.json({ error: 'llm-failed', message: 'no-json' }, 502);
    }

    const out = normalizeCoverJson(result.json);

    await deps.putCached({
      hash,
      kind: 'cover',
      provider: 'gemini',
      model: result.model,
      result: out,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
    });

    c.set(LLM_CACHE_MISS_KEY, 'cover_calls');

    return c.json({ ...out, cached: false });
  });

  return app;
}

// Default export wires the production adapters \u2014 Gemini provider + drizzle
// cache + node-fetch.
export default buildLlmRoutes();
