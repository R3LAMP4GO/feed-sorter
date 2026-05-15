# Managed Backend + Website + YouTube Shorts

Pivot from local-only / BYOK to a managed SaaS where the backend runs all
transcription and AI extraction, the website is the analysis surface, and
the extension becomes a thin capture + sync client. Ship YouTube Shorts
alongside Instagram + TikTok.

---

## Reference repos (mirrored patterns)

Each integration in this plan is anchored to a battle-tested public repo
found via `kencode-search`. We mirror their approach rather than
reinvent. Re-fetch the linked file at the **start of each phase** to
confirm current best practice before writing code.

| Concern                       | Reference repo (file) |
|-------------------------------|--------------------------------------------------------------------------------------------------------|
| Hono app skeleton + middleware | `lobehub/lobehub` `packages/openapi/src/app.ts` — `new Hono().basePath('/api/v1')` + cors/logger/auth |
| Hono multi-route compose       | `moeru-ai/arpk` `src/server/index.ts` — `.route('/translate', translate)` per-feature subroutes |
| Hono session cookies (server)  | `cablate/banini-tracker` `src/web.ts` — `setCookie(c, 'session', token, { httpOnly, sameSite, secure })` |
| Hono JWT cookie session        | `f/mcp-startup-framework` `src/auth/handlers/auth.ts` — `createSessionToken` + `setCookie` 30d |
| Stripe webhook verify (Node)   | `solygambas/python-openai-projects` `00-playground/67-devstash/.../stripe/route.ts` — `stripe.webhooks.constructEvent(body, signature, secret)` |
| Stripe CLI dev workflow        | `antoineross/Hikari` `package.json` — `stripe login`, `stripe listen --forward-to`, `stripe fixtures` scripts |
| Stripe products/prices CLI     | `stripe-samples/checkout-single-subscription` `README.md` — `stripe products create`, `stripe prices create -d product=… -d unit_amount=…` |
| Drizzle pgvector schema        | `Airstrip-AI/airstrip` `schema.ts` (kbEmbeddings dim 1536, hnsw cosine) + `Open-Model-Initiative/OMI-Data-Pipeline` `embeddings.ts` |
| Drizzle pgvector index syntax  | `drizzle-team/drizzle-orm` `changelogs/0.31.0.md` — `index().using('hnsw', table.embedding.op('vector_cosine_ops'))` |
| Groq Whisper REST upload       | `claraverse-space/ClaraVerse` `internal/audio/service.go` — `POST api.groq.com/openai/v1/audio/transcriptions` model `whisper-large-v3` (multipart `file` field) |
| Railway CLI provisioning       | `oven-sh/bun` `docs/guides/deployment/railway.mdx` + `sandroandric/clime` `infra/scripts/deploy-railway-production.sh` — `railway add --database postgres`, `railway add --service`, `railway variable set` |
| YouTube innertube intercept    | `apades/dmMiniPlayer` `youtube/utils.ts` (subtitles JSON shape) + `Xerophayze/XeroFlow` `youtube_transcript_node.py` (innertube key + ANDROID client) + `zerodytrash/Simple-YouTube-Age-Restriction-Bypass` `main.js` (XHR/fetch interception of `/youtubei/v1/player` and `/youtubei/v1/next`) |

---

## Goals

1. **Managed-first.** User pays a flat fee; we handle Groq/LLM costs.
   No BYOK, no local Ollama setup required for end users.
2. **Extension = capture.** Browse IG/TT/YT → posts captured + synced.
   Free tier limited to creator profiles only; Pro unlocks Explore /
   For You / Shorts feed.
3. **Website = analysis.** Notion-database-style filterable library.
   Hook / Middle / CTA structure per post. Cross-creator aggregation.
   "Top hooks this week in [niche] by [format] sorted by [velocity]"
   with arbitrary filter combinations.
4. **Lean infra.** Single Railway project: Hono/Node API + managed
   Postgres + Next.js website. Stripe for billing. Total fixed cost
   <$30/mo at MVP.
5. **Cost-efficient transcription.** Global post-level dedup — one
   transcription serves all users who captured the same viral reel.

## Non-goals (explicitly out of scope for v1)

- Auth UX polish (magic-link via Resend; revisit later)
- Team / agency seats (Studio tier, v2)
- White-label / custom domains
- Realtime collaboration on the website
- Mobile app
- Keeping the local Ollama / BYOK paths exposed in the UI (code stays
  for dev use, hidden behind a debug flag)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Browser Extension                         │
│  (IG / TT / YT capture, profile-only on free tier)           │
│  - Intercepts feed APIs (existing IG/TT, new YT innertube)   │
│  - Captures post metadata + grabs MP4 via live session       │
│  - "Sync now" → POST batches to backend                      │
│  - Free tier: scope gate blocks Explore/FYP/Shorts feed      │
└──────────────────┬───────────────────────────────────────────┘
                   │ JWT cookie auth, multipart upload
                   ▼
┌─────────────────────────────────────────────────────────────┐
│            Railway: api.<railway-domain>                     │
│                  (Hono on Node)                              │
│                                                              │
│  POST /v1/auth/magic-link    issue magic link                │
│  POST /v1/auth/verify        exchange token → JWT            │
│  GET  /v1/me                 current user + tier             │
│  POST /v1/posts/sync         batch upsert posts              │
│  POST /v1/posts/:id/transcribe  multipart MP4 → transcript   │
│  POST /v1/billing/checkout   Stripe checkout session         │
│  POST /v1/billing/webhook    Stripe webhook (raw body)       │
│  GET  /v1/library            paginated, filtered             │
│  GET  /v1/aggregates/hooks   top hooks (filtered)            │
│  GET  /v1/views              saved views                     │
│  POST /v1/views              create saved view               │
│                                                              │
│  Background workers (in-process, jobs table):                │
│   - extraction-worker  transcript → hook/middle/CTA/format   │
│   - niche-cluster-worker  embed + pgvector cluster           │
└──────────────────┬───────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│         Railway Postgres (with pgvector extension)           │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│             Railway: app.<railway-domain>                    │
│                   Next.js (App Router)                       │
│                                                              │
│  /login          magic-link form                             │
│  /library        Notion-style table, filter+sort+save        │
│  /hooks          top hooks aggregation                       │
│  /creators       per-creator drill-down                      │
│  /views/[id]     saved view                                  │
│  /billing        manage subscription                         │
└─────────────────────────────────────────────────────────────┘
```

### Why Railway

- File uploads (MP4 stream → Groq) work natively on Node; Workers caps
  at 100MB request size and is awkward with multipart streaming.
- One vendor, one bill, one dashboard. Postgres add-on, no Supabase
  layer to sync auth state across.
- The user already has a Railway account.

### Why Hono

- Tiny, fast, has middleware for JWT, file uploads, streaming.
- Confirmed pattern from `lobehub/lobehub` and `moeru-ai/arpk`:
  `new Hono().basePath('/api/v1')` + `.route('/feature', subapp)`.
- Avoids Next.js coupling — keeps the API a separate deploy.

---

## Data model (Postgres)

All tables prefixed by domain. `pgvector` extension enabled for niche
embedding clustering. Drizzle ORM schema generation; embedding column
mirrors `Airstrip-AI/airstrip` (`vector('embedding', { dimensions: N })`)
with HNSW cosine index per `drizzle-team/drizzle-orm` 0.31.0 syntax.

### Users & billing

```sql
users (
  id              uuid pk default gen_random_uuid(),
  email           citext unique not null,
  created_at      timestamptz default now(),
  stripe_customer_id text,
  tier            text not null default 'free',  -- 'free' | 'pro' | 'studio'
  trial_ends_at   timestamptz,
  current_period_end timestamptz,
  last_seen_at    timestamptz
);

magic_link_tokens (
  token           text pk,
  email           citext not null,
  expires_at      timestamptz not null,
  used_at         timestamptz
);

sessions (
  id              uuid pk default gen_random_uuid(),
  user_id         uuid references users(id) on delete cascade,
  jwt_jti         text unique,
  created_at      timestamptz default now(),
  expires_at      timestamptz not null,
  user_agent      text
);
```

### Creators (cross-platform identity)

```sql
creators (
  id              uuid pk default gen_random_uuid(),
  platform        text not null,                 -- 'instagram' | 'tiktok' | 'youtube'
  username        citext not null,
  display_name    text,
  follower_count  bigint,
  median_views    bigint,                        -- rolling median for outlier calc
  niche_cluster_id uuid references niche_clusters(id),
  last_scraped_at timestamptz,
  unique (platform, username)
);
```

### Posts (global, deduplicated)

```sql
posts (
  id              text pk,                        -- 'ig_<pk>' | 'tt_<id>' | 'yt_<videoId>'
  platform        text not null,
  native_id       text not null,                  -- raw platform id
  creator_id      uuid references creators(id),
  posted_at       timestamptz,
  views           bigint,
  likes           bigint,
  comments        bigint,
  shares          bigint,
  outlier_score   double precision,               -- views / creator.median_views
  velocity        double precision,               -- outlier / log(hours_old + 1)
  cover_url       text,
  duration_s      int,
  caption         text,
  raw_metadata    jsonb,
  niche_cluster_id uuid references niche_clusters(id),
  format          text,                           -- 'talking-head' | 'voiceover-broll' | 'skit' | 'tutorial' | 'pov' | 'text-overlay' | 'unknown'
  captured_at     timestamptz default now(),
  updated_at      timestamptz default now()
);

create index on posts (platform, niche_cluster_id, posted_at desc);
create index on posts (platform, format, posted_at desc);
create index on posts (creator_id, posted_at desc);
create index on posts (velocity desc nulls last);
create index on posts (outlier_score desc nulls last);
create index on posts (views desc nulls last);
create index on posts (likes desc nulls last);
```

### Captures (which user has which post)

```sql
captures (
  user_id         uuid references users(id) on delete cascade,
  post_id         text references posts(id) on delete cascade,
  captured_at     timestamptz default now(),
  scope           text,                           -- 'profile' | 'explore' | 'foryou' | 'shorts-feed'
  primary key (user_id, post_id)
);

create index on captures (user_id, captured_at desc);
```

### Transcripts (one per post, shared across users)

```sql
transcripts (
  post_id         text pk references posts(id) on delete cascade,
  full_text       text,
  language        text,
  source          text,                           -- 'groq-whisper' | 'youtube-captions' | 'free-transcript' | 'sidecar'
  segments        jsonb,                          -- [{ start, end, text }]
  duration_s      double precision,
  created_at      timestamptz default now()
);
```

### Extractions (hook / middle / CTA)

```sql
extractions (
  post_id         text pk references posts(id) on delete cascade,
  hook_text       text,
  hook_type       text,        -- 'question' | 'stat' | 'controversial-claim' | 'list-promise' | 'story-open' | 'pattern-interrupt' | 'direct-address' | 'other'
  hook_start_s    double precision,
  hook_end_s      double precision,
  middle_summary  text,
  cta_text        text,
  cta_type        text,        -- 'follow' | 'comment' | 'save' | 'share' | 'link-in-bio' | 'visit-profile' | 'none'
  cta_start_s     double precision,
  topics          text[],
  llm_model       text,
  created_at      timestamptz default now()
);

create index on extractions (hook_type);
create index on extractions (cta_type);
create index on extractions using gin (topics);
```

### Niche clusters (self-organizing)

```sql
niche_clusters (
  id              uuid pk default gen_random_uuid(),
  label           text not null,
  embedding       vector(1536),                   -- OpenAI text-embedding-3-small
  parent_id       uuid references niche_clusters(id),
  post_count      int default 0,
  created_at      timestamptz default now()
);
-- HNSW cosine per drizzle-orm 0.31.0 reference:
-- index('niche_cluster_cosine_idx').using('hnsw', table.embedding.op('vector_cosine_ops'))
```

### Saved views (Notion-style)

```sql
views (
  id              uuid pk default gen_random_uuid(),
  user_id         uuid references users(id) on delete cascade,
  name            text not null,
  filter_json     jsonb not null,
  sort_json       jsonb not null,
  created_at      timestamptz default now()
);
```

### Job queue (in-process)

```sql
jobs (
  id              uuid pk default gen_random_uuid(),
  kind            text not null,                  -- 'extract' | 'classify-niche' | 'classify-format'
  payload         jsonb not null,
  status          text not null default 'pending',
  attempts        int default 0,
  last_error      text,
  scheduled_at    timestamptz default now(),
  started_at      timestamptz,
  completed_at    timestamptz
);

create index on jobs (status, scheduled_at) where status in ('pending','failed');
```

---

## Filter & sort schema (the Notion-database engine)

### Filter spec (JSON)

```jsonc
{
  "and": [
    { "field": "platform",         "op": "in",            "value": ["instagram", "tiktok", "youtube"] },
    { "field": "niche_cluster_id", "op": "in",            "value": ["uuid…"] },
    { "field": "format",           "op": "in",            "value": ["talking-head", "voiceover-broll"] },
    { "field": "hook_type",        "op": "in",            "value": ["question", "stat"] },
    { "field": "cta_type",         "op": "in",            "value": ["follow", "save"] },
    { "field": "topics",           "op": "contains-any",  "value": ["fitness", "mobility"] },
    { "field": "creator_id",       "op": "in",            "value": ["uuid…"] },
    { "field": "posted_at",        "op": "gte",           "value": "2026-04-01" },
    { "field": "posted_at",        "op": "lt",            "value": "2026-05-01" },
    { "field": "views",            "op": "gte",           "value": 100000 },
    { "field": "likes",            "op": "gte",           "value": 5000 },
    { "field": "comments",         "op": "gte",           "value": 100 },
    { "field": "outlier_score",    "op": "gte",           "value": 2.0 },
    { "field": "velocity",         "op": "gte",           "value": 1.0 },
    { "field": "duration_s",       "op": "lte",           "value": 60 },
    { "field": "caption",          "op": "ilike",         "value": "%morning routine%" }
  ]
}
```

Supported `op`: `eq`, `neq`, `in`, `not-in`, `gte`, `lte`, `gt`, `lt`,
`ilike`, `contains-any`, `contains-all`. Top-level `or` is v2.

### Sort spec

```jsonc
{
  "by": "velocity",
  "dir": "desc",
  "secondary": { "by": "posted_at", "dir": "desc" }
}
```

Sortable fields: `views`, `likes`, `comments`, `outlier_score`,
`velocity`, `posted_at`, `duration_s`.

### Killer aggregate query

```
GET /v1/aggregates/hooks?filter=<base64-json>&groupBy=hook_type&topN=20
```

Translates to grouped SQL with `count`, `avg(outlier)`, `avg(velocity)`,
plus a flat top-N variant for "top 20 actual hook texts" sorted by
velocity within filter scope.

---

## Free vs Pro tier gating

Enforced server-side on every endpoint. Extension also enforces
client-side for UX.

| Capability                                     | Free                  | Pro |
|------------------------------------------------|-----------------------|-----|
| Capture from creator profile pages             | ✅                    | ✅  |
| Capture from Explore (IG)                      | ❌                    | ✅  |
| Capture from For You (TikTok)                  | ❌                    | ✅  |
| Capture from Shorts feed (YouTube)             | ❌                    | ✅  |
| Capture from search / hashtag / sound          | ❌                    | ✅  |
| Sort + outlier score (in-extension overlay)    | ✅                    | ✅  |
| CSV export                                     | ✅ (50 rows)          | ✅  |
| Sync to website                                | ❌                    | ✅  |
| Transcription                                  | ❌                    | ✅  |
| Hook / Middle / CTA extraction                 | ❌                    | ✅  |
| Niche / format classification                  | ❌                    | ✅  |
| Top hooks aggregation                          | ❌                    | ✅  |
| Saved views                                    | ❌                    | ✅  |
| Sinks (Sheets / Airtable / Notion)             | ❌                    | ✅  |

Implementation:
- Extension reads `tier` from `/v1/me` on startup, caches 5 min.
- `content.js` checks `tier === 'free' && scope.kind in ('explore','foryou','shorts-feed')`
  → upgrade prompt instead of capture.
- Server middleware on `/v1/posts/sync` drops any `capture` whose
  `scope` is gated for the user's tier (defense in depth).

---

## Pricing (initial)

- **Free:** profile-only capture, in-extension sorting only.
- **Pro:** $29/mo (or $19 founding rate for first 100 users). Soft cap
  ~2,000 transcriptions/mo and ~5,000 LLM extractions/mo. Hard cap
  10,000 / 25,000 (anti-abuse, not advertised). 7-day free trial.
- **Studio:** v2.

Subscription state authoritative in Stripe; mirrored to `users.tier`
via webhook.

---

## YouTube Shorts integration

Net-new platform. Mirrors the IG/TT pattern. Reference
`zerodytrash/Simple-YouTube-Age-Restriction-Bypass` for innertube
interception, `apades/dmMiniPlayer` for caption-track JSON parsing.

### Files to add

- `src/lib/parser-youtube.js` — pure parser for innertube responses
  (`/youtubei/v1/browse`, `/youtubei/v1/next`, `/youtubei/v1/player`).
- `src/lib/scope-youtube.js` — classify pathnames:
  - `/shorts/<id>` → `shorts-feed` (free-tier blocked)
  - `/@<handle>` or `/@<handle>/shorts` → `profile` (free-tier ok)
  - `/channel/<id>` → `profile` (free-tier ok)
  - `/results?...` / `/feed/trending` → `other` (gated)
- `src/lib/platform.js` — add `youtube` config, `yt_` id prefix,
  `feed-sorter-yt` download folder, surfaces
  `["profile", "shorts-feed", "search"]`.
- `src/lib/platform-runtime.js` — IIFE mirror.
- `tests/fixtures/youtube-{player,browse,next}.json`.
- `tests/unit/parser-youtube.test.js`, `tests/unit/scope-youtube.test.js`.

### Manifest changes

Add `https://www.youtube.com/*`, `https://m.youtube.com/*`,
`https://www.googlevideo.com/*` to `host_permissions`,
`content_scripts.matches`, `web_accessible_resources.matches`.

### Network interception

Extend `injected.js` with the same pattern from
`zerodytrash/Simple-YouTube-Age-Restriction-Bypass/main.js`: wrap
`XMLHttpRequest` and `fetch`, match `/youtubei/v1/player` and
`/youtubei/v1/next` URLs, extract `videoDetails`,
`playerResponse.streamingData`, and
`captions.playerCaptionsTracklistRenderer.captionTracks[]`.

### Transcription path for YouTube

1. **Free tier (zero-cost):** YouTube auto-generated captions via the
   `captionTracks[].baseUrl`. Extension fetches (session-bound URL),
   converts XML/VTT to plain text, posts to backend as `source =
   'youtube-captions'`.
2. **Groq Whisper** if no caption track present.
3. **Sidecar** as dev fallback.

---

## Stripe CLI workflow

We use Stripe CLI for **all** Stripe setup — products, prices,
webhook listening, fixtures. Mirrors `antoineross/Hikari` `package.json`
scripts and `stripe-samples/checkout-single-subscription` README.

### One-time auth

```bash
stripe login                         # browser flow, stores key in ~/.config/stripe
```

### Create products & prices (via CLI, idempotent script)

`apps/api/scripts/stripe-bootstrap.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Pro $29/mo
PRO_PRODUCT=$(stripe products create \
  --name="Feed Sorter Pro" \
  --description="Unlimited capture, transcription, hook extraction, dashboard" \
  -d "metadata[tier]=pro" \
  --format=json | jq -r '.id')

stripe prices create \
  -d product="$PRO_PRODUCT" \
  -d unit_amount=2900 \
  -d currency=usd \
  -d "recurring[interval]=month" \
  -d "metadata[tier]=pro"

# Pro Founding $19/mo (hidden coupon code "FOUNDING")
PRO_FOUNDING_PRODUCT=$(stripe products create \
  --name="Feed Sorter Pro (Founding)" \
  --description="Founding-member rate" \
  -d "metadata[tier]=pro" \
  --format=json | jq -r '.id')

stripe prices create \
  -d product="$PRO_FOUNDING_PRODUCT" \
  -d unit_amount=1900 \
  -d currency=usd \
  -d "recurring[interval]=month" \
  -d "metadata[tier]=pro"

# Output IDs for env wiring
echo "Set STRIPE_PRICE_PRO and STRIPE_PRICE_PRO_FOUNDING from output above"
```

Run once after `stripe login`. Store resulting price IDs as Railway env
vars (`STRIPE_PRICE_PRO`, `STRIPE_PRICE_PRO_FOUNDING`).

### Local webhook testing

`package.json` (root or `apps/api`):

```json
{
  "scripts": {
    "stripe:listen": "stripe listen --forward-to=http://localhost:8787/v1/billing/webhook",
    "stripe:trigger": "stripe trigger checkout.session.completed",
    "stripe:fixtures": "stripe fixtures apps/api/stripe/fixtures.json"
  }
}
```

`stripe listen` prints a webhook signing secret (`whsec_…`); copy into
`apps/api/.env.local` as `STRIPE_WEBHOOK_SECRET`. Production secret
comes from Stripe Dashboard endpoint config (different value).

### Webhook handler shape (mirror `solygambas/python-openai-projects`)

```ts
// apps/api/src/routes/billing.ts (Hono adapter of Next route pattern)
billing.post('/webhook', async (c) => {
  const body = await c.req.text();          // raw body required
  const sig = c.req.header('stripe-signature') ?? '';
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return c.json({ error: 'Invalid signature' }, 400);
  }
  // handle: checkout.session.completed | customer.subscription.updated | customer.subscription.deleted
  return c.json({ received: true });
});
```

### Fixtures (create test products / customers in CI)

`apps/api/stripe/fixtures.json` follows the Hikari example
(`utils/stripe/fixtures/stripe-fixtures.json`). Pull a copy from that
repo as a starting point and edit names/amounts.

---

## Build phases

Each phase is independently shippable. Phase order is dependency-driven.

### Phase 0 — repo prep (½ day)
- Add `apps/api/` (Hono backend) and `apps/web/` (Next.js) workspaces.
  Existing `web/` becomes `apps/web/`.
- Root `package.json` becomes a workspace root (npm workspaces).
- Extension stays at repo root.
- `.gitignore` updates for Railway artifacts, `.env.local`, Stripe CLI
  state.

### Phase 1 — Railway provisioning (½ day, Railway CLI)

Mirrors `oven-sh/bun` Railway docs and `sandroandric/clime` deploy
script.

```bash
railway login
railway init --name "feedsorter"
railway link

# database first
railway add --database postgres

# api service (deploys from apps/api root after wiring monorepo settings)
railway add --service api --variables \
  DATABASE_URL='${{Postgres.DATABASE_URL}}' \
  NODE_ENV=production

# web service
railway add --service web --variables \
  NEXT_PUBLIC_API_URL='${{api.RAILWAY_PUBLIC_DOMAIN}}'

# generate public domains
railway domain --service api
railway domain --service web

# enable pgvector on the Postgres service via psql
railway run --service Postgres psql -c "create extension if not exists vector;"
```

### Phase 2 — Postgres schema + Drizzle migrations (1 day)
- Install `drizzle-orm`, `drizzle-kit`, `pg`, `postgres`.
- Schema in `apps/api/src/db/schema.ts`, mirroring
  `Airstrip-AI/airstrip` / `Open-Model-Initiative/OMI-Data-Pipeline`
  `vector('embedding', { dimensions: 1536 })` + HNSW cosine index per
  drizzle 0.31 changelog.
- Migrations in `apps/api/drizzle/`, runner at
  `apps/api/scripts/migrate.ts` invoked on container start.

### Phase 3 — API skeleton (2 days)
- Hono server in `apps/api/src/index.ts` with `new Hono().basePath('/v1')`
  per `lobehub/lobehub` pattern; `app.use('*', cors(), logger())`.
- Subroutes mounted via `app.route('/auth', authApp)` etc. per
  `moeru-ai/arpk`.
- Middleware: request log (pino), JWT verify (cookie), tier check.
- Stub all v1 routes with placeholder handlers.
- Filter translator: JSON spec → parameterized SQL (Drizzle `sql`
  template) via safelisted-fields whitelist.
- In-process worker loop: poll `jobs` every 5s, run pending, retry
  with backoff.

### Phase 4 — Auth (1 day)
- `POST /v1/auth/magic-link` — generate token, write
  `magic_link_tokens`, send via Resend.
- `POST /v1/auth/verify` — exchange token → JWT in HttpOnly cookie
  (`setCookie(c, 'session', jwt, { httpOnly: true, sameSite: 'Lax',
  secure: true, maxAge: 30*86400 })`) per `cablate/banini-tracker` and
  `f/mcp-startup-framework` patterns.
- `GET /v1/me` — verify cookie → return `{ id, email, tier,
  trial_ends_at }`.

### Phase 5 — Sync + Transcribe endpoints (1.5 days)
- `POST /v1/posts/sync` — JSON batch upsert of posts + captures with
  field whitelist + tier-gated scope filter.
- `POST /v1/posts/:id/transcribe` — accept multipart upload, stream
  the file part directly into a Groq fetch:
  `POST https://api.groq.com/openai/v1/audio/transcriptions`,
  `model=whisper-large-v3-turbo`, multipart `file` field. Reference
  `claraverse-space/ClaraVerse` `service.go` for endpoint shape.
- Special case: if request body has `text` field instead of file,
  treat as pre-extracted YouTube caption track; store as
  `source='youtube-captions'`, skip Groq.
- After transcript saved → enqueue `extract` job.

### Phase 6 — Library + aggregates (1 day)
- `GET /v1/library` — pagination + filter spec → SQL.
- `GET /v1/aggregates/hooks?groupBy=hook_type|hook_text&topN=N`.
- `POST /v1/views` / `GET /v1/views` / `GET /v1/views/:id`.

### Phase 7 — Extraction worker (1.5 days)
- `apps/api/src/workers/extract.ts`:
  - Step 1: Groq Llama-3.3-70b-versatile JSON-mode call → emit
    `{ hook_text, hook_type, hook_start_s, hook_end_s,
    middle_summary, cta_text, cta_type, cta_start_s, topics,
    niche_label }`. Prompt enforces enum hook_type/cta_type.
  - Step 2: format classifier — Groq Llama-3.2-11b-vision over
    `cover_url` + speech-density signal from `transcripts.segments`.
  - Step 3: niche assignment — OpenAI text-embedding-3-small (1536
    dims) → pgvector cosine NN over `niche_clusters`. If similarity
    < 0.85 → create new cluster (LLM names it).
- Cap parallelism: 4 concurrent Groq calls.

### Phase 8 — Stripe wiring (1 day, Stripe CLI heavy)

Use Stripe CLI for the entire flow, no Dashboard clicking.

1. **Local setup:**
   ```bash
   stripe login
   ./apps/api/scripts/stripe-bootstrap.sh   # creates products + prices
   ```
2. **npm scripts** (mirror `antoineross/Hikari` `package.json`):
   ```json
   "stripe:login":    "stripe login",
   "stripe:listen":   "stripe listen --forward-to=http://localhost:8787/v1/billing/webhook",
   "stripe:trigger":  "stripe trigger checkout.session.completed",
   "stripe:fixtures": "stripe fixtures apps/api/stripe/fixtures.json"
   ```
3. **Endpoints:**
   - `POST /v1/billing/checkout` — create Stripe Checkout Session,
     return `url`.
   - `POST /v1/billing/webhook` — `stripe.webhooks.constructEvent`
     pattern from `solygambas/python-openai-projects`. Handle:
     `checkout.session.completed`, `customer.subscription.updated`,
     `customer.subscription.deleted` → upsert `users.tier` and
     `current_period_end`.
4. **Production webhook:**
   - `stripe listen` prints `whsec_*` for **dev**.
   - For Railway prod, register an endpoint via Stripe Dashboard or
     `stripe webhook_endpoints create` CLI command, copy resulting
     secret into Railway `STRIPE_WEBHOOK_SECRET` env var.
5. **Free trial:** 7-day, no card required for first cohort
   (`subscription_data[trial_period_days]=7` on checkout creation).

### Phase 9 — Extension refactor (2 days)
- New module `src/lib/api-client.js` (+ `-runtime.js` IIFE mirror).
  Methods: `auth()`, `me()`, `syncPosts(batch)`, `transcribe(postId,
  blob)`.
- New module `src/lib/tier-gate.js` (+ runtime mirror): given
  `tier` + `scope.kind` + `platform` → `{ allowed, reason }`.
- `content.js`: gate capture path; show upgrade overlay if blocked.
- `background.js`: add `cmd: 'api.transcribe'` (SW fetches videoUrl
  with credentials, then posts to backend). Cascade kept behind a
  debug flag.
- `src/dashboard/popup.html` + `popup.js`: login form, tier badge,
  "Upgrade" CTA, sync button.
- Manifest: add YT origins + Railway api/web origins.

### Phase 10 — YouTube Shorts platform (1.5 days)
- `src/lib/parser-youtube.js`, `src/lib/scope-youtube.js`,
  `tests/fixtures/youtube-*.json`, unit tests, manifest, platform
  registry, IIFE mirror.
- `injected.js` extension to intercept `/youtubei/v1/*` per
  `zerodytrash/Simple-YouTube-Age-Restriction-Bypass` `main.js`.
- YouTube caption-track free-transcript path: extension fetches
  `captionTracks[0].baseUrl`, parses XML/VTT → text, posts to
  `/v1/posts/:id/transcribe` as JSON `{ text, source: 'youtube-captions' }`.
- E2E `tests/e2e/stub-youtube-server.mjs` + Playwright spec.

### Phase 11 — Website MVP (2 days)
- Next.js App Router in `apps/web/`, Tailwind + shadcn/ui.
- Pages: `/login`, `/library`, `/hooks`, `/creators`, `/views/[id]`,
  `/billing`.
- Auth: Next reads JWT cookie set by API (same Railway parent domain
  → cookie shared); redirects unauth users to `/login`.
- Library page: filter chip bar emitting filter JSON; sort dropdown;
  table with thumbnail/metrics/hook/CTA; row click → side panel with
  transcript + breakdown.
- Hooks page: aggregation grouped by `hook_type`, sample posts.
- Billing page: Stripe Customer Portal link
  (`stripe.billingPortal.sessions.create`).

### Phase 12 — Observability + safety (½ day)
- Pino structured logs (Railway captures stdout).
- Request id middleware.
- Rate limiting on `/v1/posts/sync` and `/v1/posts/:id/transcribe`
  (memory bucket).
- Soft-cap enforcement: count user's transcriptions in current period;
  402 with "Soft cap reached" message at 2,000.
- Stripe webhook signature verification (already in webhook handler).

### Phase 13 — Tests & deploy (continuous + final)
- Unit: filter-translator, tier-gate, parser-youtube, scope-youtube,
  extraction prompt schemas.
- Integration: API endpoints with a temp Postgres.
- E2E: Playwright against stub IG/TT/YT + stub backend.
- `npm run test:unit` green at every phase boundary.
- Final: `railway up` for both services, `stripe listen` live for
  webhook smoke test, end-to-end manual run.

---

## Risks & open questions

1. **CDN URL freshness on sync.** IG/TT URLs expire fast. Mitigation:
   auto-sync every N captures so uploads happen within freshness window.
2. **Embedding provider.** Recommend OpenAI text-embedding-3-small
   (1536 dims, $0.02/M tokens). Schema uses `vector(1536)` to match.
3. **External keys required:** `JWT_SECRET`, `STRIPE_SECRET_KEY`,
   `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`,
   `STRIPE_PRICE_PRO_FOUNDING`, `RESEND_API_KEY`, `GROQ_API_KEY`,
   `OPENAI_API_KEY`. User must provide.
4. **Niche cluster drift** — v2 reclustering job.
5. **Format classification accuracy** — heuristic (~70–80%); iterate.
6. **GDPR / data retention** — out of scope v1; we don't store MP4s.

---

## Verification criteria

- `npm run test:unit` green after every phase.
- Phase 1: `railway status` shows api + web + postgres up; pgvector
  extension verified via `psql`.
- Phase 4: magic-link round-trip works; `/v1/me` with valid cookie
  returns user.
- Phase 5: posting an MP4 produces a `transcripts` row + queued
  `extract` job within 30s.
- Phase 7: queued extract job produces `extractions` row with
  non-null hook/CTA.
- Phase 8: `stripe trigger checkout.session.completed` fires local
  webhook → user upgraded to `pro` in DB.
- Phase 9: free-tier user on IG Explore sees upgrade overlay; pro
  user captures normally.
- Phase 10: YouTube Shorts capture produces `yt_<id>` post; free path
  via captions; profile-only on free, Shorts feed blocked.
- Phase 11: filter UI emits valid JSON; library responds <500ms at
  100k posts; saved view round-trips.
- Phase 13: full end-to-end on Railway: capture → sync → transcribe →
  extract → website displays hook/CTA → user can upgrade via Stripe
  Checkout.

---

## Steps

1. Create `apps/api` and `apps/web` workspace structure; move existing `web/` skeleton; add root `package.json` workspaces; update `.gitignore`.
2. Run `railway login` then `railway init --name feedsorter` and `railway link` from repo root.
3. Run `railway add --database postgres` then `railway run --service Postgres psql -c "create extension if not exists vector;"`.
4. Run `railway add --service api` and `railway add --service web` with DATABASE_URL and NEXT_PUBLIC_API_URL variables wired.
5. Run `railway domain --service api` and `railway domain --service web`; capture the generated *.up.railway.app domains for env vars and manifest.
6. Set Railway env vars on api: JWT_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_PRO, STRIPE_PRICE_PRO_FOUNDING, RESEND_API_KEY, GROQ_API_KEY, OPENAI_API_KEY.
7. Add Drizzle ORM and write schema in `apps/api/src/db/schema.ts` mirroring Airstrip-AI/airstrip pgvector pattern with `vector('embedding', { dimensions: 1536 })` and HNSW cosine index per drizzle-orm 0.31 changelog.
8. Generate and apply Drizzle migrations; create startup migration runner at `apps/api/scripts/migrate.ts`.
9. Build Hono API skeleton at `apps/api/src/index.ts` mirroring `lobehub/lobehub` pattern: `new Hono().basePath('/v1')` with cors/logger middleware; mount subroutes with `app.route()` per `moeru-ai/arpk`.
10. Implement JWT cookie auth middleware using setCookie pattern from `cablate/banini-tracker` / `f/mcp-startup-framework`.
11. Implement /v1/auth/magic-link, /v1/auth/verify, /v1/me with Resend email integration.
12. Implement filter-spec → parameterized SQL translator with field whitelist; cover all ops listed in plan.
13. Implement /v1/posts/sync (batch upsert) with tier-gated scope filtering server-side.
14. Implement /v1/posts/:id/transcribe: multipart MP4 → stream to Groq Whisper endpoint per `claraverse-space/ClaraVerse` Go reference; also accept JSON `{text, source}` shortcut for YouTube captions.
15. Implement /v1/library (paginated) and /v1/aggregates/hooks (grouped + flat top-N).
16. Implement /v1/views CRUD.
17. Build extraction worker: Groq Llama-3.3-70b JSON-mode call producing structured hook/middle/CTA/topics/niche-label with enum-constrained types.
18. Build format classifier worker: vision-on-cover via Groq Llama-3.2-vision + speech-density signal.
19. Build niche-cluster worker: OpenAI text-embedding-3-small → pgvector cosine NN → assign or create cluster.
20. Run `stripe login`; write and execute `apps/api/scripts/stripe-bootstrap.sh` using `stripe products create` + `stripe prices create` per `stripe-samples/checkout-single-subscription` README to create Pro and Pro Founding prices.
21. Add npm scripts: stripe:login, stripe:listen, stripe:trigger, stripe:fixtures mirroring `antoineross/Hikari` `package.json`.
22. Implement /v1/billing/checkout (Stripe Checkout Session with 7-day trial) and /v1/billing/webhook using `stripe.webhooks.constructEvent` pattern from `solygambas/python-openai-projects`.
23. Test webhook locally with `stripe listen --forward-to` + `stripe trigger checkout.session.completed`; verify users.tier updates.
24. Register production webhook endpoint via Stripe CLI (`stripe webhook_endpoints create`) pointing at Railway api domain; set STRIPE_WEBHOOK_SECRET on Railway.
25. Add rate limiting + soft-cap enforcement on /v1/posts/sync and /v1/posts/:id/transcribe.
26. Add `src/lib/api-client.js` and runtime mirror in extension; update popup with login form + tier badge + sync button.
27. Add `src/lib/tier-gate.js` and runtime mirror; integrate into content.js capture path with upgrade overlay.
28. Replace extension transcription cascade default path with /v1/posts/:id/transcribe call via background SW; keep cascade behind debug flag.
29. Update manifest with YouTube origins and Railway api/web origins.
30. Build YouTube Shorts: parser-youtube.js, scope-youtube.js, platform.js entry, platform-runtime.js mirror, fixtures, unit tests.
31. Extend injected.js to intercept /youtubei/v1/player and /youtubei/v1/next per `zerodytrash/Simple-YouTube-Age-Restriction-Bypass` main.js pattern; capture playerResponse + caption tracks.
32. Add YouTube caption-track free-transcript path: extension parses captionTracks XML/VTT and posts to backend as JSON.
33. Add e2e stub-youtube-server.mjs and Playwright spec.
34. Scaffold Next.js website at apps/web with App Router, Tailwind, shadcn/ui; auth middleware reading JWT cookie.
35. Build /login (magic-link), /billing (Stripe Customer Portal session) pages.
36. Build /library page: filter chip bar, sort dropdown, table with thumbnail/metrics/hook/CTA, side panel with full transcript.
37. Build /hooks page: aggregation grouped by hook_type with sample posts and filter bar.
38. Build /creators page and /views/[id] saved-view page.
39. Add observability: pino logs, request id middleware on api.
40. Run `npm run test:unit` and `npm run test:e2e`; fix regressions; `railway up` both services; smoke test full flow with `stripe listen` live.
