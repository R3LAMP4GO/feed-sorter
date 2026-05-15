// WhisperX sidecar client.
//
// Posts an audio File to `WHISPERX_URL/transcribe` and normalizes the
// response to the same shape the rest of the API consumes
// ({ text, language, duration, segments }).
//
// The sidecar lives at sidecar/transcribe-server.py and runs WhisperX
// (faster-whisper + forced alignment for word-level timestamps).

import { env } from '../env.js';

export interface WhisperWord {
  word: string;
  start: number | null;
  end: number | null;
  score: number | null;
}

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
  words?: WhisperWord[];
}

export interface WhisperXResult {
  text: string;
  language?: string;
  duration?: number;
  segments?: WhisperSegment[];
  engine: 'whisperx';
  model?: string;
  elapsedMs?: number;
}

export function isWhisperXConfigured(): boolean {
  return !!env.WHISPERX_URL;
}

export async function transcribeWithWhisperX(
  file: File,
  opts: { language?: string; align?: boolean } = {},
): Promise<WhisperXResult> {
  if (!env.WHISPERX_URL) throw new Error('WHISPERX_URL not configured');

  const form = new FormData();
  form.append('file', file);
  if (opts.language) form.append('language', opts.language);
  form.append('align', opts.align === false ? '0' : '1');

  const url = env.WHISPERX_URL.replace(/\/+$/, '') + '/transcribe';
  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`whisperx ${res.status}: ${errText}`);
  }
  const json = (await res.json()) as {
    ok?: boolean;
    err?: string;
    text?: string;
    language?: string;
    duration?: number;
    segments?: WhisperSegment[];
    model?: string;
    elapsed_ms?: number;
  };
  if (!json.ok) throw new Error(`whisperx: ${json.err ?? 'unknown'}`);
  return {
    engine: 'whisperx',
    text: json.text ?? '',
    language: json.language,
    duration: json.duration,
    segments: json.segments ?? [],
    model: json.model,
    elapsedMs: json.elapsed_ms,
  };
}
