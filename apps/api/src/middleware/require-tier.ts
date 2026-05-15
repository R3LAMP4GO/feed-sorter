// Tier gate for paid surfaces (managed-API /v1/llm/* and similar).
//
// Separate from `apps/api/src/auth/middleware.ts` requireTier (which 402s for
// the /v1/posts/* routes that predate Phase 13). This module is the canonical
// 403-style gate for new paid endpoints \u2014 `tier-required` is a stronger,
// authorization-style refusal whereas 402 reads as "billable but not paid".
//
// Honors the existing `DEV_FORCE_TIER` env (NODE_ENV !== 'production' only),
// mirroring the bypass semantics in `auth/middleware.ts` so local development
// behavior stays uniform across the two gates.

import type { MiddlewareHandler } from 'hono';
import { env } from '../env.js';

type Tier = 'free' | 'pro' | 'studio';

const ORDER: Record<Tier, number> = { free: 0, pro: 1, studio: 2 };

export function requireTier(min: 'pro' | 'studio'): MiddlewareHandler {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) return c.json({ error: 'unauthenticated' }, 401);

    // Dev-only bypass: NODE_ENV !== 'production' AND DEV_FORCE_TIER >= min.
    // Logged so it never silently elevates a request.
    const forced = env.DEV_FORCE_TIER as Tier | '';
    if (
      !env.IS_PROD &&
      (forced === 'pro' || forced === 'studio') &&
      ORDER[forced] >= ORDER[min]
    ) {
      // eslint-disable-next-line no-console
      console.warn(
        `[require-tier] DEV_FORCE_TIER=${forced} bypassing requireTier(${min}) for ${user.email}`,
      );
      await next();
      return;
    }

    if (ORDER[user.tier] < ORDER[min]) {
      return c.json({ error: 'tier-required', minTier: min }, 403);
    }
    await next();
  };
}
