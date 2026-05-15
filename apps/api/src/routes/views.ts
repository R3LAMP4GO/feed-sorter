// /v1/views — Notion-style saved views (filter+sort presets).

import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';

import { db } from '../db/client.js';
import { views } from '../db/schema.js';
import { authRequired, requireTier } from '../auth/middleware.js';

const app = new Hono();

app.use('*', authRequired, requireTier('pro'));

app.get('/', async (c) => {
  const user = c.get('user')!;
  const rows = await db
    .select()
    .from(views)
    .where(eq(views.userId, user.sub))
    .orderBy(desc(views.createdAt));
  return c.json({ items: rows });
});

app.get('/:id', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  const [row] = await db
    .select()
    .from(views)
    .where(and(eq(views.userId, user.sub), eq(views.id, id)))
    .limit(1);
  if (!row) return c.json({ error: 'not-found' }, 404);
  return c.json(row);
});

app.post('/', async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const name = String(body?.name ?? '').trim();
  const filterJson = body?.filterJson ?? body?.filter_json ?? {};
  const sortJson = body?.sortJson ?? body?.sort_json ?? {};
  if (!name) return c.json({ error: 'name required' }, 400);

  const [created] = await db
    .insert(views)
    .values({ userId: user.sub, name, filterJson, sortJson })
    .returning();
  return c.json(created, 201);
});

app.delete('/:id', async (c) => {
  const user = c.get('user')!;
  const id = c.req.param('id');
  await db.delete(views).where(and(eq(views.userId, user.sub), eq(views.id, id)));
  return c.json({ ok: true });
});

export default app;
