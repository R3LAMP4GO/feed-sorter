// /v1/me — current user profile + tier.

import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { authRequired } from '../auth/middleware.js';

const app = new Hono();

app.get('/', authRequired, async (c) => {
  const claims = c.get('user')!;
  const [row] = await db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
  if (!row) return c.json({ error: 'user-not-found' }, 404);

  return c.json({
    id: row.id,
    email: row.email,
    tier: row.tier,
    trialEndsAt: row.trialEndsAt,
    currentPeriodEnd: row.currentPeriodEnd,
  });
});

export default app;
