// GET /v1/usage \u2014 quota snapshot for the current user.
//
// Returns the four counters that the managed-API paid surfaces track, the
// period bucket boundaries, and the per-tier limits so the extension can
// render live quota meters in one round-trip:
//
//   {
//     analyze_calls: 42,
//     cover_calls: 13,
//     transcribe_seconds: 1230.5,
//     period_start: '2026-05-01T00:00:00.000Z',
//     period_end:   '2026-06-01T00:00:00.000Z',
//     tier: 'pro',
//     tier_limits: {
//       llm_calls:          1500,     // combined analyze + cover cap
//       transcribe_seconds: 7200,     // 2hr/month
//     },
//   }
//
// Auth: requireAuth (any tier). Free users get tier_limits of zero across
// the board \u2014 still a valid snapshot, useful for the upgrade prompt UX.

import { Hono } from 'hono';

import { authRequired } from '../auth/middleware.js';
import {
  getUsageSnapshot,
  TIER_TRANSCRIBE_CAPS,
  type Tier,
} from '../services/transcribe-usage.js';
import { TIER_LLM_CAPS } from '../middleware/usage-counter.js';

const app = new Hono();

app.get('/', authRequired, async (c) => {
  const user = c.get('user')!;
  const tier = (user.tier ?? 'free') as Tier;

  const snap = await getUsageSnapshot(user.sub);

  return c.json({
    analyze_calls: snap.analyze_calls,
    cover_calls: snap.cover_calls,
    transcribe_seconds: snap.transcribe_seconds,
    period_start: snap.period_start.toISOString(),
    period_end: snap.period_end.toISOString(),
    tier,
    tier_limits: {
      // analyze and cover share a single combined monthly cap (see
      // middleware/usage-counter.ts). Expose it as `llm_calls` so the
      // extension's meter renders as a single bar instead of two.
      llm_calls: TIER_LLM_CAPS[tier] ?? 0,
      transcribe_seconds: TIER_TRANSCRIBE_CAPS[tier] ?? 0,
    },
  });
});

export default app;
