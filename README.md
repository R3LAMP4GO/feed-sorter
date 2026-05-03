# Feed Sorter (Instagram + TikTok)

MV3 extension. Captures posts from **Instagram** (profile feed, profile
reels, Explore grid) **and TikTok** (profile, For You, Explore, related),
then sorts by likes / views / comments / **outlier score** (post metric ÷
that author's median across loaded posts).

## Load it

1. `chrome://extensions` → enable Developer mode.
2. **Load unpacked** → select this folder.
3. Open **instagram.com** or **tiktok.com**. Scroll a profile, Reels tab,
   `/explore/`, the For You feed, etc. The overlay accumulates posts as the
   site's own JSON APIs fire. The active platform is auto-detected from the
   host — same UX, same overlay.

## Surfaces captured (Instagram)

| Endpoint                                 | Surface  |
|------------------------------------------|----------|
| `/api/v1/feed/user/...`                  | profile  |
| `/api/v1/clips/user/`                    | reels    |
| `/api/v1/discover/web/explore_grid/`     | explore  |
| `/graphql/query` (best-effort tree walk) | graphql  |

## Surfaces captured (TikTok)

| Endpoint                          | Surface  |
|-----------------------------------|----------|
| `/api/post/item_list/`            | profile  |
| `/api/recommend/item_list/`       | foryou   |
| `/api/explore/item_list/`         | explore  |
| `/api/related/item_list/`         | related  |

Post ids are namespaced as `ig_<pk>` / `tt_<id>` so rows from both
platforms can coexist in the same IndexedDB and the cross-platform
dashboard.

The parser is intentionally schema-agnostic — it walks any captured JSON
tree and harvests every object that looks like an IG media (has `pk`/`id`
+ a stat field + a shortcode/media_type). This survives most IG schema
drift but won't pick up new fields you can't see — open DevTools → Network
on a failing surface and inspect the response.

## Notes

- Explore often returns `like_count: null` (IG hides it for many posts).
  Outlier score works best on profile feeds where stats are populated.
- Records get **merged** by media id, so a post seen in Explore and then
  in its author's profile keeps the richer stats.
- Profile only / no home feed by design (matches the spec target).

## Caveat

Scraping Instagram violates their ToS. This is for personal use at your
own risk.

## Local AI setup (Ollama + Gemma)

The extension's AI features (caption rewrites, hook fingerprinting, cover
analysis, diagnostic) all run against a **local** Ollama server. No cloud
APIs, no API keys, nothing ever leaves your machine.

### 1. Install Ollama

macOS:

```sh
brew install ollama
ollama serve            # listens on http://localhost:11434
```

Linux / WSL (one-liner installer):

```sh
curl -fsSL https://ollama.com/install.sh | sh
ollama serve
```

### 2. Pull a model

The extension defaults to `gemma4`. If that tag isn't published yet, fall
back to `gemma3` — both are wired up the same way:

```sh
# Preferred (when available):
ollama pull gemma4

# Fallback today (multimodal variants — pick whichever fits your RAM):
ollama pull gemma3:4b      # ~3 GB, fastest, 8 GB RAM ok
ollama pull gemma3:12b     # ~8 GB, recommended for 16 GB+ machines
ollama pull gemma3:27b     # ~17 GB, best quality, 32 GB+ machines
```

If you pulled `gemma3` instead, open the extension overlay → Settings →
**Local AI (Ollama)** and change the **Model** field from `gemma4` to
whichever tag you pulled (e.g. `gemma3:12b`). The **Vision model** field
can be set to a different tag if you want to route image-bearing calls to
a larger multimodal variant (e.g. text → `gemma3:4b`, vision → `gemma3:12b`).

### 3. Verify the server is up

```sh
curl http://localhost:11434/api/tags
# => { "models": [ { "name": "gemma3:12b", ... }, ... ] }
```

The pulled model should appear in the list. If not, re-run the pull.

### 4. Sanity-check generation (optional)

```sh
ollama run gemma4         # or `ollama run gemma3:12b`
>>> say hi in five words
```

### 5. Wire it into the extension

Open any Instagram page → click the Feed Sorter overlay → **Settings** tab
→ scroll to **Local AI (Ollama)**:

- **Endpoint URL** — defaults to `http://localhost:11434`.
- **Model** — defaults to `gemma4`. Set to your pulled tag.
- **Vision model** — defaults to the same; override only if you pulled a
  separate vision-capable variant.
- **Concurrency** — defaults to `2`. Local Ollama on consumer hardware can
  OOM with too many parallel requests; bump cautiously.
- Click **Check** — a green ✓ + model count means the extension can talk to
  Ollama. Hover the indicator to see the full model list.
- **Clear AI cache** drops every cached LLM response (each call is keyed by
  `(model, promptHash)` so identical re-asks return instantly).

All AI calls are logged at info level: `llm.call.start { model, kind, postId? }`
and `llm.call.end { durationMs, tokensIn, tokensOut, cached }`. Errors log at
warn level.

## Audio transcription (faster-whisper sidecar)

The extension can transcribe downloaded reels by POSTing the video blob to a
small local Python server. The server is *opt-in* and *local-only* — nothing
leaves your machine.

### Setup

```bash
cd sidecar
python3 -m venv .venv && source .venv/bin/activate   # optional but recommended
pip install -r requirements.txt
python transcribe-server.py
```

Defaults: model `small`, device `cpu`, `compute_type=int8`, listening on
`http://127.0.0.1:8787`. Override with `FS_WHISPER_MODEL=base`,
`FS_WHISPER_PORT=9000`, `FS_WHISPER_DEVICE=cuda`, etc.

First call downloads the model (~460 MB for `small`) into the
`faster-whisper` cache; subsequent calls reuse it.

### Endpoints

- `GET /health` → `{ok, model, device, loaded, ...}`. Used by the extension's
  Settings tab to display a status pill.
- `POST /transcribe` (multipart `file=<mp4>`, optional `language`, `model`) →
  `{ok, text, language, duration, segments: [{start, end, text}], elapsed_ms}`.

### Using it from the overlay

1. Open Settings → **Transcription sidecar**. The status pill turns green
   when `/health` answers.
2. Per row: click the 🎙️ button (visible whenever the post has a
   `videoUrl`). The drawer expands and the transcript renders with
   `[m:ss → m:ss]` timestamps once the sidecar replies.
3. Bulk: footer → **🎙️ Transcribe outliers ≥ N×** transcribes every video
   in the current view whose outlier score is ≥ N (shares the threshold
   input with the download button). Concurrency is hard-capped at 2 so the
   sidecar stays responsive.
4. Filter: enable the **🎙️ Has transcript** chip. The main search box
   already searches transcript text alongside captions, @authors, notes
   and tags.

Transcripts are persisted on the post row in IndexedDB (fields
`transcript`, `transcriptSegments`, `transcriptLang`, `transcriptModel`,
`transcriptAt`) and survive re-ingest of the same post id.

## Direct sinks (Sheets / Airtable / Notion)

Settings tab → **Direct sinks** lets you push the *current filtered view*
straight into a content-pipeline tool. Each sink has the same controls:

- **Enable** — turns the sink on so auto-sync can fire.
- **Credentials** — sink-specific (URL, token, base id, …).
- **Test** — verifies auth/reachability without sending real rows.
- **Sync filtered view now** — pushes every row currently visible (after
  search, surface, range, limit, hashtag and audio filters).
- **Auto-sync on collect.end** — when the auto-collector finishes a run,
  the *delta* (newly captured rows that match the current view) is pushed
  to every enabled sink with this toggle on.

Progress is shown live as `synced N/M · ✓ok ✗fail` in the status line of
each sink, and per-sink errors land in the log panel as
`sink.<name>.sync.done`.

### 1. Google Sheets (no OAuth)

You deploy a tiny Apps Script as a **web app** ("execute as me", "anyone
with the link"). The extension POSTs `{rows: [...]}` to the deployment URL
and the script appends to a sheet you control. No tokens leave the page.

**Setup**

1. Create a Google Sheet. Add a header row matching the keys in `rows`:
   `id, shortcode, author, desc, url, cover, videoUrl, surface, likes,
   views, comments, score, createdAt`.
2. Extensions → Apps Script. Replace `Code.gs` with:

   ```javascript
   const SHEET_NAME = 'Posts'; // tab name to append to

   function doPost(e) {
     const data = JSON.parse(e.postData.contents || '{}');
     const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_NAME)
       || SpreadsheetApp.getActive().insertSheet(SHEET_NAME);
     if (data.test) {
       return ContentService.createTextOutput(JSON.stringify({ ok: true, test: true }))
         .setMimeType(ContentService.MimeType.JSON);
     }
     const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn() || 1).getValues()[0];
     const headers = headerRow && headerRow[0] ? headerRow : [
       'id','shortcode','author','desc','url','cover','videoUrl',
       'surface','likes','views','comments','score','createdAt',
     ];
     if (sheet.getLastRow() === 0) sheet.appendRow(headers);
     const rows = (data.rows || []).map(r => headers.map(h => r[h] !== undefined ? r[h] : ''));
     if (rows.length) {
       sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
     }
     return ContentService.createTextOutput(JSON.stringify({ ok: true, appended: rows.length }))
       .setMimeType(ContentService.MimeType.JSON);
   }
   ```

3. Deploy → New deployment → **Web app** → Execute as: *Me*, Who has
   access: *Anyone with the link*. Copy the `/exec` URL.
4. Paste the URL into Settings → Direct sinks → Google Sheets → press
   **Test** (you should see `ping ok (200)`).

This script is **append-only** — re-syncing the same view will create
duplicate rows. Add a `=UNIQUE(A:A)` helper sheet if you care.

### 2. Airtable

1. In Airtable, create a base + table. Add these fields (case-sensitive):

   | Field      | Type             |
   |------------|------------------|
   | `id`       | Single line text *(merge key — required)* |
   | `shortcode`| Single line text |
   | `author`   | Single line text |
   | `desc`     | Long text        |
   | `url`      | URL              |
   | `cover`    | Attachment       |
   | `coverUrl` | URL              |
   | `surface`  | Single select (options: `profile`, `reels`, `explore`, `graphql`) |
   | `likes`, `views`, `comments`, `score` | Number |
   | `createdAt`| Date (with time, ISO accepted) |

2. Create a [Personal Access Token](https://airtable.com/create/tokens)
   with `data.records:read`, `data.records:write` scopes on the base.
3. Paste the token, base id (`appXXXXXX…`), and table name into Settings.
   Press **Test** — expects `auth ok (200)`.
4. **Sync now** uses Airtable's `performUpsert` with `fieldsToMergeOn: ["id"]`
   so re-syncing the same view does **not** create duplicates. Records are
   sent in batches of 10 at ≤ 5 req/s with exponential backoff on 429/5xx.

### 3. Notion

1. Create an internal integration → copy the secret token.
2. Create a database with these properties (case-sensitive): `Name`
   (Title), `Author`, `Caption`, `id` (all Text), `URL` (URL), `Likes`,
   `Views`, `Comments`, `Score` (all Number), `Surface` (Select), `Date`
   (Date).
3. In the database, *Share* → invite your integration so it can write.
4. Copy the database id (the 32-char hex from the database URL — drop the
   dashes).
5. Paste token + database id into Settings → Notion → press **Test**.
6. **Sync now** posts one page per row at ≤ 3 req/s. Notion has no upsert
   primitive — re-syncing the same view *will* create duplicate pages.
   Filter the view (search, limit, surface, date) before pressing sync.

## Cross-platform unified dashboard

The IG, TikTok, and (future) YouTube Shorts extensions all share a single
row contract — see [`docs/UNIFIED_SCHEMA.md`](docs/UNIFIED_SCHEMA.md). Both
tables go to the same Airtable base:

- `Posts` (or whatever you set as `table`) — legacy per-extension shape.
- `UnifiedPosts` (configurable via `unifiedTable`, default name shown) —
  the shared cross-platform shape (`platform`, `views`, `likes`, `shares`,
  `saves`, `score`, `hookType`, `transcript`, ...).

Both tables are upserted on `id` so re-syncing is idempotent.

### Open the dashboard

Click the Feed Sorter toolbar icon → **Open cross-platform dashboard**.
The dashboard:

- reads `UnifiedPosts` directly from Airtable (token stored locally under
  `chrome.storage.local` key `fs.dashboard`),
- renders one combined outlier feed across every platform,
- re-computes outlier scores using a **per-platform median** so a TikTok
  post with 1M views isn't trivially out-ranked by an IG post with 50K
  likes (the absolute scales don't match, the multiples-vs-platform-median
  do).

Click **Import from IG sink** in Settings to copy the token + base id
from the IG extension's existing Airtable sink config.

### Migration path: Airtable → self-hosted Postgres

Airtable's free tier caps at 1,000 records per base; the Team plan caps
at 50,000. If you outgrow that:

1. Spin up Postgres locally (`brew install postgresql` or
   `docker run -p 5432:5432 -e POSTGRES_PASSWORD=fs postgres:16`).
2. Create the table:

   ```sql
   CREATE TABLE unified_posts (
     id            TEXT PRIMARY KEY,
     platform      TEXT NOT NULL,
     author        TEXT,
     url           TEXT,
     create_time   BIGINT,
     views         BIGINT DEFAULT 0,
     likes         BIGINT DEFAULT 0,
     comments      BIGINT DEFAULT 0,
     shares        BIGINT DEFAULT 0,
     saves         BIGINT DEFAULT 0,
     duration_sec  INT    DEFAULT 0,
     transcript    TEXT,
     hook_type     TEXT,
     score         REAL   DEFAULT 0,
     score_basis   TEXT,
     source_ext_version TEXT,
     captured_at   BIGINT,
     schema_version INT NOT NULL DEFAULT 1
   );
   CREATE INDEX ON unified_posts (platform, create_time DESC);
   CREATE INDEX ON unified_posts (platform, score DESC);
   ```

3. Stand up a tiny Express receiver that mirrors the Sheets webhook
   contract (`POST /sync` accepting `{ rows: [...] }`, upserting on `id`
   via `INSERT ... ON CONFLICT (id) DO UPDATE`). Re-use the existing
   generic webhook sink in the extension — no code changes needed; just
   point the URL at `http://localhost:3000/sync`.
4. Port the dashboard's Airtable client (`airtableList` in
   `src/dashboard/dashboard.js`) to call your Express read endpoint
   instead. Everything downstream of `state.rows` already operates on
   the unified shape.
5. One-time backfill: dump every Airtable row via the Airtable API and
   `INSERT ... ON CONFLICT DO NOTHING` into Postgres.

The schema version field exists so future migrations can detect older
rows and run lazy upgrades.

### Privacy

All sink credentials live only in `chrome.storage.local` on your device.
HTTP requests are routed through the extension's background service
worker (`credentials: "omit"`) so neither your IG cookies nor `Referer`
ever leak to Sheets / Airtable / Notion.
