// Groq API wrappers — Whisper transcription + Llama JSON extraction.
// Endpoint shapes mirror `claraverse-space/ClaraVerse` `service.go`:
//   POST https://api.groq.com/openai/v1/audio/transcriptions, multipart `file`.

import { env } from '../env.js';

const GROQ_BASE = 'https://api.groq.com/openai/v1';

const TRANSCRIBE_MODEL = 'whisper-large-v3-turbo';
const CHAT_MODEL = 'llama-3.3-70b-versatile';
const VISION_MODEL = 'llama-3.2-11b-vision-preview';

export interface TranscriptionResult {
  text: string;
  language?: string;
  duration?: number;
  segments?: Array<{ id: number; start: number; end: number; text: string }>;
}

function authHeaders(): HeadersInit {
  if (!env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured');
  return { authorization: `Bearer ${env.GROQ_API_KEY}` };
}

export async function transcribeAudio(file: File): Promise<TranscriptionResult> {
  const form = new FormData();
  form.append('file', file);
  form.append('model', TRANSCRIBE_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');

  const res = await fetch(`${GROQ_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`groq transcribe ${res.status}: ${errText}`);
  }
  const json = (await res.json()) as TranscriptionResult;
  return json;
}

// JSON-mode chat completion. Returns parsed JSON object.
export async function chatJson(opts: {
  system: string;
  user: string;
  model?: string;
  maxTokens?: number;
}): Promise<unknown> {
  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({
      model: opts.model ?? CHAT_MODEL,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: opts.maxTokens ?? 1024,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`groq chat ${res.status}: ${errText}`);
  }
  const json = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const content = json.choices?.[0]?.message?.content ?? '';
  return JSON.parse(content);
}

// Vision chat: Llama-3.2-vision over image URL + prompt → free-form text.
export async function chatVision(opts: {
  system: string;
  user: string;
  imageUrl: string;
  maxTokens?: number;
}): Promise<string> {
  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [
        { role: 'system', content: opts.system },
        {
          role: 'user',
          content: [
            { type: 'text', text: opts.user },
            { type: 'image_url', image_url: { url: opts.imageUrl } },
          ],
        },
      ],
      temperature: 0.2,
      max_tokens: opts.maxTokens ?? 256,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`groq vision ${res.status}: ${errText}`);
  }
  const json = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  return json.choices?.[0]?.message?.content ?? '';
}
