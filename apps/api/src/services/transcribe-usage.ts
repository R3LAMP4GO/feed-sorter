// Whisper transcription usage counter.
//
// Per-user, per-billing-period second-counter for Groq Whisper / WhisperX
// transcriptions. Pricing decision: free tier never reaches this code path
// (the route is gated by `requireTier('pro')` upstream), and paid tiers have
// hard caps enforced in the transcribe handler.
//
//   pro    \u2192 7200s/month   (2hr)
//   studio \u2192 72000s/month  (20hr)
//
// Storage is behind a small `TranscribeUsageStore` seam mirroring
// `services/cache.ts` and `middleware/usage-counter.ts` so unit tests can
// swap in an in-memory fake without standing up Postgres. The default impl
// is wired to the singleton drizzle client.
//
// Period bucket: calendar month UTC, identical to the existing transcribe
// counter in `services/usage.ts` and the LLM counter in
// `middleware/usage-counter.ts`. Keeps the three counters on the same
// `usage_counters` row.

import { and, eq, sql } from 'drizzle-orm';
import { db as defaultDb, type Database } from '../db/client.js';
import { usageCounters } from '../db/schema.js';

export type Tier = 'free' | 'pro' | 'studio';

/**
 * Per-tier monthly hard cap on whisper seconds. `free` is included for
 * completeness; the `requireTier('pro')` gate ahead of the transcribe
 * route already 403s free users, so it should never be hit.
 */
export const TIER_TRANSCRIBE_CAPS: Record<Tier, number> = {
  free: 0,
  pro: 7_200, // 2 hours
  studio: 72_000, // 20 hours
};

/** Calendar-month bucket start (UTC). */
export function transcribePeriodStart(at: Date = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

/** First instant of the NEXT calendar-month bucket (UTC). */
export function transcribePeriodEnd(at: Date = new Date()): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

// -------- Storage seam ------------------------------------------------------

export interface TranscribeUsageStore {
  /** Current second-count for the user in the period bucket. 0 if no row. */
  getSeconds(userId: string, periodStart: Date): Promise<number>;
  /** UPSERT-bump: add `seconds` to the user's current bucket, inserting if missing. */
  addSeconds(userId: string, periodStart: Date, seconds: number): Promise<void>;
}

export function makeDrizzleTranscribeUsageStore(
  database: Database = defaultDb,
): TranscribeUsageStore {
  return {
    async getSeconds(userId, start) {
      const [row] = await database
        .select({ transcribeSeconds: usageCounters.transcribeSeconds })
        .from(usageCounters)
        .where(and(eq(usageCounters.userId, userId), eq(usageCounters.periodStart, start)))
        .limit(1);
      return Number(row?.transcribeSeconds ?? 0);
    },

    async addSeconds(userId, start, seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return;
      await database
        .insert(usageCounters)
        .values({
          userId,
          periodStart: start,
          // Sibling counters owned by other modules \u2014 stay at 0 on insert;
          // never touched on update (only transcribe_seconds advances here).
          transcriptions: 0,
          extractions: 0,
          analyzeCalls: 0,
          coverCalls: 0,
          transcribeSeconds: seconds,
        })
        .onConflictDoUpdate({
          target: [usageCounters.userId, usageCounters.periodStart],
          set: {
            transcribeSeconds: sql`${usageCounters.transcribeSeconds} + ${seconds}`,
          },
        });
    },
  };
}

const _defaultStore = makeDrizzleTranscribeUsageStore();

// Convenience exports so routes / scripts can read or bump without going
// through the seam directly.
export const getTranscribeSeconds = (
  userId: string,
  start: Date = transcribePeriodStart(),
): Promise<number> => _defaultStore.getSeconds(userId, start);

export const addTranscribeSeconds = (
  userId: string,
  seconds: number,
  start: Date = transcribePeriodStart(),
): Promise<void> => _defaultStore.addSeconds(userId, start, seconds);

// -------- Unified counter snapshot -----------------------------------------
//
// Used by `GET /v1/usage` to render quota meters in one round-trip.
// Reads the whole row (all four counters) at the current period bucket.

export interface UsageSnapshot {
  analyze_calls: number;
  cover_calls: number;
  transcribe_seconds: number;
  period_start: Date;
  period_end: Date;
}

export async function getUsageSnapshot(
  userId: string,
  at: Date = new Date(),
  database: Database = defaultDb,
): Promise<UsageSnapshot> {
  const start = transcribePeriodStart(at);
  const end = transcribePeriodEnd(at);
  const [row] = await database
    .select({
      analyzeCalls: usageCounters.analyzeCalls,
      coverCalls: usageCounters.coverCalls,
      transcribeSeconds: usageCounters.transcribeSeconds,
    })
    .from(usageCounters)
    .where(and(eq(usageCounters.userId, userId), eq(usageCounters.periodStart, start)))
    .limit(1);
  return {
    analyze_calls: row?.analyzeCalls ?? 0,
    cover_calls: row?.coverCalls ?? 0,
    transcribe_seconds: Number(row?.transcribeSeconds ?? 0),
    period_start: start,
    period_end: end,
  };
}
