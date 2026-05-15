// LLM call counter middleware for /v1/llm/*.
//
// Two responsibilities:
//   1. Pre-flight cap check \u2014 if the user's monthly counter (analyze + cover)
//      is at the tier cap, respond 429 `quota-exceeded` before the route runs.
//   2. Post-handler increment \u2014 when the route signaled a cache MISS by
//      setting `c.set('llmCacheMissKey', 'analyze_calls' | 'cover_calls')`,
//      bump that counter for the current billing period. Cache hits skip the
//      increment entirely so they stay free.
//
// Storage is behind an `LlmUsageStore` seam (mirrors `services/cache.ts`)
// so unit tests can swap in an in-memory fake without standing up Postgres.
// The default impl is wired to the singleton drizzle client.
//
// Period bucket: calendar month UTC. Same approximation as
// `services/usage.ts` \u2014 robust to clock skew and trivial to reset.

import type { MiddlewareHandler } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { db as defaultDb, type Database } from '../db/client.js';
import { usageCounters } from '../db/schema.js';

export type LlmCounterKey = 'analyze_calls' | 'cover_calls';

/**
 * Per-tier monthly hard cap. Combined across analyze + cover calls.
 * `free` is included for completeness; the `requireTier('pro')` gate ahead of
 * this middleware will already 403 free users, so it should never be hit.
 */
export const TIER_LLM_CAPS: Record<'free' | 'pro' | 'studio', number> = {
  free: 0,
  pro: 1_500,
  studio: 15_000,
};

/** Calendar-month bucket start (UTC). */
export function llmPeriodStart(at: Date = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/** First instant of the NEXT calendar-month bucket (UTC). */
export function llmPeriodEnd(at: Date = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

// Context-variable key used by routes to signal a cache miss. Routes set this
// to the relevant counter key just before returning; the middleware reads it
// after `next()` and increments accordingly.
export const LLM_CACHE_MISS_KEY = 'llmCacheMissKey' as const;

declare module 'hono' {
  interface ContextVariableMap {
    llmCacheMissKey?: LlmCounterKey;
  }
}

// -------- Storage seam ------------------------------------------------------

export interface LlmUsageCounts {
  analyze_calls: number;
  cover_calls: number;
}

export interface LlmUsageStore {
  getCounters(userId: string, periodStart: Date): Promise<LlmUsageCounts>;
  increment(userId: string, periodStart: Date, key: LlmCounterKey): Promise<void>;
}

export function makeDrizzleLlmUsageStore(database: Database = defaultDb): LlmUsageStore {
  return {
    async getCounters(userId, start) {
      const [row] = await database
        .select({
          analyzeCalls: usageCounters.analyzeCalls,
          coverCalls: usageCounters.coverCalls,
        })
        .from(usageCounters)
        .where(and(eq(usageCounters.userId, userId), eq(usageCounters.periodStart, start)))
        .limit(1);
      return {
        analyze_calls: row?.analyzeCalls ?? 0,
        cover_calls: row?.coverCalls ?? 0,
      };
    },

    async increment(userId, start, key) {
      const setExpr =
        key === 'analyze_calls'
          ? { analyzeCalls: sql`${usageCounters.analyzeCalls} + 1` }
          : { coverCalls: sql`${usageCounters.coverCalls} + 1` };
      await database
        .insert(usageCounters)
        .values({
          userId,
          periodStart: start,
          // Existing transcribe/extract counters stay at 0 \u2014 they're owned
          // by `services/usage.ts` and incremented elsewhere.
          transcriptions: 0,
          extractions: 0,
          analyzeCalls: key === 'analyze_calls' ? 1 : 0,
          coverCalls: key === 'cover_calls' ? 1 : 0,
        })
        .onConflictDoUpdate({
          target: [usageCounters.userId, usageCounters.periodStart],
          set: setExpr,
        });
    },
  };
}

const _defaultStore = makeDrizzleLlmUsageStore();

// Convenience exports so routes / scripts can read or bump without going
// through the middleware (e.g. a /v1/me/usage endpoint later on).
export const getLlmCounters = (userId: string, start: Date = llmPeriodStart()): Promise<LlmUsageCounts> =>
  _defaultStore.getCounters(userId, start);
export const incrementLlmCounter = (
  userId: string,
  key: LlmCounterKey,
  start: Date = llmPeriodStart(),
): Promise<void> => _defaultStore.increment(userId, start, key);

// -------- Middleware --------------------------------------------------------

export interface UsageCounterOpts {
  /** Override the storage impl. Defaults to the singleton drizzle store. */
  store?: LlmUsageStore;
  /** Override `now()` for deterministic tests. */
  now?: () => Date;
}

export function usageCounter(opts: UsageCounterOpts = {}): MiddlewareHandler {
  const store = opts.store ?? _defaultStore;
  const now = opts.now ?? (() => new Date());

  return async (c, next) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthenticated' }, 401);

    const tier = (user.tier ?? 'free') as keyof typeof TIER_LLM_CAPS;
    const cap = TIER_LLM_CAPS[tier] ?? 0;
    const start = llmPeriodStart(now());

    const counts = await store.getCounters(user.sub, start);
    const used = counts.analyze_calls + counts.cover_calls;
    if (used >= cap) {
      return c.json(
        { error: 'quota-exceeded', resetAt: llmPeriodEnd(now()).toISOString() },
        429,
      );
    }

    await next();

    // Only increment on (a) a route-signaled cache miss AND (b) a 2xx
    // response. Failures don't charge \u2014 if Gemini blew up, the user
    // gets their quota back.
    const missKey = c.get(LLM_CACHE_MISS_KEY);
    const status = c.res.status;
    if (missKey && status >= 200 && status < 300) {
      await store.increment(user.sub, start, missKey);
    }
  };
}
