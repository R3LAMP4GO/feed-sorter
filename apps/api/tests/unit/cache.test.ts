// Unit tests for the analyses cache service.
//
// We exercise the cache against an in-memory `AnalysisStore` fake to keep
// the suite hermetic (no Postgres required). The fake faithfully mimics
// the SQL semantics that `makeDrizzleStore` relies on:
//   - findByHash → SELECT ... WHERE hash = $1 LIMIT 1
//   - incrementHit → UPDATE ... SET hit_count = hit_count + 1, last_hit_at = $2
//   - upsert → INSERT ... ON CONFLICT (hash) DO UPDATE SET <fields>,
//              preserving created_at / hit_count / last_hit_at on conflict.

// env.ts reads `DATABASE_URL` lazily, but cache.ts imports the db client at
// load time which constructs a `postgres()` pool — stub both so the import
// graph doesn't blow up under the test runner. `vi.hoisted` lifts this
// above ESM's import hoisting.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://stub:stub@127.0.0.1:5432/stub';
  process.env.JWT_SECRET ??= 'stub-secret-32-chars-1234567890ab';
});

import {
  makeCache,
  type AnalysisKind,
  type AnalysisStore,
  type CachedAnalysis,
  type PutCachedInput,
} from '../../src/services/cache.js';

interface FakeStore extends AnalysisStore {
  rows: Map<string, CachedAnalysis>;
  calls: { findByHash: number; incrementHit: number; upsert: number };
}

function makeFakeStore(): FakeStore {
  const rows = new Map<string, CachedAnalysis>();
  const calls = { findByHash: 0, incrementHit: 0, upsert: 0 };
  return {
    rows,
    calls,
    async findByHash(hash) {
      calls.findByHash += 1;
      const row = rows.get(hash);
      // Return a shallow clone so the caller can't mutate our store directly,
      // matching Drizzle's "rows are plain objects from the driver" behaviour.
      return row ? { ...row } : null;
    },
    async incrementHit(hash, at) {
      calls.incrementHit += 1;
      const row = rows.get(hash);
      if (!row) return;
      row.hitCount = (row.hitCount ?? 0) + 1;
      row.lastHitAt = at;
    },
    async upsert(input) {
      calls.upsert += 1;
      const existing = rows.get(input.hash);
      if (existing) {
        // Mirrors `ON CONFLICT (hash) DO UPDATE SET ...` — only the mutable
        // fields are overwritten; created_at / hit_count / last_hit_at stay.
        existing.provider = input.provider ?? null;
        existing.model = input.model ?? null;
        existing.result = input.result;
        existing.tokensIn = input.tokensIn ?? null;
        existing.tokensOut = input.tokensOut ?? null;
        return;
      }
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

function samplePut(overrides: Partial<PutCachedInput> = {}): PutCachedInput {
  return {
    hash: 'sha256:abc',
    kind: 'analyze' satisfies AnalysisKind,
    provider: 'gemini',
    model: 'gemini-1.5-flash',
    result: { hook: 'How I scaled to 1M', confidence: 0.87 },
    tokensIn: 42,
    tokensOut: 18,
    ...overrides,
  };
}

describe('cache service', () => {
  let store: FakeStore;
  let cache: ReturnType<typeof makeCache>;

  beforeEach(() => {
    store = makeFakeStore();
    cache = makeCache(store);
  });

  describe('getCached', () => {
    it('returns null on miss without bumping the hit counter', async () => {
      const out = await cache.getCached('sha256:nope');
      expect(out).toBeNull();
      expect(store.calls.findByHash).toBe(1);
      expect(store.calls.incrementHit).toBe(0);
    });
  });

  describe('putCached', () => {
    it('persists a new row with the supplied fields', async () => {
      await cache.putCached(samplePut());
      expect(store.rows.size).toBe(1);
      const stored = store.rows.get('sha256:abc');
      expect(stored).toMatchObject({
        hash: 'sha256:abc',
        kind: 'analyze',
        provider: 'gemini',
        model: 'gemini-1.5-flash',
        tokensIn: 42,
        tokensOut: 18,
        hitCount: 0,
        lastHitAt: null,
      });
      expect(stored?.result).toEqual({ hook: 'How I scaled to 1M', confidence: 0.87 });
      expect(stored?.createdAt).toBeInstanceOf(Date);
    });

    it('defaults provider / model / tokens to null when omitted', async () => {
      await cache.putCached({
        hash: 'sha256:bare',
        kind: 'transcribe',
        result: { text: 'hello' },
      });
      const stored = store.rows.get('sha256:bare');
      expect(stored).toMatchObject({
        provider: null,
        model: null,
        tokensIn: null,
        tokensOut: null,
      });
    });
  });

  describe('get-hit-increments-counter', () => {
    it('bumps hit_count and last_hit_at on every cache hit', async () => {
      await cache.putCached(samplePut());

      const before = new Date();
      const first = await cache.getCached('sha256:abc');
      expect(first).not.toBeNull();
      expect(first?.result).toEqual({ hook: 'How I scaled to 1M', confidence: 0.87 });

      const afterFirst = store.rows.get('sha256:abc');
      expect(afterFirst?.hitCount).toBe(1);
      expect(afterFirst?.lastHitAt).toBeInstanceOf(Date);
      expect((afterFirst?.lastHitAt as Date).getTime()).toBeGreaterThanOrEqual(before.getTime());

      // Two more hits — counter advances monotonically.
      await cache.getCached('sha256:abc');
      await cache.getCached('sha256:abc');
      expect(store.rows.get('sha256:abc')?.hitCount).toBe(3);
      expect(store.calls.incrementHit).toBe(3);
    });

    it('returns the row read at find time, not after the bump', async () => {
      // getCached resolves to the row as it was BEFORE the increment so the
      // caller sees a stable snapshot for the current request. The next call
      // will reflect the updated counter.
      await cache.putCached(samplePut());
      const out = await cache.getCached('sha256:abc');
      // hitCount on the returned object is 0 (pre-bump snapshot).
      expect(out?.hitCount).toBe(0);
      // Underlying store has been incremented.
      expect(store.rows.get('sha256:abc')?.hitCount).toBe(1);
    });
  });

  describe('idempotent put', () => {
    it('keeps a single row when the same hash is put twice', async () => {
      await cache.putCached(samplePut());
      await cache.putCached(samplePut());
      expect(store.rows.size).toBe(1);
      expect(store.calls.upsert).toBe(2);
    });

    it('overwrites mutable fields on conflict but preserves hit history', async () => {
      await cache.putCached(samplePut());
      // First read to seed hit_count = 1 / last_hit_at.
      const firstRead = await cache.getCached('sha256:abc');
      expect(firstRead).not.toBeNull();
      const hitAfterFirstRead = store.rows.get('sha256:abc')?.lastHitAt;
      expect(store.rows.get('sha256:abc')?.hitCount).toBe(1);

      // Re-put with a different model + payload — fields update, but
      // hit_count and last_hit_at must NOT regress.
      await cache.putCached(
        samplePut({
          model: 'gemini-1.5-pro',
          result: { hook: 'rewrite v2', confidence: 0.92 },
          tokensIn: 100,
          tokensOut: 30,
        }),
      );
      const after = store.rows.get('sha256:abc');
      expect(after?.model).toBe('gemini-1.5-pro');
      expect(after?.result).toEqual({ hook: 'rewrite v2', confidence: 0.92 });
      expect(after?.tokensIn).toBe(100);
      expect(after?.tokensOut).toBe(30);
      // Hit history preserved across re-puts.
      expect(after?.hitCount).toBe(1);
      expect(after?.lastHitAt).toEqual(hitAfterFirstRead);
    });
  });
});
