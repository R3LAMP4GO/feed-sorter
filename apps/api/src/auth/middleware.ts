// Hono middleware: extracts session JWT from cookie or `Authorization: Bearer`,
// verifies, attaches `user` to context. Optional vs required variants.

import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { COOKIE_NAME, verifySessionToken, type SessionClaims } from './jwt.js';
import { env } from '../env.js';

declare module 'hono' {
  interface ContextVariableMap {
    user?: SessionClaims;
  }
}

async function readClaims(c: Parameters<MiddlewareHandler>[0]): Promise<SessionClaims | null> {
  const cookieToken = getCookie(c, COOKIE_NAME);
  if (cookieToken) {
    const claims = await verifySessionToken(cookieToken);
    if (claims) return claims;
  }
  const auth = c.req.header('authorization') ?? '';
  if (auth.startsWith('Bearer ')) {
    const claims = await verifySessionToken(auth.slice(7));
    if (claims) return claims;
  }
  return null;
}

export const authOptional: MiddlewareHandler = async (c, next) => {
  const claims = await readClaims(c);
  if (claims) c.set('user', claims);
  await next();
};

export const authRequired: MiddlewareHandler = async (c, next) => {
  const claims = await readClaims(c);
  if (!claims) return c.json({ error: 'unauthenticated' }, 401);
  c.set('user', claims);
  await next();
};

export function requireTier(min: 'pro' | 'studio'): MiddlewareHandler {
  const order = { free: 0, pro: 1, studio: 2 } as const;
  return async (c, next) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthenticated' }, 401);

    // Dev-only bypass: NODE_ENV !== 'production' AND DEV_FORCE_TIER set to a
    // tier >= min. Logged so it's never silent.
    const forced = env.DEV_FORCE_TIER as 'free' | 'pro' | 'studio' | '';
    if (!env.IS_PROD && (forced === 'pro' || forced === 'studio') && order[forced] >= order[min]) {
      // eslint-disable-next-line no-console
      console.warn(`[auth] DEV_FORCE_TIER=${forced} bypassing requireTier(${min}) for ${user.email}`);
      await next();
      return;
    }

    if (order[user.tier] < order[min]) {
      return c.json({ error: 'upgrade-required', minTier: min }, 402);
    }
    await next();
  };
}
