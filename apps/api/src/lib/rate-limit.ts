// In-memory token-bucket rate limiter, keyed by user id (or IP fallback).
// Sufficient for a single-process Railway deploy; for horizontal scale, swap to
// Redis later.

import type { MiddlewareHandler } from 'hono';

interface Bucket {
  count: number;
  resetAt: number;
}

const BUCKETS = new Map<string, Bucket>();

export function rateLimit(opts: { windowMs: number; max: number }): MiddlewareHandler {
  return async (c, next) => {
    const user = c.get('user');
    const key =
      (user?.sub ? `u:${user.sub}` : `ip:${c.req.header('x-forwarded-for') ?? 'unknown'}`) +
      `|${c.req.path}`;

    const now = Date.now();
    let b = BUCKETS.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      BUCKETS.set(key, b);
    }
    b.count++;
    c.header('x-ratelimit-limit', String(opts.max));
    c.header('x-ratelimit-remaining', String(Math.max(0, opts.max - b.count)));
    c.header('x-ratelimit-reset', String(Math.ceil(b.resetAt / 1000)));
    if (b.count > opts.max) {
      return c.json({ error: 'rate-limited', retryAfterMs: b.resetAt - now }, 429);
    }
    await next();
  };
}

// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of BUCKETS) {
    if (b.resetAt <= now) BUCKETS.delete(k);
  }
}, 60_000).unref?.();
