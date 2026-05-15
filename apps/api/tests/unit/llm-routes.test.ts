// Unit tests for /v1/llm/* routes.
//
// We mount the routes against in-memory fakes of every external surface
// (Gemini chat, Gemini vision, cache store, usage store, cover-image fetch)
// so the suite stays hermetic \u2014 no Postgres, no network. The full middleware
// chain (`requireTier('pro')` + `usageCounter`) is mounted as in production
// so cache-hit / cache-miss accounting is exercised end-to-end.
//
// Pattern follows `tests/unit/cache.test.ts` (storage seam fakes) and
// `tests/unit/middleware.test.ts` (user injection via setup middleware).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// env.ts reads DATABASE_URL / JWT_SECRET lazily, but `db/client.ts` and
// `services/cache.ts` resolve them at module-load time. Stub before any
// import that pulls those in. `vi.hoisted` lifts above ESM's import hoist.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://stub:stub@127.0.0.1:5432/stub';
  process.env.JWT_SECRET ??= 'stub-secret-32-chars-1234567890ab';
  process.env.NODE_ENV = 'test';
  process.env.GEMINI_API_KEY = 'test-key';
});

import { buildLlmRoutes, type LlmRouteDeps } from '../../src/routes/llm.js';
import { requireTier } from '../../src/middleware/require-tier.js';
import {
  usageCounter,
  llmPeriodStart,
  TIER_LLM_CAPS,
  type LlmCounterKey,
  type LlmUsageCounts,
  type LlmUsageStore,
} from '../../src/middleware/usage-counter.js';
import type { ChatResult } from '../../src/providers/gemini.js';
import type { CachedAnalysis, PutCachedInput } from '../../src/services/cache.js';

// -------- Fakes ------------------------------------------------------------

interface FakeUsageStore extends LlmUsageStore {
  rows: Map<string, LlmUsageCounts>;
  calls: { get: number; inc: number };
  seed: (userId: string, counts: Partial<LlmUsageCounts>) => void;
}

function makeFakeUsageStore(): FakeUsageStore {
  const rows = new Map<string, LlmUsageCounts>();
  const calls = { get: 0, inc: 0 };
  const keyOf = (uid: string, start: Date) => `${uid}|${start.toISOString()}`;
  return {
    rows,
    calls,
    seed(userId, counts) {
      const start = llmPeriodStart();
      rows.set(keyOf(userId, start), {
        analyze_calls: counts.analyze_calls ?? 0,
        cover_calls: counts.cover_calls ?? 0,
      });
    },
    async getCounters(userId, start) {
      calls.get += 1;
      const row = rows.get(keyOf(userId, start));
      return row ? { ...row } : { analyze_calls: 0, cover_calls: 0 };
    },
    async increment(userId, start, key) {
      calls.inc += 1;
      const k = keyOf(userId, start);
      const row = rows.get(k) ?? { analyze_calls: 0, cover_calls: 0 };
      row[key] += 1;
      rows.set(k, row);
    },
  };
}

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

function stubChatResult(json: unknown): ChatResult {
  return {
    text: JSON.stringify(json),
    json,
    tokensIn: 42,
    tokensOut: 18,
    model: 'gemini-1.5-flash',
    durationMs: 12,
  };
}

function makeChatStub(json: unknown) {
  return vi.fn(async () => stubChatResult(json));
}

function makeImageFetchStub(bytes: Uint8Array = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])) {
  return vi.fn(async () =>
    new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    }),
  );
}

// -------- App builder ------------------------------------------------------

type Tier = 'free' | 'pro' | 'studio';

function makeApp({
  user,
  store,
  deps,
}: {
  user: { sub: string; email: string; tier: Tier } | null;
  store: LlmUsageStore;
  deps: Partial<LlmRouteDeps>;
}): Hono {
  const app = new Hono();
  // Inject user (skipping real JWT verification) \u2014 same pattern as
  // tests/unit/middleware.test.ts.
  app.use('*', async (c, next) => {
    if (user) c.set('user' as never, user as never);
    await next();
  });
  app.use('/llm/*', requireTier('pro'), usageCounter({ store }));
  app.route('/llm', buildLlmRoutes(deps));
  return app;
}

const PRO_USER = { sub: 'user-pro', email: 'pro@example.com', tier: 'pro' as const };
const FREE_USER = { sub: 'user-free', email: 'free@example.com', tier: 'free' as const };

const SAMPLE_ANALYZE_BODY = JSON.stringify({
  postId: 'ig_abc123',
  caption: 'Most people get protein wrong. Here is why.',
});
const SAMPLE_ANALYZE_JSON = {
  hook: 'Most people get protein wrong',
  hookType: 'contrarian',
  topic: 'protein',
  angle: 'myth-busting',
};

const SAMPLE_COVER_BODY = JSON.stringify({
  postId: 'ig_abc123',
  coverUrl: 'https://cdn.example.com/cover.jpg',
});
const SAMPLE_COVER_JSON = {
  hasFace: true,
  faceCount: 1,
  expression: 'serious',
  hasTextOverlay: true,
  textContent: 'PROTEIN MYTHS',
  dominantColor: 'navy',
  composition: 'closeup',
};

// -------- Tests ------------------------------------------------------------

describe('llm routes', () => {
  beforeEach(() => {
    delete process.env.DEV_FORCE_TIER;
    process.env.NODE_ENV = 'test';
  });

  // ===== /llm/analyze =====================================================

  describe('POST /v1/llm/analyze', () => {
    it('returns the Gemini schema shape on cache miss', async () => {
      const store = makeFakeUsageStore();
      const cache = makeFakeCache();
      const chat = makeChatStub(SAMPLE_ANALYZE_JSON);
      const app = makeApp({
        user: PRO_USER,
        store,
        deps: { chatText: chat, getCached: cache.getCached, putCached: cache.putCached },
      });

      const res = await app.request('/llm/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_ANALYZE_BODY,
      });

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        hook: 'Most people get protein wrong',
        hookType: 'contrarian',
        topic: 'protein',
        angle: 'myth-busting',
        cached: false,
      });
      // One Gemini round-trip (combined schema), not two.
      expect(chat).toHaveBeenCalledTimes(1);
      const args = chat.mock.calls[0][0] as { schema: { required: string[] } };
      expect(args.schema.required).toEqual(
        expect.arrayContaining(['hook', 'hookType', 'topic', 'angle']),
      );
    });

    it('increments analyze_calls on cache miss', async () => {
      const store = makeFakeUsageStore();
      const cache = makeFakeCache();
      const chat = makeChatStub(SAMPLE_ANALYZE_JSON);
      const app = makeApp({
        user: PRO_USER,
        store,
        deps: { chatText: chat, getCached: cache.getCached, putCached: cache.putCached },
      });

      const res = await app.request('/llm/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_ANALYZE_BODY,
      });
      expect(res.status).toBe(200);

      const counts = await store.getCounters(PRO_USER.sub, llmPeriodStart());
      expect(counts.analyze_calls).toBe(1);
      expect(counts.cover_calls).toBe(0);
      expect(cache.calls.put).toBe(1);
      expect(store.calls.inc).toBe(1);
    });

    it('cache hit returns cached:true WITHOUT calling Gemini or incrementing counter', async () => {
      const store = makeFakeUsageStore();
      const cache = makeFakeCache();
      const chat = makeChatStub(SAMPLE_ANALYZE_JSON);
      const app = makeApp({
        user: PRO_USER,
        store,
        deps: { chatText: chat, getCached: cache.getCached, putCached: cache.putCached },
      });

      // First call \u2014 populates cache + increments counter.
      const first = await app.request('/llm/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_ANALYZE_BODY,
      });
      expect(first.status).toBe(200);
      expect(((await first.json()) as { cached: boolean }).cached).toBe(false);
      expect(chat).toHaveBeenCalledTimes(1);
      expect(store.calls.inc).toBe(1);

      // Second identical call \u2014 cache hit.
      const second = await app.request('/llm/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_ANALYZE_BODY,
      });
      expect(second.status).toBe(200);
      const body = (await second.json()) as Record<string, unknown>;
      expect(body.cached).toBe(true);
      expect(body.hook).toBe('Most people get protein wrong');
      expect(body.topic).toBe('protein');

      // Gemini still 1 \u2014 cache hit skipped the call.
      expect(chat).toHaveBeenCalledTimes(1);
      // Counter still 1 \u2014 cache hits are free.
      expect(store.calls.inc).toBe(1);
      const counts = await store.getCounters(PRO_USER.sub, llmPeriodStart());
      expect(counts.analyze_calls).toBe(1);
    });

    it('returns 403 tier-required for free users', async () => {
      const store = makeFakeUsageStore();
      const cache = makeFakeCache();
      const chat = makeChatStub(SAMPLE_ANALYZE_JSON);
      const app = makeApp({
        user: FREE_USER,
        store,
        deps: { chatText: chat, getCached: cache.getCached, putCached: cache.putCached },
      });

      const res = await app.request('/llm/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_ANALYZE_BODY,
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; minTier: string };
      expect(body.error).toBe('tier-required');
      expect(body.minTier).toBe('pro');

      // Free users should never advance to Gemini or the counter.
      expect(chat).not.toHaveBeenCalled();
      expect(store.calls.inc).toBe(0);
    });

    it('returns 429 quota-exceeded when the pro cap is reached', async () => {
      const store = makeFakeUsageStore();
      // Seed the user at the pro cap (1500 combined). The middleware reads
      // analyze_calls + cover_calls; either combo at the cap should 429.
      store.seed(PRO_USER.sub, {
        analyze_calls: TIER_LLM_CAPS.pro - 500,
        cover_calls: 500,
      });
      const cache = makeFakeCache();
      const chat = makeChatStub(SAMPLE_ANALYZE_JSON);
      const app = makeApp({
        user: PRO_USER,
        store,
        deps: { chatText: chat, getCached: cache.getCached, putCached: cache.putCached },
      });

      const res = await app.request('/llm/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_ANALYZE_BODY,
      });
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: string; resetAt: string };
      expect(body.error).toBe('quota-exceeded');
      expect(typeof body.resetAt).toBe('string');
      // ISO 8601 string parseable to a future date.
      expect(Number.isNaN(Date.parse(body.resetAt))).toBe(false);
      expect(Date.parse(body.resetAt)).toBeGreaterThan(Date.now() - 1000);

      // No Gemini call, no counter bump.
      expect(chat).not.toHaveBeenCalled();
      expect(store.calls.inc).toBe(0);
    });

    it('rejects missing postId with 400', async () => {
      const store = makeFakeUsageStore();
      const cache = makeFakeCache();
      const chat = makeChatStub(SAMPLE_ANALYZE_JSON);
      const app = makeApp({
        user: PRO_USER,
        store,
        deps: { chatText: chat, getCached: cache.getCached, putCached: cache.putCached },
      });

      const res = await app.request('/llm/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ caption: 'orphan' }),
      });
      expect(res.status).toBe(400);
      // 4xx \u2192 no counter bump.
      expect(store.calls.inc).toBe(0);
    });

    it('does not increment the counter when Gemini returns no JSON', async () => {
      const store = makeFakeUsageStore();
      const cache = makeFakeCache();
      // Gemini returns null JSON \u2192 route 502s \u2192 the post-handler
      // increment is gated on a 2xx response so the counter stays put.
      const chat = vi.fn(async () => ({
        text: '',
        json: null,
        tokensIn: 0,
        tokensOut: 0,
        model: 'gemini-1.5-flash',
        durationMs: 1,
      })) satisfies (..._: unknown[]) => Promise<ChatResult>;
      const app = makeApp({
        user: PRO_USER,
        store,
        deps: { chatText: chat, getCached: cache.getCached, putCached: cache.putCached },
      });

      const res = await app.request('/llm/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_ANALYZE_BODY,
      });
      expect(res.status).toBe(502);
      expect(store.calls.inc).toBe(0);
    });
  });

  // ===== /llm/cover =======================================================

  describe('POST /v1/llm/cover', () => {
    it('fetches the cover, calls Gemini vision, and returns the COVER_SCHEMA shape on cache miss', async () => {
      const store = makeFakeUsageStore();
      const cache = makeFakeCache();
      const vision = makeChatStub(SAMPLE_COVER_JSON);
      const fetchImpl = makeImageFetchStub();
      const app = makeApp({
        user: PRO_USER,
        store,
        deps: {
          chatVision: vision,
          getCached: cache.getCached,
          putCached: cache.putCached,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      });

      const res = await app.request('/llm/cover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_COVER_BODY,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        hasFace: true,
        faceCount: 1,
        expression: 'serious',
        hasTextOverlay: true,
        textContent: 'PROTEIN MYTHS',
        dominantColor: 'navy',
        composition: 'closeup',
        cached: false,
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://cdn.example.com/cover.jpg',
        expect.objectContaining({ redirect: 'follow' }),
      );
      expect(vision).toHaveBeenCalledTimes(1);
      // The image is forwarded as base64 inline data to Gemini.
      const visionArg = vision.mock.calls[0][0] as {
        images: Array<{ mimeType: string; data: string }>;
      };
      expect(visionArg.images).toHaveLength(1);
      expect(visionArg.images[0].mimeType).toBe('image/jpeg');
      expect(visionArg.images[0].data.length).toBeGreaterThan(0);
    });

    it('increments cover_calls on cache miss, skips on cache hit', async () => {
      const store = makeFakeUsageStore();
      const cache = makeFakeCache();
      const vision = makeChatStub(SAMPLE_COVER_JSON);
      const fetchImpl = makeImageFetchStub();
      const app = makeApp({
        user: PRO_USER,
        store,
        deps: {
          chatVision: vision,
          getCached: cache.getCached,
          putCached: cache.putCached,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      });

      // Miss
      const first = await app.request('/llm/cover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_COVER_BODY,
      });
      expect(first.status).toBe(200);
      expect(((await first.json()) as { cached: boolean }).cached).toBe(false);

      let counts = await store.getCounters(PRO_USER.sub, llmPeriodStart());
      expect(counts.cover_calls).toBe(1);
      expect(counts.analyze_calls).toBe(0);

      // Hit \u2014 same URL hashes to the same cache key.
      const second = await app.request('/llm/cover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_COVER_BODY,
      });
      expect(second.status).toBe(200);
      const body = (await second.json()) as { cached: boolean };
      expect(body.cached).toBe(true);

      // Neither the upstream fetch nor Gemini were called again.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(vision).toHaveBeenCalledTimes(1);

      // Counter unchanged.
      counts = await store.getCounters(PRO_USER.sub, llmPeriodStart());
      expect(counts.cover_calls).toBe(1);
    });

    it('429s when the pro cap is reached \u2014 cover_calls counts towards the combined cap', async () => {
      const store = makeFakeUsageStore();
      store.seed(PRO_USER.sub, { analyze_calls: 0, cover_calls: TIER_LLM_CAPS.pro });
      const cache = makeFakeCache();
      const vision = makeChatStub(SAMPLE_COVER_JSON);
      const fetchImpl = makeImageFetchStub();
      const app = makeApp({
        user: PRO_USER,
        store,
        deps: {
          chatVision: vision,
          getCached: cache.getCached,
          putCached: cache.putCached,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      });

      const res = await app.request('/llm/cover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_COVER_BODY,
      });
      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('quota-exceeded');
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(vision).not.toHaveBeenCalled();
    });

    it('returns 403 tier-required for free users on /cover too', async () => {
      const store = makeFakeUsageStore();
      const cache = makeFakeCache();
      const vision = makeChatStub(SAMPLE_COVER_JSON);
      const app = makeApp({
        user: FREE_USER,
        store,
        deps: {
          chatVision: vision,
          getCached: cache.getCached,
          putCached: cache.putCached,
          fetchImpl: makeImageFetchStub() as unknown as typeof fetch,
        },
      });

      const res = await app.request('/llm/cover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_COVER_BODY,
      });
      expect(res.status).toBe(403);
      expect(vision).not.toHaveBeenCalled();
    });

    it('502s when the cover-url fetch returns non-2xx \u2014 no counter bump', async () => {
      const store = makeFakeUsageStore();
      const cache = makeFakeCache();
      const vision = makeChatStub(SAMPLE_COVER_JSON);
      const fetchImpl = vi.fn(async () => new Response('', { status: 404 }));
      const app = makeApp({
        user: PRO_USER,
        store,
        deps: {
          chatVision: vision,
          getCached: cache.getCached,
          putCached: cache.putCached,
          fetchImpl: fetchImpl as unknown as typeof fetch,
        },
      });

      const res = await app.request('/llm/cover', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_COVER_BODY,
      });
      expect(res.status).toBe(502);
      expect(vision).not.toHaveBeenCalled();
      expect(store.calls.inc).toBe(0);
    });
  });

  // ===== Studio tier ======================================================

  describe('studio tier', () => {
    it('has a 15000 cap, 10x the pro cap', async () => {
      expect(TIER_LLM_CAPS.studio).toBe(15_000);
      expect(TIER_LLM_CAPS.pro).toBe(1_500);
      expect(TIER_LLM_CAPS.free).toBe(0);
    });

    it('studio user passes both requireTier(pro) and the cap when usage is fresh', async () => {
      const studio = { sub: 'user-studio', email: 's@example.com', tier: 'studio' as const };
      const store = makeFakeUsageStore();
      const cache = makeFakeCache();
      const chat = makeChatStub(SAMPLE_ANALYZE_JSON);
      const app = makeApp({
        user: studio,
        store,
        deps: { chatText: chat, getCached: cache.getCached, putCached: cache.putCached },
      });

      const res = await app.request('/llm/analyze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: SAMPLE_ANALYZE_BODY,
      });
      expect(res.status).toBe(200);
    });
  });
});
