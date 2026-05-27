// Unit tests for POST /v1/posts/:id/transcribe.
//
// Mounts the route against fully in-memory fakes (cache, usage store,
// transcripts/jobs db, groq + whisperx stubs, image fetcher) so the suite
// stays hermetic. Mirrors the patterns in:
//   - tests/unit/llm-routes.test.ts (Hono app + injectable deps)
//   - tests/unit/cache.test.ts      (storage seam fakes)
//   - tests/unit/middleware.test.ts (user injection via setup middleware)

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// env.ts reads DATABASE_URL / JWT_SECRET lazily, but `db/client.ts` and
// `services/cache.ts` resolve them at module-load time. Stub before any
// import that pulls those in. `vi.hoisted` lifts above ESM's import hoist.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://stub:stub@127.0.0.1:5432/stub';
  process.env.JWT_SECRET ??= 'stub-secret-32-chars-1234567890ab';
  process.env.NODE_ENV = 'test';
});

import { buildTranscribeRoutes, transcribeHash } from '../../src/routes/transcribe.js';
import { requireTier } from '../../src/middleware/require-tier.js';
import {
  TIER_TRANSCRIBE_CAPS,
  transcribePeriodStart,
  type TranscribeUsageStore,
} from '../../src/services/transcribe-usage.js';
import type { CachedAnalysis, PutCachedInput } from '../../src/services/cache.js';
import type { TranscriptionResult } from '../../src/services/groq.js';

// -------- Fakes ------------------------------------------------------------

interface FakeCache {
  rows: Map<string, CachedAnalysis>;
  calls: { get: number; put: number };
  getCached: (hash: string) => Promise<CachedAnalysis | null>;
  putCached: (input: PutCachedInput) => Promise<void>;
}

function makeFakeCache(): FakeCache {
  const rows = new Map<string, CachedAnalysis>();
  const calls = { get: 0, put: 0 };
  return {
    rows,
    calls,
    async getCached(hash) {
      calls.get += 1;
      const r = rows.get(hash);
      return r ? { ...r } : null;
    },
    async putCached(input) {
      calls.put += 1;
      rows.set(input.hash, {
        hash: input.hash,
        kind: input.kind,
        provider: input.provider ?? null,
        model: input.model ?? null,
        result: input.result,
        tokensIn: input.tokensIn ?? null,
        tokensOut: input.tokensOut ?? null,
        createdAt: new Date(),
        hitCount: 0,
        lastHitAt: null,
      });
    },
  };
}

interface FakeUsageStore extends TranscribeUsageStore {
  rows: Map<string, number>;
  calls: { get: number; add: number };
  seed: (userId: string, seconds: number) => void;
}

function makeFakeUsageStore(): FakeUsageStore {
  const rows = new Map<string, number>();
  const calls = { get: 0, add: 0 };
  const keyOf = (uid: string, start: Date) => `${uid}|${start.toISOString()}`;
  return {
    rows,
    calls,
    seed(userId, seconds) {
      rows.set(keyOf(userId, transcribePeriodStart()), seconds);
    },
    async getSeconds(userId, start) {
      calls.get += 1;
      return rows.get(keyOf(userId, start)) ?? 0;
    },
    async addSeconds(userId, start, seconds) {
      calls.add += 1;
      const k = keyOf(userId, start);
      rows.set(k, (rows.get(k) ?? 0) + seconds);
    },
  };
}

// Fake drizzle handle. We only need `select().from(posts).where(...).limit(1)`
// and `insert(table).values(...).onConflictDoUpdate(...)` chains to succeed.
// Each method returns a thenable so the route can `await` it.
function makeFakeDb(opts: { postExists?: boolean } = {}): { db: unknown; calls: { insertTranscripts: number; insertJobs: number } } {
  const postExists = opts.postExists ?? true;
  const calls = { insertTranscripts: 0, insertJobs: 0 };

  const selectChain = () => ({
    from: () => ({
      where: () => ({
        limit: async () => (postExists ? [{ id: 'ig_abc123' }] : []),
      }),
    }),
  });

  const insertChain = (kind: 'transcripts' | 'jobs') => ({
    values: (_v: unknown) => {
      if (kind === 'transcripts') calls.insertTranscripts += 1;
      else calls.insertJobs += 1;
      // Allow chaining `.onConflictDoUpdate(...)` or terminating with `await`.
      const thenable = {
        onConflictDoUpdate: (_arg: unknown) => Promise.resolve(),
        then: (resolve: (v: unknown) => void) => resolve(undefined),
      };
      return thenable;
    },
  });

  const db = {
    select: () => selectChain(),
    insert: (table: { _: { name?: string } } | unknown) => {
      // Drizzle table objects don't expose a name reliably in our fake; we use
      // the call order: the route does transcripts FIRST then jobs.
      const which = calls.insertTranscripts === calls.insertJobs ? 'transcripts' : 'jobs';
      void table;
      return insertChain(which);
    },
  };

  return { db, calls };
}

function stubGroqResult(overrides: Partial<TranscriptionResult> = {}): TranscriptionResult {
  return {
    text: 'hello from groq',
    language: 'en',
    duration: 12.5,
    segments: [{ id: 0, start: 0, end: 12.5, text: 'hello from groq' }],
    ...overrides,
  };
}

function makeImageFetchStub(bytes: Uint8Array = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])) {
  return vi.fn(async () =>
    new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'audio/mp4', 'content-length': String(bytes.length) },
    }),
  );
}

// -------- App builder ------------------------------------------------------

type Tier = 'free' | 'pro' | 'studio';

interface MakeAppOpts {
  user: { sub: string; email: string; tier: Tier } | null;
  cache?: FakeCache;
  usageStore?: FakeUsageStore;
  groq?: ReturnType<typeof vi.fn>;
  whisperx?: ReturnType<typeof vi.fn>;
  isWhisperXConfigured?: () => boolean;
  hasGroqKey?: () => boolean;
  fetchImpl?: ReturnType<typeof vi.fn>;
  db?: unknown;
}

function makeApp(opts: MakeAppOpts): {
  app: Hono;
  cache: FakeCache;
  usageStore: FakeUsageStore;
} {
  const cache = opts.cache ?? makeFakeCache();
  const usageStore = opts.usageStore ?? makeFakeUsageStore();
  const groq = opts.groq ?? vi.fn(async () => stubGroqResult());
  const whisperx = opts.whisperx ?? vi.fn(async () => ({ text: '', duration: 0 }));
  const isWhisperXConfigured = opts.isWhisperXConfigured ?? (() => false);
  const hasGroqKey = opts.hasGroqKey ?? (() => true);
  const fetchImpl = opts.fetchImpl ?? makeImageFetchStub();
  const db = opts.db ?? makeFakeDb().db;

  const app = new Hono();
  app.use('*', async (c, next) => {
    if (opts.user) c.set('user' as never, opts.user as never);
    await next();
  });
  // Mirror the production middleware chain: require-tier first (the route
  // itself never sees a free user), then the handler.
  app.use('/posts/:id/transcribe', requireTier('pro'));
  app.route(
    '/posts',
    buildTranscribeRoutes({
      getCached: cache.getCached,
      putCached: cache.putCached,
      transcribeGroq: groq as never,
      transcribeWhisperX: whisperx as never,
      isWhisperXConfigured,
      hasGroqKey,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      db: db as never,
      usageStore,
    }),
  );

  return { app, cache, usageStore };
}

const PRO_USER = { sub: 'user-pro', email: 'pro@example.com', tier: 'pro' as const };
const STUDIO_USER = { sub: 'user-studio', email: 'studio@example.com', tier: 'studio' as const };
const FREE_USER = { sub: 'user-free', email: 'free@example.com', tier: 'free' as const };

const POST_ID = 'ig_abc123';

// Multipart helper \u2014 a tiny WAV-ish blob is fine; the route never inspects
// bytes, only forwards to the (stubbed) provider.
function multipartBody(): { body: FormData; type: undefined } {
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array([1, 2, 3, 4])], 'clip.mp3', { type: 'audio/mpeg' }));
  // Returning the FormData lets fetch set the correct multipart boundary.
  return { body: fd, type: undefined };
}

function jsonBody(payload: unknown): { body: string; type: string } {
  return { body: JSON.stringify(payload), type: 'application/json' };
}

// -------- Tests ------------------------------------------------------------

describe('POST /v1/posts/:id/transcribe', () => {
  beforeEach(() => {
    process.env.DEV_FORCE_TIER = undefined;
    process.env.NODE_ENV = 'test';
  });

  // ===== Tier gate ========================================================

  describe('tier gate', () => {
    it('returns 403 tier-required for free users \u2014 Whisper never runs', async () => {
      const groq = vi.fn(async () => stubGroqResult());
      const { app, usageStore } = makeApp({ user: FREE_USER, groq });

      const mp = multipartBody();
      const res = await app.request(`/posts/${POST_ID}/transcribe`, {
        method: 'POST',
        body: mp.body,
      });

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; minTier: string };
      expect(body.error).toBe('tier-required');
      expect(body.minTier).toBe('pro');

      // Free users must never advance to the provider or the counter.
      expect(groq).not.toHaveBeenCalled();
      expect(usageStore.calls.add).toBe(0);
    });

    it('pro user passes through the gate', async () => {
      const groq = vi.fn(async () => stubGroqResult({ duration: 5 }));
      const { app } = makeApp({ user: PRO_USER, groq });

      const mp = multipartBody();
      const res = await app.request(`/posts/${POST_ID}/transcribe`, {
        method: 'POST',
        body: mp.body,
      });
      expect(res.status).toBe(200);
      expect(groq).toHaveBeenCalledTimes(1);
    });

    it('returns 401 with no user', async () => {
      const { app } = makeApp({ user: null });
      const mp = multipartBody();
      const res = await app.request(`/posts/${POST_ID}/transcribe`, {
        method: 'POST',
        body: mp.body,
      });
      expect(res.status).toBe(401);
    });
  });

  // ===== Cache hit / miss =================================================

  describe('cache', () => {
    it('cache miss \u2192 calls groq, persists, increments counter by durationS', async () => {
      const groq = vi.fn(async () => stubGroqResult({ duration: 12.5 }));
      const { app, cache, usageStore } = makeApp({ user: PRO_USER, groq });

      const mp = multipartBody();
      const res = await app.request(`/posts/${POST_ID}/transcribe`, {
        method: 'POST',
        body: mp.body,
      });
      expect(res.status).toBe(200);

      const body = (await res.json()) as {
        text: string;
        language: string;
        durationS: number;
        model: string;
        source: string;
        cached: boolean;
        postId: string;
      };
      expect(body).toMatchObject({
        text: 'hello from groq',
        language: 'en',
        durationS: 12.5,
        source: 'groq-whisper',
        model: 'whisper-large-v3-turbo',
        cached: false,
        postId: POST_ID,
      });

      // Cached under the deterministic platform/nativeId hash.
      const hash = transcribeHash('instagram', 'abc123');
      expect(cache.rows.has(hash)).toBe(true);
      expect(cache.rows.get(hash)?.kind).toBe('transcribe');
      expect(cache.rows.get(hash)?.provider).toBe('groq-whisper');

      // Usage bumped by exactly the reported durationS.
      const used = await usageStore.getSeconds(PRO_USER.sub, transcribePeriodStart());
      expect(used).toBe(12.5);
      expect(usageStore.calls.add).toBe(1);
    });

    it('cache hit \u2192 returns cached:true WITHOUT calling provider or bumping counter', async () => {
      const groq = vi.fn(async () => stubGroqResult({ duration: 7 }));
      const { app, cache, usageStore } = makeApp({ user: PRO_USER, groq });

      // 1st call: miss \u2192 fills cache, bumps counter by 7.
      const mp1 = multipartBody();
      const first = await app.request(`/posts/${POST_ID}/transcribe`, {
        method: 'POST',
        body: mp1.body,
      });
      expect(first.status).toBe(200);
      expect(((await first.json()) as { cached: boolean }).cached).toBe(false);
      expect(groq).toHaveBeenCalledTimes(1);
      expect(usageStore.calls.add).toBe(1);

      // 2nd call: hit \u2014 same postId hashes identically.
      const mp2 = multipartBody();
      const second = await app.request(`/posts/${POST_ID}/transcribe`, {
        method: 'POST',
        body: mp2.body,
      });
      expect(second.status).toBe(200);
      const body = (await second.json()) as Record<string, unknown>;
      expect(body.cached).toBe(true);
      expect(body.text).toBe('hello from groq');

      // Provider untouched on the second call; counter unchanged.
      expect(groq).toHaveBeenCalledTimes(1);
      expect(usageStore.calls.add).toBe(1);
      const used = await usageStore.getSeconds(PRO_USER.sub, transcribePeriodStart());
      expect(used).toBe(7);
      expect(cache.calls.put).toBe(1);
    });

    it('hashes by platform+nativeId, not raw postId', async () => {
      // ig_abc123 \u2192 platform=instagram nativeId=abc123 \u2192 sha256(transcribe:instagram:abc123)
      const hash = transcribeHash('instagram', 'abc123');
      expect(hash.startsWith('sha256:')).toBe(true);

      // A different postId with the same native id (cross-platform) hashes differently.
      const other = transcribeHash('tiktok', 'abc123');
      expect(other).not.toBe(hash);
    });

    it('rejects invalid postId with 400 (no provider call)', async () => {
      const groq = vi.fn(async () => stubGroqResult());
      const { app, usageStore } = makeApp({ user: PRO_USER, groq });

      const mp = multipartBody();
      const res = await app.request("/posts/not-a-namespaced-id/transcribe", {
        method: 'POST',
        body: mp.body,
      });
      expect(res.status).toBe(400);
      expect(groq).not.toHaveBeenCalled();
      expect(usageStore.calls.add).toBe(0);
    });
  });

  // ===== Provider fallback ================================================

  describe('provider fallback', () => {
    it('falls back to WhisperX when Groq throws', async () => {
      const groq = vi.fn(async () => {
        throw new Error('groq is down');
      });
      const whisperx = vi.fn(async () => ({
        text: 'hello from whisperx',
        language: 'en',
        duration: 9.25,
        segments: [],
        model: 'whisperx-large-v2',
      }));
      const { app, usageStore } = makeApp({
        user: PRO_USER,
        groq,
        whisperx,
        isWhisperXConfigured: () => true,
      });

      const mp = multipartBody();
      const res = await app.request(`/posts/${POST_ID}/transcribe`, {
        method: 'POST',
        body: mp.body,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        text: string;
        source: string;
        durationS: number;
        model: string;
      };
      expect(body).toMatchObject({
        text: 'hello from whisperx',
        source: 'whisperx',
        durationS: 9.25,
        model: 'whisperx-large-v2',
      });

      expect(groq).toHaveBeenCalledTimes(1);
      expect(whisperx).toHaveBeenCalledTimes(1);
      const used = await usageStore.getSeconds(PRO_USER.sub, transcribePeriodStart());
      expect(used).toBe(9.25);
    });

    it('uses WhisperX directly when GROQ_API_KEY is unset', async () => {
      const groq = vi.fn(async () => stubGroqResult());
      const whisperx = vi.fn(async () => ({
        text: 'sidecar said hi',
        language: 'en',
        duration: 3,
        segments: [],
      }));
      const { app } = makeApp({
        user: PRO_USER,
        groq,
        whisperx,
        isWhisperXConfigured: () => true,
        hasGroqKey: () => false,
      });

      const mp = multipartBody();
      const res = await app.request(`/posts/${POST_ID}/transcribe`, {
        method: 'POST',
        body: mp.body,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { source: string; text: string };
      expect(body.source).toBe('whisperx');
      expect(body.text).toBe('sidecar said hi');
      expect(groq).not.toHaveBeenCalled();
      expect(whisperx).toHaveBeenCalledTimes(1);
    });

    it('502s when neither provider is available', async () => {
      const groq = vi.fn(async () => stubGroqResult());
      const { app, usageStore, cache } = makeApp({
        user: PRO_USER,
        groq,
        isWhisperXConfigured: () => false,
        hasGroqKey: () => false,
      });

      const mp = multipartBody();
      const res = await app.request(`/posts/${POST_ID}/transcribe`, {
        method: 'POST',
        body: mp.body,
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('transcribe-failed');

      // Nothing persisted, nothing counted.
      expect(cache.calls.put).toBe(0);
      expect(usageStore.calls.add).toBe(0);
    });
  });

  // ===== Server-side videoUrl fetch =======================================

  describe('videoUrl mode', () => {
    it('fetches the URL server-side and forwards bytes to groq', async () => {
      const groq = vi.fn(async () => stubGroqResult({ duration: 4 }));
      const fetchImpl = makeImageFetchStub(new Uint8Array([0xff, 0xfb, 0x90, 0x44]));
      const { app, usageStore } = makeApp({ user: PRO_USER, groq, fetchImpl });

      const j = jsonBody({ videoUrl: 'https://cdn.example.com/clip.mp4' });
      const res = await app.request(`/posts/${POST_ID}/transcribe`, {
        method: 'POST',
        headers: { 'content-type': j.type },
        body: j.body,
      });
      expect(res.status).toBe(200);
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://cdn.example.com/clip.mp4',
        expect.objectContaining({ redirect: 'follow' }),
      );
      expect(groq).toHaveBeenCalledTimes(1);
      const fileArg = groq.mock.calls[0][0] as File;
      expect(fileArg).toBeInstanceOf(File);

      const used = await usageStore.getSeconds(PRO_USER.sub, transcribePeriodStart());
      expect(used).toBe(4);
    });

    it('502s when the videoUrl fetch returns non-2xx \u2014 no provider call, no counter bump', async () => {
      const groq = vi.fn(async () => stubGroqResult());
      const fetchImpl = vi.fn(async () => new Response('', { status: 404 }));
      const { app, usageStore, cache } = makeApp({ user: PRO_USER, groq, fetchImpl });

      const j = jsonBody({ videoUrl: 'https://cdn.example.com/missing.mp4' });
      const res = await app.request(`/posts/${POST_ID}/transcribe`, {
        method: 'POST',
        headers: { 'content-type': j.type },
        body: j.body,
      });
      expect(res.status).toBe(502);
      expect(groq).not.toHaveBeenCalled();
      expect(usageStore.calls.add).toBe(0);
      expect(cache.calls.put).toBe(0);
    });

    it('rejects empty videoUrl with 400', async () => {
      const groq = vi.fn(async () => stubGroqResult());
      const { app } = makeApp({ user: PRO_USER, groq });

      const j = jsonBody({ videoUrl: '' });
      const res = await app.request(`/posts/${POST_ID}/transcribe`, {
        method: 'POST',
        headers: { 'content-type': j.type },
        body: j.body,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('missing-videoUrl');
      expect(groq).not.toHaveBeenCalled();
    });

    it('415s on unsupported content-type', async () => {
      const groq = vi.fn(async () => stubGroqResult());
      const { app } = makeApp({ user: PRO_USER, groq });

      const res = await app.request(`/posts/${POST_ID}/transcribe`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'plain text body',
      });
      expect(res.status).toBe(415);
      expect(groq).not.toHaveBeenCalled();
    });
  });

  // ===== Quota enforcement ================================================

  describe('quota cap', () => {
    it('429s when pro user is already at the 7200s/mo cap', async () => {
      const usageStore = makeFakeUsageStore();
      usageStore.seed(PRO_USER.sub, TIER_TRANSCRIBE_CAPS.pro);
      const groq = vi.fn(async () => stubGroqResult({ duration: 30 }));
      const { app, cache } = makeApp({ user: PRO_USER, groq, usageStore });

      const mp = multipartBody();
      const res = await app.request(`/posts/${POST_ID}/transcribe`, {
        method: 'POST',
        body: mp.body,
      });
      expect(res.status).toBe(429);
      const body = (await res.json()) as {
        error: string;
        kind: string;
        used: number;
        cap: number;
        resetAt: string;
      };
      expect(body.error).toBe('quota-exceeded');
      expect(body.kind).toBe('transcribe_seconds');
      expect(body.cap).toBe(7200);
      expect(body.used).toBe(7200);
      expect(Number.isNaN(Date.parse(body.resetAt))).toBe(false);

      // Nothing got billed.
      expect(groq).not.toHaveBeenCalled();
      expect(usageStore.calls.add).toBe(0);
      expect(cache.calls.put).toBe(0);
    });

    it('429s for pro user once they cross 7200s mid-period', async () => {
      const usageStore = makeFakeUsageStore();
      // Right at the cap \u2014 next call should reject.
      usageStore.seed(PRO_USER.sub, 7200);
      const groq = vi.fn(async () => stubGroqResult({ duration: 1 }));
      const { app } = makeApp({ user: PRO_USER, groq, usageStore });

      const mp = multipartBody();
      const res = await app.request(`/posts/${POST_ID}/transcribe`, {
        method: 'POST',
        body: mp.body,
      });
      expect(res.status).toBe(429);
      expect(groq).not.toHaveBeenCalled();
    });

    it('studio cap is 72000s (10x pro) and lets a studio user past the pro line', async () => {
      expect(TIER_TRANSCRIBE_CAPS.studio).toBe(72_000);
      expect(TIER_TRANSCRIBE_CAPS.pro).toBe(7_200);
      expect(TIER_TRANSCRIBE_CAPS.free).toBe(0);

      const usageStore = makeFakeUsageStore();
      // Studio user has used 10000s \u2014 way over pro's cap, well under studio's.
      usageStore.seed(STUDIO_USER.sub, 10_000);
      const groq = vi.fn(async () => stubGroqResult({ duration: 60 }));
      const { app } = makeApp({ user: STUDIO_USER, groq, usageStore });

      const mp = multipartBody();
      const res = await app.request(`/posts/${POST_ID}/transcribe`, {
        method: 'POST',
        body: mp.body,
      });
      expect(res.status).toBe(200);
      const used = await usageStore.getSeconds(STUDIO_USER.sub, transcribePeriodStart());
      expect(used).toBe(10_060);
    });

    it('429s the studio user at 72000s', async () => {
      const usageStore = makeFakeUsageStore();
      usageStore.seed(STUDIO_USER.sub, TIER_TRANSCRIBE_CAPS.studio);
      const groq = vi.fn(async () => stubGroqResult({ duration: 1 }));
      const { app } = makeApp({ user: STUDIO_USER, groq, usageStore });

      const mp = multipartBody();
      const res = await app.request(`/posts/${POST_ID}/transcribe`, {
        method: 'POST',
        body: mp.body,
      });
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: string; cap: number };
      expect(body.error).toBe('quota-exceeded');
      expect(body.cap).toBe(72_000);
      expect(groq).not.toHaveBeenCalled();
    });

    it('does not bump the counter when groq returns no duration', async () => {
      const usageStore = makeFakeUsageStore();
      const groq = vi.fn(async () => ({ text: 'no-duration', language: 'en' } as TranscriptionResult));
      const { app } = makeApp({ user: PRO_USER, groq, usageStore });

      const mp = multipartBody();
      const res = await app.request(`/posts/${POST_ID}/transcribe`, {
        method: 'POST',
        body: mp.body,
      });
      expect(res.status).toBe(200);
      expect(usageStore.calls.add).toBe(0);
      const used = await usageStore.getSeconds(PRO_USER.sub, transcribePeriodStart());
      expect(used).toBe(0);
    });
  });
});
