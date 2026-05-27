// Tests for requireTier — including the DEV_FORCE_TIER dev-only bypass.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// Required envs that env.ts asserts on read.
process.env.DATABASE_URL ??= 'postgres://stub';
process.env.JWT_SECRET ??= 'stub-secret-32-chars-1234567890ab';

// env.ts uses getters that read process.env on every access, so we don't
// actually need to re-import — just mutate process.env between tests.
type Mid = (
  c: { get: (k: string) => unknown; json: (b: unknown, s: number) => unknown },
  next: () => Promise<void>,
) => Promise<unknown>;

async function loadFresh(envOverrides: Record<string, string>): Promise<(min: 'pro' | 'studio') => Mid> {
  for (const [k, v] of Object.entries(envOverrides)) process.env[k] = v;
  const mod = await import('../../src/auth/middleware.js');
  return mod.requireTier as (min: 'pro' | 'studio') => Mid;
}

function makeApp(
  requireTier: (m: 'pro' | 'studio') => Mid,
  user: { email: string; tier: 'free' | 'pro' | 'studio' } | null,
  min: 'pro' | 'studio',
): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (user) c.set('user' as never, user as never);
    await next();
  });
  app.get('/x', requireTier(min), (c) => c.json({ ok: true }));
  return app;
}

describe('requireTier', () => {
  beforeEach(() => {
    process.env.DEV_FORCE_TIER = undefined;
    process.env.NODE_ENV = 'development';
  });

  it('blocks free users with 402 upgrade-required', async () => {
    const requireTier = await loadFresh({ NODE_ENV: 'development', DEV_FORCE_TIER: '' });
    const res = await makeApp(requireTier, { email: 'a@b.co', tier: 'free' }, 'pro').request('/x');
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string; minTier: string };
    expect(body.error).toBe('upgrade-required');
    expect(body.minTier).toBe('pro');
  });

  it('passes pro user through pro gate', async () => {
    const requireTier = await loadFresh({ NODE_ENV: 'development', DEV_FORCE_TIER: '' });
    const res = await makeApp(requireTier, { email: 'a@b.co', tier: 'pro' }, 'pro').request('/x');
    expect(res.status).toBe(200);
  });

  it('returns 401 with no user', async () => {
    const requireTier = await loadFresh({ NODE_ENV: 'development', DEV_FORCE_TIER: '' });
    const res = await makeApp(requireTier, null, 'pro').request('/x');
    expect(res.status).toBe(401);
  });

  it('DEV_FORCE_TIER=pro bypasses for free user in development', async () => {
    const requireTier = await loadFresh({ NODE_ENV: 'development', DEV_FORCE_TIER: 'pro' });
    const res = await makeApp(requireTier, { email: 'a@b.co', tier: 'free' }, 'pro').request('/x');
    expect(res.status).toBe(200);
  });

  it('DEV_FORCE_TIER=pro does NOT bypass studio gates', async () => {
    const requireTier = await loadFresh({ NODE_ENV: 'development', DEV_FORCE_TIER: 'pro' });
    const res = await makeApp(requireTier, { email: 'a@b.co', tier: 'free' }, 'studio').request('/x');
    expect(res.status).toBe(402);
  });

  it('DEV_FORCE_TIER=studio bypasses both pro and studio gates', async () => {
    const requireTier = await loadFresh({ NODE_ENV: 'development', DEV_FORCE_TIER: 'studio' });
    expect((await makeApp(requireTier, { email: 'a@b.co', tier: 'free' }, 'studio').request('/x')).status).toBe(200);
    expect((await makeApp(requireTier, { email: 'a@b.co', tier: 'free' }, 'pro').request('/x')).status).toBe(200);
  });

  it('DEV_FORCE_TIER ignored in production', async () => {
    const requireTier = await loadFresh({ NODE_ENV: 'production', DEV_FORCE_TIER: 'pro' });
    const res = await makeApp(requireTier, { email: 'a@b.co', tier: 'free' }, 'pro').request('/x');
    expect(res.status).toBe(402);
  });
});
