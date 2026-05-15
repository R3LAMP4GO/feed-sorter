// Pino structured logger. Railway captures stdout, so default transport is
// fine in production; pretty-print in dev only.

import pino from 'pino';
import { env } from './env.js';

export const log = pino({
  level: env.IS_PROD ? 'info' : 'debug',
  base: { svc: 'api' },
  timestamp: pino.stdTimeFunctions.isoTime,
});
