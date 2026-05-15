// /v1/posts/* — sync (batch upsert).
//
// Transcription used to live here but moved to `routes/transcribe.ts`:
//   - free tier hard-gated at 403 (Whisper is the most expensive call we make)
//   - response cached in `analyses` (kind='transcribe') by content hash
//   - usage_counters.transcribe_seconds enforces per-tier monthly caps
// The new handler is still mounted at POST /v1/posts/:id/transcribe so the
// extension api-client doesn't need to change — wiring lives in `index.ts`.

import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

import { db } from '../db/client.js';
import { posts, captures, creators } from '../db/schema.js';
import { authRequired, requireTier } from '../auth/middleware.js';
import { checkScope, type Scope, type Platform } from '../lib/tier-gate.js';
import { rateLimit } from '../lib/rate-limit.js';
import transcribeRoutes from './transcribe.js';

const app = new Hono();

// --- POST /v1/posts/sync -----------------------------------------------------
//
// Body: { posts: SyncPost[] }
//
// SyncPost = {
//   id, platform, nativeId, creator: { platform, username, displayName?, followerCount? },
//   postedAt?, views?, likes?, comments?, shares?,
//   coverUrl?, durationS?, caption?, raw?, scope
// }
//
// Tier-gated: a free user's `scope` of explore/foryou/shorts-feed is silently
// dropped server-side (defense in depth). The extension also gates client-side
// for UX.

interface SyncPost {
  id: string;
  platform: Platform;
  nativeId: string;
  creator?: {
    platform: Platform;
    username: string;
    displayName?: string;
    followerCount?: number;
  };
  postedAt?: string;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  coverUrl?: string;
  durationS?: number;
  caption?: string;
  raw?: unknown;
  scope: Scope;
}

const ALLOWED_PLATFORMS: ReadonlySet<Platform> = new Set(['instagram', 'tiktok', 'youtube']);

app.post('/sync', authRequired, requireTier('pro'), rateLimit({ windowMs: 60_000, max: 60 }), async (c) => {
  const user = c.get('user')!;
  const body = await c.req.json().catch(() => ({}));
  const incoming = Array.isArray(body?.posts) ? (body.posts as SyncPost[]) : [];
  if (incoming.length === 0) return c.json({ inserted: 0, dropped: 0 });
  if (incoming.length > 500) return c.json({ error: 'batch too large (max 500)' }, 413);

  let inserted = 0;
  let dropped = 0;

  for (const p of incoming) {
    if (!p?.id || !p?.platform || !ALLOWED_PLATFORMS.has(p.platform)) {
      dropped++;
      continue;
    }
    const gate = checkScope({ tier: user.tier, platform: p.platform, scope: p.scope });
    if (!gate.allowed) {
      dropped++;
      continue;
    }

    let creatorId: string | null = null;
    if (p.creator?.username) {
      const [existing] = await db
        .select({ id: creators.id })
        .from(creators)
        .where(
          and(
            eq(creators.platform, p.creator.platform),
            eq(creators.username, p.creator.username),
          ),
        )
        .limit(1);
      if (existing) {
        creatorId = existing.id;
      } else {
        const [created] = await db
          .insert(creators)
          .values({
            platform: p.creator.platform,
            username: p.creator.username,
            displayName: p.creator.displayName,
            followerCount: p.creator.followerCount,
          })
          .returning({ id: creators.id });
        creatorId = created.id;
      }
    }

    // Upsert post (deduplicated globally by id)
    await db
      .insert(posts)
      .values({
        id: p.id,
        platform: p.platform,
        nativeId: p.nativeId ?? p.id,
        creatorId,
        postedAt: p.postedAt ? new Date(p.postedAt) : null,
        views: p.views ?? null,
        likes: p.likes ?? null,
        comments: p.comments ?? null,
        shares: p.shares ?? null,
        coverUrl: p.coverUrl ?? null,
        durationS: p.durationS ?? null,
        caption: p.caption ?? null,
        rawMetadata: (p.raw ?? null) as object | null,
      })
      .onConflictDoUpdate({
        target: posts.id,
        set: {
          views: sql`excluded.views`,
          likes: sql`excluded.likes`,
          comments: sql`excluded.comments`,
          shares: sql`excluded.shares`,
          caption: sql`excluded.caption`,
          coverUrl: sql`excluded.cover_url`,
          updatedAt: new Date(),
        },
      });

    // Capture row (per-user)
    await db
      .insert(captures)
      .values({ userId: user.sub, postId: p.id, scope: p.scope })
      .onConflictDoNothing();

    inserted++;
  }

  return c.json({ inserted, dropped });
});

// /v1/posts/:id/transcribe — see header comment above. The handler is in
// `routes/transcribe.ts`; we mount it here so `index.ts` only has to wire
// the auth/tier middleware against the path pattern (one less moving part).
app.route('/', transcribeRoutes);

export default app;
