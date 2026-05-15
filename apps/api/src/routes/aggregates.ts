// /v1/aggregates/hooks — top hooks by group, for cross-creator analysis.

import { Hono } from 'hono';
import { sql } from 'drizzle-orm';

import { db } from '../db/client.js';
import { authRequired } from '../auth/middleware.js';
import { compileFilter, decodeFilter, FilterError } from '../lib/filter.js';

const app = new Hono();

// GET /v1/aggregates/hooks?filter=<base64>&groupBy=hook_type|hook_text&topN=20
//
// groupBy=hook_type → grouped counts + averages per hook category.
// groupBy=hook_text → flat list of top-N hook texts ranked by velocity.

app.get('/hooks', authRequired, async (c) => {
  const user = c.get('user')!;
  const groupBy = c.req.query('groupBy') ?? 'hook_type';
  const topN = Math.min(100, Math.max(1, Number(c.req.query('topN') ?? 20)));

  let where;
  try {
    where = compileFilter(decodeFilter(c.req.query('filter')));
  } catch (err) {
    if (err instanceof FilterError) return c.json({ error: 'bad-filter', message: err.message }, 400);
    throw err;
  }

  const userScope = sql`exists (select 1 from captures cap where cap.user_id = ${user.sub} and cap.post_id = p.id)`;
  const baseJoin = sql`from posts p inner join extractions e on e.post_id = p.id`;

  if (groupBy === 'hook_type') {
    const rows = (await db.execute(sql`
      select
        e.hook_type as group,
        count(*)::int as count,
        avg(p.outlier_score)::float as avg_outlier,
        avg(p.velocity)::float as avg_velocity,
        avg(p.views)::float as avg_views
      ${baseJoin}
      where ${userScope} and ${where} and e.hook_type is not null
      group by e.hook_type
      order by count desc
      limit ${topN}
    `)) as unknown as Array<Record<string, unknown>>;
    return c.json({ groupBy, groups: rows });
  }

  if (groupBy === 'hook_text') {
    const rows = (await db.execute(sql`
      select
        p.id as post_id, e.hook_text, e.hook_type,
        p.creator_id, p.platform, p.views, p.outlier_score, p.velocity, p.cover_url
      ${baseJoin}
      where ${userScope} and ${where} and e.hook_text is not null
      order by p.velocity desc nulls last, p.views desc nulls last
      limit ${topN}
    `)) as unknown as Array<Record<string, unknown>>;
    return c.json({ groupBy, items: rows });
  }

  return c.json({ error: 'bad groupBy' }, 400);
});

export default app;
