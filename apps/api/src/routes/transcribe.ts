// /v1/posts/:id/transcribe \u2014 cache-fronted Whisper transcription.
//
// Whisper is the single most expensive call we make against any provider;
// the pricing decision is "no transcription on free tier". Layout:
//
//   1. requireTier('pro') gate (403 free)             \u2014 in `index.ts`
//   2. Hash = sha256(`transcribe:${platform}:${nativeId}`)
//   3. SELECT analyses WHERE hash = ?   \u2192 hit, return cached row
//   4. Quota pre-check                                \u2192 429 if over cap
//   5. Load audio:
//        - multipart `file` field, OR
//        - JSON `{ videoUrl }`         \u2192 server-side fetch
//   6. Try Groq Whisper-large-v3-turbo (if GROQ_API_KEY).
//      On failure OR no key            \u2192 fall back to WhisperX sidecar.
//   7. Persist `{ text, segments, language, durationS, model }` to analyses
//      cache + `transcripts` table (extract worker still reads from there).
//   8. usage_counters.transcribe_seconds += durationS.
//   9. Return the transcription.
//
// Adapters (cache, groq, whisperx, fetch, usage store, db) are injected via
// `buildTranscribeRoutes` so the unit tests stay hermetic. Default export
// wires the production adapters.

import { Hono, type Context } from 'hono';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';

import { db as defaultDb, type Database } from '../db/client.js';
import { posts, transcripts, jobs } from '../db/schema.js';
import {
  getCached as defaultGetCached,
  putCached as defaultPutCached,
} from '../services/cache.js';
import {
  transcribeAudio as defaultTranscribeGroq,
  type TranscriptionResult,
} from '../services/groq.js';
import {
  isWhisperXConfigured as defaultIsWhisperXConfigured,
  transcribeWithWhisperX as defaultTranscribeWhisperX,
} from '../services/whisperx.js';
import {
  TIER_TRANSCRIBE_CAPS,
  transcribePeriodEnd,
  transcribePeriodStart,
  makeDrizzleTranscribeUsageStore,
  type TranscribeUsageStore,
  type Tier,
} from '../services/transcribe-usage.js';
import { parsePostId } from './llm.js';
import { env } from '../env.js';
import { log } from '../log.js';

// -------- Hash ---------------------------------------------------------------

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Cache key for a transcription. Two requests for the same `<platform, nativeId>`
 * share a single cache row across users \u2014 transcription output is
 * deterministic for the same audio.
 */
export function transcribeHash(platform: string, nativeId: string): string {
  return `sha256:${sha256Hex(`transcribe:${platform}:${nativeId}`)}`;
}

// -------- Shared result shape -----------------------------------------------

export interface TranscribeCacheValue {
  text: string;
  language: string | null;
  durationS: number | null;
  segments: unknown;
  model: string | null;
  source: 'groq-whisper' | 'whisperx';
}

function shapeFromGroq(result: TranscriptionResult): TranscribeCacheValue {
  return {
    text: result.text ?? '',
    language: result.language ?? null,
    durationS: typeof result.duration === 'number' ? result.duration : null,
    segments: result.segments ?? null,
    model: 'whisper-large-v3-turbo',
    source: 'groq-whisper',
  };
}

interface WhisperXLike {
  text: string;
  language?: string;
  duration?: number;
  segments?: unknown;
  model?: string;
}

function shapeFromWhisperX(result: WhisperXLike): TranscribeCacheValue {
  return {
    text: result.text ?? '',
    language: result.language ?? null,
    durationS: typeof result.duration === 'number' ? result.duration : null,
    segments: result.segments ?? null,
    model: result.model ?? 'whisperx',
    source: 'whisperx',
  };
}

// -------- Injectable adapters ------------------------------------------------

type GetCachedFn = typeof defaultGetCached;
type PutCachedFn = typeof defaultPutCached;
type FetchFn = typeof fetch;
type TranscribeGroqFn = (file: File) => Promise<TranscriptionResult>;
type TranscribeWhisperXFn = (file: File) => Promise<WhisperXLike>;
type IsWhisperXConfiguredFn = () => boolean;

export interface TranscribeRouteDeps {
  getCached: GetCachedFn;
  putCached: PutCachedFn;
  fetchImpl: FetchFn;
  transcribeGroq: TranscribeGroqFn;
  transcribeWhisperX: TranscribeWhisperXFn;
  isWhisperXConfigured: IsWhisperXConfiguredFn;
  /** Read `process.env.GROQ_API_KEY`. Injectable so tests can flip it. */
  hasGroqKey: () => boolean;
  /** Drizzle handle for transcripts/jobs writes. */
  db: Database;
  /** Per-period whisper-seconds counter store. */
  usageStore: TranscribeUsageStore;
  /** Override `now()` for deterministic tests. */
  now: () => Date;
}

function resolveDeps(partial: Partial<TranscribeRouteDeps>): TranscribeRouteDeps {
  return {
    getCached: partial.getCached ?? defaultGetCached,
    putCached: partial.putCached ?? defaultPutCached,
    fetchImpl: partial.fetchImpl ?? ((...args) => globalThis.fetch(...args)),
    transcribeGroq: partial.transcribeGroq ?? defaultTranscribeGroq,
    transcribeWhisperX: partial.transcribeWhisperX ?? defaultTranscribeWhisperX,
    isWhisperXConfigured: partial.isWhisperXConfigured ?? defaultIsWhisperXConfigured,
    hasGroqKey: partial.hasGroqKey ?? (() => !!env.GROQ_API_KEY),
    db: partial.db ?? defaultDb,
    usageStore: partial.usageStore ?? makeDrizzleTranscribeUsageStore(partial.db ?? defaultDb),
    now: partial.now ?? (() => new Date()),
  };
}

// -------- Audio loading ------------------------------------------------------

const MAX_FETCH_BYTES = 100 * 1024 * 1024; // 100 MB \u2014 hard cap for safety.

async function loadAudio(
  contentType: string,
  c: Context,
  deps: TranscribeRouteDeps,
): Promise<{ file: File } | { error: string; status: 400 | 413 | 415 | 502 }> {
  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return { error: 'missing-file', status: 400 };
    return { file };
  }

  if (contentType.includes('application/json')) {
    const body = await c.req.json().catch(() => ({}));
    const videoUrl = String(body?.videoUrl ?? '').trim();
    if (!videoUrl) return { error: 'missing-videoUrl', status: 400 };

    let resp: Response;
    try {
      resp = await deps.fetchImpl(videoUrl, { redirect: 'follow' });
    } catch (err) {
      log.error({ videoUrl, err: (err as Error).message }, 'transcribe: videoUrl fetch threw');
      return { error: 'fetch-failed', status: 502 };
    }
    if (!resp.ok) {
      log.error({ videoUrl, status: resp.status }, 'transcribe: videoUrl fetch non-2xx');
      return { error: 'fetch-failed', status: 502 };
    }
    const cl = Number(resp.headers.get('content-length') ?? '0');
    if (cl > MAX_FETCH_BYTES) return { error: 'file-too-large', status: 413 };
    const buf = await resp.arrayBuffer();
    if (buf.byteLength > MAX_FETCH_BYTES) return { error: 'file-too-large', status: 413 };
    const mime = resp.headers.get('content-type') ?? 'audio/mpeg';
    const name = videoUrl.split('/').pop()?.split('?')[0] || 'audio';
    const file = new File([buf], name, { type: mime });
    return { file };
  }

  return { error: 'unsupported-content-type', status: 415 };
}

// -------- Provider orchestration --------------------------------------------

async function runTranscription(
  file: File,
  deps: TranscribeRouteDeps,
): Promise<TranscribeCacheValue> {
  const groqAvailable = deps.hasGroqKey();
  const whisperxAvailable = deps.isWhisperXConfigured();

  // 1) Prefer Groq when keyed.
  if (groqAvailable) {
    try {
      const r = await deps.transcribeGroq(file);
      return shapeFromGroq(r);
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'transcribe: groq failed, trying whisperx');
      if (!whisperxAvailable) throw err;
    }
  }

  // 2) WhisperX sidecar fallback (or primary if Groq isn't keyed).
  if (whisperxAvailable) {
    const r = await deps.transcribeWhisperX(file);
    return shapeFromWhisperX(r);
  }

  throw new Error('no transcription provider available');
}

// -------- Route factory ------------------------------------------------------

export function buildTranscribeRoutes(
  partial: Partial<TranscribeRouteDeps> = {},
): Hono {
  const deps = resolveDeps(partial);
  const app = new Hono();

  // POST /:id/transcribe -----------------------------------------------------
  app.post('/:id/transcribe', async (c) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthenticated' }, 401);

    const postId = c.req.param('id');
    if (!postId) return c.json({ error: 'missing-postId' }, 400);

    const { platform, nativeId } = parsePostId(postId);
    if (platform === 'unknown') {
      return c.json({ error: 'invalid-postId' }, 400);
    }

    const hash = transcribeHash(platform, nativeId);

    // 1) Cache lookup \u2014 hits skip both the provider AND the counter bump.
    const cached = await deps.getCached(hash);
    if (cached && cached.result && typeof cached.result === 'object') {
      const value = cached.result as TranscribeCacheValue;
      return c.json({ ...value, postId, cached: true });
    }

    // 2) Quota pre-check.
    const tier = (user.tier ?? 'free') as Tier;
    const cap = TIER_TRANSCRIBE_CAPS[tier] ?? 0;
    const now = deps.now();
    const periodStart = transcribePeriodStart(now);
    const periodEnd = transcribePeriodEnd(now);
    const usedSeconds = await deps.usageStore.getSeconds(user.sub, periodStart);
    if (usedSeconds >= cap) {
      return c.json(
        {
          error: 'quota-exceeded',
          kind: 'transcribe_seconds',
          used: usedSeconds,
          cap,
          resetAt: periodEnd.toISOString(),
        },
        429,
      );
    }

    // 3) Confirm the post exists \u2014 the cache hash is content-addressed but
    //    we still write to `transcripts` (FK to posts), so a missing post
    //    would explode there. Surface a clean 404 here instead.
    const [postRow] = await deps.db
      .select({ id: posts.id })
      .from(posts)
      .where(eq(posts.id, postId))
      .limit(1);
    if (!postRow) return c.json({ error: 'unknown-post' }, 404);

    // 4) Load audio (multipart or JSON videoUrl).
    const contentType = c.req.header('content-type') ?? '';
    const audio = await loadAudio(contentType, c, deps);
    if ('error' in audio) {
      return c.json({ error: audio.error }, audio.status);
    }

    // 5) Transcribe (groq \u2192 whisperx fallback).
    let value: TranscribeCacheValue;
    try {
      value = await runTranscription(audio.file, deps);
    } catch (err) {
      log.error({ postId, err: (err as Error).message }, 'transcribe failed');
      return c.json(
        { error: 'transcribe-failed', message: (err as Error).message },
        502,
      );
    }

    // 6) Persist to analyses cache (source of truth for the route response).
    await deps.putCached({
      hash,
      kind: 'transcribe',
      provider: value.source,
      model: value.model,
      result: value,
    });

    // 7) Mirror into `transcripts` for the extract worker, which reads from
    //    there. Best-effort \u2014 cache write above is the canonical record.
    try {
      await deps.db
        .insert(transcripts)
        .values({
          postId,
          fullText: value.text,
          language: value.language,
          source: value.source,
          segments: value.segments as object | null,
          durationS: value.durationS,
        })
        .onConflictDoUpdate({
          target: transcripts.postId,
          set: {
            fullText: value.text,
            language: value.language,
            source: value.source,
            segments: value.segments as object | null,
            durationS: value.durationS,
          },
        });
      await deps.db.insert(jobs).values({ kind: 'extract', payload: { postId } });
    } catch (err) {
      log.warn(
        { postId, err: (err as Error).message },
        'transcribe: transcripts/jobs write failed (cache still authoritative)',
      );
    }

    // 8) Bump the per-period whisper-seconds counter.
    const billed = value.durationS && value.durationS > 0 ? value.durationS : 0;
    if (billed > 0) {
      await deps.usageStore.addSeconds(user.sub, periodStart, billed);
    }

    return c.json({ ...value, postId, cached: false });
  });

  return app;
}

// Default export wires production adapters (drizzle cache + groq + whisperx).
export default buildTranscribeRoutes();
