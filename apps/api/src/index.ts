// Feed Sorter managed-backend API entrypoint.
//
// Hono on Node. Layout mirrors `lobehub/lobehub` `packages/openapi/src/app.ts`
// (`new Hono().basePath('/v1')` + cors/logger middleware) and
// `moeru-ai/arpk` `src/server/index.ts` (`.route('/feature', subapp)`).

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { randomUUID } from 'node:crypto';

import { env } from './env.js';
import { log } from './log.js';
import { authOptional, authRequired } from './auth/middleware.js';
import { requireTier } from './middleware/require-tier.js';
import { usageCounter } from './middleware/usage-counter.js';

import { buildAllowlist, resolveOrigin } from './lib/cors-allowlist.js';
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import postsRoutes from './routes/posts.js';
import libraryRoutes from './routes/library.js';
import aggregatesRoutes from './routes/aggregates.js';
import viewsRoutes from './routes/views.js';
import billingRoutes from './routes/billing.js';
import llmRoutes from './routes/llm.js';
import usageRoutes from './routes/usage.js';
import { startWorkers } from './workers/runner.js';

const root = new Hono();

// Request id + structured access log
root.use('*', async (c, next) => {
  const reqId = c.req.header('x-request-id') ?? randomUUID();
  c.header('x-request-id', reqId);
  const start = Date.now();
  await next();
  log.info(
    {
      reqId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Date.now() - start,
    },
    'req',
  );
});

const allowlist = buildAllowlist({
  appUrl: env.APP_URL,
  extra: env.ALLOWED_ORIGINS,
  isProd: env.IS_PROD,
});
log.info(
  {
    exact: [...allowlist.exact],
    allowExtensions: allowlist.allowExtensions,
    allowLocalhost: allowlist.allowLocalhost,
  },
  'cors allowlist',
);

root.use(
  '*',
  cors({
    origin: (origin) => resolveOrigin(allowlist, origin),
    credentials: true,
    allowHeaders: ['authorization', 'content-type', 'x-request-id'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    exposeHeaders: ['x-request-id', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'],
    maxAge: 600,
  }),
);
root.use('*', logger());

root.get('/', (c) => c.json({ ok: true, service: 'feedsorter-api' }));
root.get('/healthz', (c) => c.json({ ok: true }));

// Versioned API surface
const api = new Hono().basePath('/v1');

api.use('*', authOptional);
api.route('/auth', authRoutes);
api.route('/me', meRoutes);

// /v1/posts/:id/transcribe — Whisper transcription. Strictly paid-only:
//   authRequired → requireTier('pro') (403 for free).
// The handler itself enforces the per-tier transcribe-seconds cap (429)
// and caches results in `analyses` by content hash. See routes/transcribe.ts.
// requireTier here is the 403-style gate from middleware/require-tier.js;
// `/v1/posts/sync` keeps its 402-style gate inside postsRoutes.
api.use('/posts/:id/transcribe', authRequired, requireTier('pro'));
api.route('/posts', postsRoutes);

api.route('/library', libraryRoutes);
api.route('/aggregates', aggregatesRoutes);
api.route('/views', viewsRoutes);
api.route('/billing', billingRoutes);
api.route('/usage', usageRoutes);

// /v1/llm/* — Gemini-backed analyze + cover routes. Chain:
//   authRequired → requireTier('pro') → usageCounter → route handler.
// usageCounter enforces the monthly hard cap up-front and bumps the
// per-user counter on cache MISSES only (signaled by the handler).
api.use('/llm/*', authRequired, requireTier('pro'), usageCounter());
api.route('/llm', llmRoutes);

root.route('/', api);

// Final error handler
root.onError((err, c) => {
  log.error({ err: err.message, stack: err.stack }, 'unhandled');
  return c.json({ error: 'internal', message: err.message }, 500);
});

const port = env.PORT;
serve({ fetch: root.fetch, port }, (info) => {
  log.info({ port: info.port }, 'api listening');
  startWorkers();
});
