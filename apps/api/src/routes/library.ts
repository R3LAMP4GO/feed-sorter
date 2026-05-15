// /v1/library — paginated, filtered list of posts captured by the user.

import { Hono } from 'hono';
import { sql } from 'drizzle-orm';

import { db } from '../db/client.js';
import { authRequired } from '../auth/middleware.js';
import {
  compileFilter,
  compileSort,
  decodeFilter,
  decodeSort,
  filterTouchesExtractions,
  FilterError,
} from '../lib/filter.js';

const app = new Hono();

app.get('/', authRequired, async (c) => {
  const user = c.get('user')!;
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50)));
  const offset = Math.max(0, Number(c.req.query('offset') ?? 0));

  let where;
  let orderBy;
  let needsExtractionsJoin: boolean;
  try {
    const filter = decodeFilter(c.req.query('filter'));
    const sort = decodeSort(c.req.query('sort'));
    where = compileFilter(filter);
    orderBy = compileSort(sort);
    needsExtractionsJoin = filterTouchesExtractions(filter);
  } catch (err) {
    if (err instanceof FilterError) return c.json({ error: 'bad-filter', message: err.message }, 400);
    throw err;
  }

  // Always filter to the requesting user's captures.
  const userScope = sql`exists (select 1 from captures cap where cap.user_id = ${user.sub} and cap.post_id = p.id)`;

  const join = needsExtractionsJoin
    ? sql`from posts p left join extractions e on e.post_id = p.id`
    : sql`from posts p left join extractions e on e.post_id = p.id`;
  // We always join extractions because the SELECT pulls hook/cta fields.

  const items = (await db.execute(sql`
    select
      p.id, p.platform, p.creator_id, p.posted_at, p.views, p.likes, p.comments, p.shares,
      p.outlier_score, p.velocity, p.cover_url, p.duration_s, p.caption,
      p.format, p.niche_cluster_id,
      e.hook_text, e.hook_type, e.cta_text, e.cta_type, e.topics
    ${join}
    where ${userScope} and ${where}
    order by ${orderBy}
    limit ${limit} offset ${offset}
  `)) as unknown as Array<Record<string, unknown>>;

  const totalRows = (await db.execute(sql`
    select count(*)::int as n
    ${join}
    where ${userScope} and ${where}
  `)) as unknown as Array<{ n: number }>;
  const total = totalRows[0]?.n ?? 0;

  return c.json({ items, total, limit, offset });
});

export default app;
