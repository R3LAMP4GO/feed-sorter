// Content-hash keyed analyses cache.
//
// Repeated calls to expensive providers (LLM, vision, transcription) on the
// same content — keyed by `hash` — return a single shared row instead of
// re-running the provider. The cache is global across users; we never store
// PII alongside the hash so this is safe.
//
// Drizzle work happens behind a small `AnalysisStore` seam so unit tests can
// inject an in-memory fake without standing up Postgres. Production code
// uses `makeDrizzleStore()` over the singleton client.
//
// Idempotency: `putCached` is an UPSERT. Putting the same hash twice yields
// a single row; `hit_count` / `last_hit_at` are preserved across writes so
// they only ever advance on reads.

import { eq, sql } from 'drizzle-orm';
import { db as defaultDb, type Database } from '../db/client.js';
import { analyses } from '../db/schema.js';

export type AnalysisKind = 'analyze' | 'cover' | 'transcribe';

export interface CachedAnalysis {
  hash: string;
  kind: AnalysisKind;
  provider: string | null;
  model: string | null;
  result: unknown;
  tokensIn: number | null;
  tokensOut: number | null;
  createdAt: Date | null;
  hitCount: number | null;
  lastHitAt: Date | null;
}

export interface PutCachedInput {
  hash: string;
  kind: AnalysisKind;
  provider?: string | null;
  model?: string | null;
  result: unknown;
  tokensIn?: number | null;
  tokensOut?: number | null;
}

// Storage seam — every DB operation cache.ts needs, expressed at a level
// above Drizzle's fluent builders so tests can fake it trivially.
export interface AnalysisStore {
  findByHash(hash: string): Promise<CachedAnalysis | null>;
  incrementHit(hash: string, at: Date): Promise<void>;
  upsert(input: PutCachedInput): Promise<void>;
}

export function makeDrizzleStore(database: Database = defaultDb): AnalysisStore {
  return {
    async findByHash(hash) {
      const [row] = await database
        .select()
        .from(analyses)
        .where(eq(analyses.hash, hash))
        .limit(1);
      return (row as CachedAnalysis | undefined) ?? null;
    },

    async incrementHit(hash, at) {
      await database
        .update(analyses)
        .set({ hitCount: sql`${analyses.hitCount} + 1`, lastHitAt: at })
        .where(eq(analyses.hash, hash));
    },

    async upsert(input) {
      const row = {
        hash: input.hash,
        kind: input.kind,
        provider: input.provider ?? null,
        model: input.model ?? null,
        // Drizzle's `jsonb` column types as `unknown`; cast at the boundary.
        result: input.result as never,
        tokensIn: input.tokensIn ?? null,
        tokensOut: input.tokensOut ?? null,
      };
      await database
        .insert(analyses)
        .values(row)
        .onConflictDoUpdate({
          target: analyses.hash,
          set: {
            // `kind` is intentionally omitted: collisions across kinds are
            // already impossible because the hash includes a kind prefix
            // upstream, and rewriting kind would silently corrupt history.
            provider: row.provider,
            model: row.model,
            result: row.result,
            tokensIn: row.tokensIn,
            tokensOut: row.tokensOut,
          },
        });
    },
  };
}

export function makeCache(store: AnalysisStore): {
  getCached: (hash: string) => Promise<CachedAnalysis | null>;
  putCached: (input: PutCachedInput) => Promise<void>;
} {
  return {
    async getCached(hash) {
      const row = await store.findByHash(hash);
      if (!row) return null;
      // Fire the hit-count bump on the same path so observability is honest;
      // we await it so callers see consistent state in their next read.
      await store.incrementHit(hash, new Date());
      return row;
    },

    async putCached(input) {
      await store.upsert(input);
    },
  };
}

// Default cache wired to the singleton db. Routes/workers import these.
const _defaultCache = makeCache(makeDrizzleStore());
export const getCached = _defaultCache.getCached;
export const putCached = _defaultCache.putCached;
