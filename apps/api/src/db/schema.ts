// Drizzle ORM schema for the Feed Sorter managed backend.
//
// pgvector pattern mirrors `Airstrip-AI/airstrip` and `simstudioai/sim`:
//   embedding: vector('embedding', { dimensions: 1536 })
// HNSW cosine index syntax per drizzle-orm 0.31 changelog:
//   index(...).using('hnsw', table.embedding.op('vector_cosine_ops'))

import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';

// citext is not exposed by drizzle-orm core; declare a passthrough custom type.
const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext';
  },
});

// ---- Niche clusters (forward declared for FK in creators/posts) -------------
export const nicheClusters = pgTable(
  'niche_clusters',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    label: text('label').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }),
    parentId: uuid('parent_id'),
    postCount: integer('post_count').default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('niche_cluster_cosine_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
  ],
);

// ---- Users & billing --------------------------------------------------------
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: citext('email').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  stripeCustomerId: text('stripe_customer_id'),
  tier: text('tier').notNull().default('free'),
  trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
});

export const magicLinkTokens = pgTable('magic_link_tokens', {
  token: text('token').primaryKey(),
  email: citext('email').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
});

export const sessions = pgTable('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  jwtJti: text('jwt_jti').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  userAgent: text('user_agent'),
});

// ---- Creators ---------------------------------------------------------------
export const creators = pgTable(
  'creators',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    platform: text('platform').notNull(), // 'instagram' | 'tiktok' | 'youtube'
    username: citext('username').notNull(),
    displayName: text('display_name'),
    followerCount: bigint('follower_count', { mode: 'number' }),
    medianViews: bigint('median_views', { mode: 'number' }),
    nicheClusterId: uuid('niche_cluster_id').references(() => nicheClusters.id),
    lastScrapedAt: timestamp('last_scraped_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('creators_platform_username_uq').on(table.platform, table.username),
  ],
);

// ---- Posts (global, deduplicated) ------------------------------------------
export const posts = pgTable(
  'posts',
  {
    id: text('id').primaryKey(), // 'ig_<pk>' | 'tt_<id>' | 'yt_<videoId>'
    platform: text('platform').notNull(),
    nativeId: text('native_id').notNull(),
    creatorId: uuid('creator_id').references(() => creators.id),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    views: bigint('views', { mode: 'number' }),
    likes: bigint('likes', { mode: 'number' }),
    comments: bigint('comments', { mode: 'number' }),
    shares: bigint('shares', { mode: 'number' }),
    outlierScore: doublePrecision('outlier_score'),
    velocity: doublePrecision('velocity'),
    coverUrl: text('cover_url'),
    durationS: integer('duration_s'),
    caption: text('caption'),
    rawMetadata: jsonb('raw_metadata'),
    nicheClusterId: uuid('niche_cluster_id').references(() => nicheClusters.id),
    format: text('format'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('posts_platform_niche_posted_idx').on(
      table.platform,
      table.nicheClusterId,
      table.postedAt.desc(),
    ),
    index('posts_platform_format_posted_idx').on(
      table.platform,
      table.format,
      table.postedAt.desc(),
    ),
    index('posts_creator_posted_idx').on(table.creatorId, table.postedAt.desc()),
    index('posts_velocity_idx').on(table.velocity.desc().nullsLast()),
    index('posts_outlier_idx').on(table.outlierScore.desc().nullsLast()),
    index('posts_views_idx').on(table.views.desc().nullsLast()),
    index('posts_likes_idx').on(table.likes.desc().nullsLast()),
  ],
);

// ---- Captures (which user has which post) ----------------------------------
export const captures = pgTable(
  'captures',
  {
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    postId: text('post_id')
      .references(() => posts.id, { onDelete: 'cascade' })
      .notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).defaultNow(),
    scope: text('scope'), // 'profile' | 'explore' | 'foryou' | 'shorts-feed'
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.postId] }),
    index('captures_user_captured_idx').on(table.userId, table.capturedAt.desc()),
  ],
);

// ---- Transcripts (one per post, shared across users) -----------------------
export const transcripts = pgTable('transcripts', {
  postId: text('post_id')
    .primaryKey()
    .references(() => posts.id, { onDelete: 'cascade' }),
  fullText: text('full_text'),
  language: text('language'),
  source: text('source'), // 'groq-whisper' | 'youtube-captions' | 'free-transcript' | 'sidecar'
  segments: jsonb('segments'),
  durationS: doublePrecision('duration_s'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ---- Extractions (hook / middle / CTA) -------------------------------------
export const extractions = pgTable(
  'extractions',
  {
    postId: text('post_id')
      .primaryKey()
      .references(() => posts.id, { onDelete: 'cascade' }),
    hookText: text('hook_text'),
    hookType: text('hook_type'),
    hookStartS: doublePrecision('hook_start_s'),
    hookEndS: doublePrecision('hook_end_s'),
    middleSummary: text('middle_summary'),
    ctaText: text('cta_text'),
    ctaType: text('cta_type'),
    ctaStartS: doublePrecision('cta_start_s'),
    topics: text('topics').array(),
    llmModel: text('llm_model'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    index('extractions_hook_type_idx').on(table.hookType),
    index('extractions_cta_type_idx').on(table.ctaType),
    index('extractions_topics_gin_idx').using('gin', table.topics),
  ],
);

// ---- Saved views (Notion-style) --------------------------------------------
export const views = pgTable('views', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  name: text('name').notNull(),
  filterJson: jsonb('filter_json').notNull(),
  sortJson: jsonb('sort_json').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

// ---- Job queue (in-process) -------------------------------------------------
export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(), // 'extract' | 'classify-niche' | 'classify-format'
    payload: jsonb('payload').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').default(0),
    lastError: text('last_error'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('jobs_pending_idx')
      .on(table.status, table.scheduledAt)
      .where(sql`status in ('pending','failed')`),
  ],
);

// ---- Soft-cap counters ------------------------------------------------------
// Tracks per-user transcription / extraction counts within a billing period
// for the Phase 12 soft-cap enforcement.
//
// Phase 13 adds `analyze_calls` + `cover_calls` — managed-API LLM call counters
// bumped on every cache MISS through /v1/llm/*. Cache hits are free. Cap is
// per-tier (pro=1500/mo combined, studio=15000/mo) and enforced by the
// usageCounter middleware (`apps/api/src/middleware/usage-counter.ts`).
export const usageCounters = pgTable(
  'usage_counters',
  {
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    transcriptions: integer('transcriptions').notNull().default(0),
    extractions: integer('extractions').notNull().default(0),
    analyzeCalls: integer('analyze_calls').notNull().default(0),
    coverCalls: integer('cover_calls').notNull().default(0),
    // Whisper seconds billed for the period. Fractional (faster-whisper /
    // Groq Whisper return float durations). Capped per tier; see
    // `services/transcribe-usage.ts` TIER_TRANSCRIBE_CAPS.
    transcribeSeconds: doublePrecision('transcribe_seconds').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.userId, table.periodStart] })],
);

// ---- Analyses cache (content-hash keyed, shared across users) --------------
// Repeated LLM/vision/transcribe calls on the same content (same hash) skip
// the provider round-trip entirely. `kind` distinguishes the analysis flavour
// so collisions across kinds are impossible. `result` carries the structured
// payload returned by the provider (or its parsed JSON).
export const analyses = pgTable(
  'analyses',
  {
    hash: text('hash').primaryKey(),
    kind: text('kind').notNull(),
    provider: text('provider'),
    model: text('model'),
    result: jsonb('result').notNull(),
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    hitCount: integer('hit_count').default(0),
    lastHitAt: timestamp('last_hit_at', { withTimezone: true }),
  },
  (table) => [
    // Recency scan within a kind (e.g. "latest cover analyses"). The CHECK
    // constraint on `kind` is added via a raw SQL statement in the migration
    // because drizzle-orm doesn't expose enum CHECKs in the table builder yet.
    index('analyses_kind_created_idx').on(table.kind, table.createdAt.desc()),
  ],
);

// Re-export bool helper to silence unused-import warnings if needed elsewhere
export const _b = boolean;
