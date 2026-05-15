// Soft-cap usage counters. Per-user, per-billing-period.
// Period is the calendar month for free users / `current_period_end - 30d`
// for Stripe subscribers. We approximate with a calendar-month bucket which
// is good enough for the soft-cap scenario and is robust to clock skew.

import { sql, and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { usageCounters } from '../db/schema.js';

const SOFT_CAPS = {
  transcriptions: 2_000,
  extractions: 5_000,
} as const;

export type UsageKind = keyof typeof SOFT_CAPS;

function periodStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function incrementUsage(userId: string, kind: UsageKind, by = 1): Promise<void> {
  const start = periodStart();
  const setExpr =
    kind === 'transcriptions'
      ? { transcriptions: sql`${usageCounters.transcriptions} + ${by}` }
      : { extractions: sql`${usageCounters.extractions} + ${by}` };

  await db
    .insert(usageCounters)
    .values({
      userId,
      periodStart: start,
      transcriptions: kind === 'transcriptions' ? by : 0,
      extractions: kind === 'extractions' ? by : 0,
    })
    .onConflictDoUpdate({
      target: [usageCounters.userId, usageCounters.periodStart],
      set: setExpr,
    });
}

export async function getUsage(userId: string): Promise<{ transcriptions: number; extractions: number }> {
  const start = periodStart();
  const [row] = await db
    .select()
    .from(usageCounters)
    .where(and(eq(usageCounters.userId, userId), eq(usageCounters.periodStart, start)))
    .limit(1);
  return {
    transcriptions: row?.transcriptions ?? 0,
    extractions: row?.extractions ?? 0,
  };
}

export async function isOverSoftCap(userId: string, kind: UsageKind): Promise<boolean> {
  const usage = await getUsage(userId);
  return usage[kind] >= SOFT_CAPS[kind];
}

export const softCaps = SOFT_CAPS;
