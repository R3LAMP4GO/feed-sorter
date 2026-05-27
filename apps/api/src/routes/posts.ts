// /v1/posts/* — sync (batch upsert).
//
// Transcription used to live here but moved to `routes/transcribe.ts`:
//   - free tier hard-gated at 403 (Whisper is the most expensive call we make)
//   - response cached in `analyses` (kind='transcribe') by content hash
//   - usage_counters.transcribe_seconds enforces per-tier monthly caps
// The new handler is still mounted at POST /v1/posts/:id/transcribe so the
// extension api-client doesn't need to change — wiring lives in `index.ts`.

import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

import { db as defaultDb, type Database } from '../db/client.js';
import { captures, creators, extractions, jobs, nicheClusters, posts, transcripts } from '../db/schema.js';
import { authRequired, requireTier } from '../auth/middleware.js';
import { checkScope, type Platform, type Scope } from '../lib/tier-gate.js';
import { rateLimit } from '../lib/rate-limit.js';
import transcribeRoutes from './transcribe.js';

// --- POST /v1/posts/sync -----------------------------------------------------
//
// Body: { posts: SyncPost[] }
//
// SyncPost = {
//   id, platform, nativeId, creator: { platform, username, displayName?, followerCount?, niche? },
//   postedAt?, views?, likes?, comments?, shares?, outlierScore?, velocity?,
//   coverUrl?, durationS?, caption?, raw?, scope,
//   niche?, format?, hook?, hookType?, middle?/middleSummary?, cta?, ctaType?,
//   topics?, transcript?
// }
//
// Tier-gated: a free user's `scope` of explore/foryou/shorts-feed is silently
// dropped server-side (defense in depth). The extension also gates client-side
// for UX.

interface SyncTranscript {
  text?: string;
  segments?: unknown;
  source?: string;
  language?: string;
  durationS?: number;
}

interface SyncPost {
  id: string;
  platform: Platform;
  nativeId: string;
  creator?: {
    platform: Platform;
    username: string;
    displayName?: string;
    followerCount?: number;
    niche?: string;
  };
  postedAt?: string;
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  outlierScore?: number;
  velocity?: number;
  coverUrl?: string;
  durationS?: number;
  caption?: string;
  raw?: unknown;
  scope: Scope;
  niche?: string;
  nicheBasis?: string;
  format?: string;
  formatScores?: Record<string, number>;
  hook?: string;
  hookType?: string;
  middle?: string;
  middleSummary?: string;
  cta?: string;
  ctaType?: string;
  topics?: string[];
  transcript?: SyncTranscript;
}

export interface PostsRouteDeps {
  db: Database;
  now: () => Date;
}

const ALLOWED_PLATFORMS: ReadonlySet<Platform> = new Set(['instagram', 'tiktok', 'youtube']);
const SYNC_LLM_MODEL = 'extension-sync';

function resolveDeps(partial: Partial<PostsRouteDeps>): PostsRouteDeps {
  return {
    db: partial.db ?? defaultDb,
    now: partial.now ?? (() => new Date()),
  };
}

function nullableString(value: unknown, maxLength?: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return typeof maxLength === 'number' ? trimmed.slice(0, maxLength) : trimmed;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeTopics(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const topics = value
    .map((topic) => nullableString(topic, 80)?.toLowerCase() ?? null)
    .filter((topic): topic is string => !!topic)
    .slice(0, 10);
  return topics.length ? topics : null;
}

function buildRawMetadata(p: SyncPost): object | null {
  const raw = p.raw && typeof p.raw === 'object' ? (p.raw as Record<string, unknown>) : {};
  const meta: Record<string, unknown> = { ...raw };
  if (p.nicheBasis) meta.nicheBasis = p.nicheBasis;
  if (p.formatScores && typeof p.formatScores === 'object') meta.formatScores = p.formatScores;
  return Object.keys(meta).length ? meta : null;
}

async function findOrCreateNicheCluster(
  deps: PostsRouteDeps,
  label: string | null,
): Promise<string | null> {
  if (!label) return null;
  const [existing] = await deps.db
    .select({ id: nicheClusters.id })
    .from(nicheClusters)
    .where(eq(nicheClusters.label, label))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await deps.db
    .insert(nicheClusters)
    .values({ label, postCount: 0 })
    .returning({ id: nicheClusters.id });
  return created?.id ?? null;
}

async function upsertCreator(
  deps: PostsRouteDeps,
  p: SyncPost,
  nicheClusterId: string | null,
): Promise<string | null> {
  if (!p.creator?.username) return null;

  const [existing] = await deps.db
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
    await deps.db
      .update(creators)
      .set({
        displayName: p.creator.displayName,
        followerCount: p.creator.followerCount,
        nicheClusterId: nicheClusterId ?? undefined,
      })
      .where(eq(creators.id, existing.id));
    return existing.id;
  }

  const [created] = await deps.db
    .insert(creators)
    .values({
      platform: p.creator.platform,
      username: p.creator.username,
      displayName: p.creator.displayName,
      followerCount: p.creator.followerCount,
      nicheClusterId,
    })
    .returning({ id: creators.id });
  return created.id;
}

async function upsertExtraction(deps: PostsRouteDeps, p: SyncPost): Promise<void> {
  const hookText = nullableString(p.hook, 1000);
  const hookType = nullableString(p.hookType, 80);
  const middleSummary = nullableString(p.middleSummary ?? p.middle, 2000);
  const ctaText = nullableString(p.cta, 500);
  const ctaType = nullableString(p.ctaType, 80);
  const topics = normalizeTopics(p.topics);
  if (!hookText && !hookType && !middleSummary && !ctaText && !ctaType && !topics) return;

  await deps.db
    .insert(extractions)
    .values({
      postId: p.id,
      hookText,
      hookType,
      hookStartS: null,
      hookEndS: null,
      middleSummary,
      ctaText,
      ctaType,
      ctaStartS: null,
      topics,
      llmModel: SYNC_LLM_MODEL,
    })
    .onConflictDoUpdate({
      target: extractions.postId,
      set: {
        hookText,
        hookType,
        middleSummary,
        ctaText,
        ctaType,
        topics,
        llmModel: SYNC_LLM_MODEL,
      },
    });
}

async function upsertTranscript(deps: PostsRouteDeps, p: SyncPost): Promise<void> {
  const text = nullableString(p.transcript?.text);
  const segments = Array.isArray(p.transcript?.segments) ? p.transcript.segments : null;
  if (!text && !segments) return;

  await deps.db
    .insert(transcripts)
    .values({
      postId: p.id,
      fullText: text ?? '',
      language: nullableString(p.transcript?.language, 20),
      source: nullableString(p.transcript?.source, 80) ?? 'extension-sync',
      segments: segments as object | null,
      durationS: nullableNumber(p.transcript?.durationS),
    })
    .onConflictDoUpdate({
      target: transcripts.postId,
      set: {
        fullText: text ?? '',
        language: nullableString(p.transcript?.language, 20),
        source: nullableString(p.transcript?.source, 80) ?? 'extension-sync',
        segments: segments as object | null,
        durationS: nullableNumber(p.transcript?.durationS),
      },
    });

  if (!p.hook && !p.middle && !p.middleSummary && !p.cta) {
    await deps.db.insert(jobs).values({ kind: 'extract', payload: { postId: p.id } });
  }
}

export function buildPostsRoutes(partial: Partial<PostsRouteDeps> = {}): Hono {
  const deps = resolveDeps(partial);
  const app = new Hono();

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

      const nicheLabel = nullableString(p.niche) ?? nullableString(p.creator?.niche);
      const nicheClusterId = await findOrCreateNicheCluster(deps, nicheLabel);
      const creatorId = await upsertCreator(deps, p, nicheClusterId);
      const rawMetadata = buildRawMetadata(p);
      const now = deps.now();

      // Upsert post (deduplicated globally by id)
      await deps.db
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
          outlierScore: p.outlierScore ?? null,
          velocity: p.velocity ?? null,
          coverUrl: p.coverUrl ?? null,
          durationS: p.durationS ?? null,
          caption: p.caption ?? null,
          rawMetadata,
          nicheClusterId,
          format: nullableString(p.format),
        })
        .onConflictDoUpdate({
          target: posts.id,
          set: {
            views: sql`excluded.views`,
            likes: sql`excluded.likes`,
            comments: sql`excluded.comments`,
            shares: sql`excluded.shares`,
            outlierScore: sql`excluded.outlier_score`,
            velocity: sql`excluded.velocity`,
            caption: sql`excluded.caption`,
            coverUrl: sql`excluded.cover_url`,
            durationS: sql`excluded.duration_s`,
            rawMetadata: sql`excluded.raw_metadata`,
            nicheClusterId: sql`excluded.niche_cluster_id`,
            format: sql`excluded.format`,
            updatedAt: now,
          },
        });

      await upsertExtraction(deps, p);
      await upsertTranscript(deps, p);

      // Capture row (per-user)
      await deps.db
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

  return app;
}

export default buildPostsRoutes();
