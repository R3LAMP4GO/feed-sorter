# Unified post schema (v1)

Shared row contract for the Feed Sorter family of extensions:

- `feed-sorter-instagram` (this repo)
- `feed-sorter-tiktok` (separate repo)
- `feed-sorter-youtube-shorts` (planned)

All three write to **the same sink** (Airtable / Sheets / Notion / generic
webhook). The dashboard (`src/dashboard/index.html`) reads that sink and
renders a cross-platform outlier feed.

## Row shape

`src/lib/unified.js` is the single source of truth. Every adapter MUST
build rows through `makeUnified({...})` so type coercion and validation
stay in one place.

| Field                    | Type    | Notes                                                                       |
|--------------------------|---------|-----------------------------------------------------------------------------|
| `schemaVersion`          | number  | `1`. Bump on breaking change.                                               |
| `platform`               | string  | `"instagram"` \| `"tiktok"` \| `"youtube_shorts"`.                          |
| `id`                     | string  | Globally-unique-within-platform. Convention: `"<prefix>_<nativeId>"` (e.g. `ig_3247…`, `tt_72…`, `yts_…`). |
| `author`                 | string  | Handle, no leading `@`.                                                     |
| `url`                    | string  | Canonical post URL.                                                         |
| `createTime`             | number  | Unix **seconds** UTC.                                                       |
| `views`                  | number  | `0` if unknown.                                                             |
| `likes`                  | number  |                                                                             |
| `comments`               | number  |                                                                             |
| `shares`                 | number  | `0` on platforms that don't expose it (IG).                                 |
| `saves`                  | number  | `0` on platforms that don't expose it.                                      |
| `durationSec`            | number  | `0` for image posts.                                                        |
| `transcript`             | string  | `""` if not transcribed.                                                    |
| `hookType`               | string  | Free-form tag from each ext's hook classifier.                              |
| `score`                  | number  | Outlier multiple from the **source extension** (per-author median). The dashboard re-computes a per-platform-median score on read. |
| `scoreBasis`             | string  | `"author"` \| `"global"` \| `""`.                                           |
| `sourceExtensionVersion` | string  | `"<prefix>@<semver>"`, e.g. `"ig@0.1.0"`.                                   |
| `capturedAt`             | number  | Unix **milliseconds** when the row was captured.                            |

`makeUnified` enforces non-negative numerics and strips a leading `@`
from `author`. `validateUnified(row)` returns a list of error strings —
adapters should call it in dev to catch silent regressions.

## Airtable table layout (`UnifiedPosts`)

Create a single table in your base. `id` is the primary field and the
upsert merge key.

| Field                    | Airtable type            |
|--------------------------|--------------------------|
| `id`                     | Single line text (primary) |
| `platform`               | Single select (`instagram`, `tiktok`, `youtube_shorts`) |
| `author`                 | Single line text         |
| `url`                    | URL                      |
| `createTime`             | Number                   |
| `createdAt`              | Date (with time, ISO)    |
| `views`                  | Number                   |
| `likes`                  | Number                   |
| `comments`               | Number                   |
| `shares`                 | Number                   |
| `saves`                  | Number                   |
| `durationSec`            | Number                   |
| `transcript`             | Long text                |
| `hookType`               | Single line text         |
| `score`                  | Number                   |
| `scoreBasis`             | Single select (`author`, `global`) |
| `sourceExtensionVersion` | Single line text         |
| `capturedAt`             | Date (with time, ISO)    |
| `schemaVersion`          | Number                   |

The IG extension's Airtable sink writes to **two** tables when
configured: the legacy per-extension table (whatever you set as `table`)
and the unified `UnifiedPosts` table (set via `unifiedTable`, default
`"UnifiedPosts"`). Both upsert on `id` so re-syncing is idempotent.

## Adapter contract for new platforms

Each extension owns one adapter file alongside its parser. The TikTok
adapter, for example, would live at `src/lib/unified-from-tiktok.js`
inside the TikTok repo and look like:

```js
import { makeUnified, PLATFORMS } from "./unified.js"; // copy the file verbatim

export function fromTikTokPost(p, { extensionVersion }) {
  return makeUnified({
    platform: PLATFORMS.TIKTOK,
    id: `tt_${p.aweme_id || p.id}`,
    author: p.author?.unique_id || "",
    url: p.share_url || `https://www.tiktok.com/@${p.author?.unique_id}/video/${p.aweme_id}`,
    createTime: p.create_time,
    views: p.statistics?.play_count,
    likes: p.statistics?.digg_count,
    comments: p.statistics?.comment_count,
    shares: p.statistics?.share_count,
    saves: p.statistics?.collect_count,
    durationSec: p.video?.duration ? Math.round(p.video.duration / 1000) : 0,
    transcript: p.transcript || "",
    hookType: p.hookType || "",
    score: p._score || 0,
    scoreBasis: p._scoreBasis || "",
    sourceExtensionVersion: `tt@${extensionVersion}`,
    capturedAt: p.capturedAt || Date.now(),
  });
}
```

Steps:

1. Copy `src/lib/unified.js` from this repo into the new extension
   verbatim. Do **not** fork the schema — bump `SCHEMA_VERSION` here and
   re-distribute.
2. Write `fromXyzPost(p, ctx)` returning the result of `makeUnified`.
3. In the extension's Airtable sink, push rows through
   `unifiedToAirtableFields` to the same `UnifiedPosts` table. Use the
   same upsert-on-`id` pattern.
4. Run the dashboard against the shared base — rows should appear with
   their `platform` pill.

## Cross-platform outlier scoring

Absolute counts aren't comparable across platforms (TikTok's median
play count is orders of magnitude higher than IG's median like count).
The dashboard re-computes outlier scores on read using
`computeCrossPlatformOutliers(rows, metric)`:

```
score = post[metric] / median(all rows for THIS platform)
```

Same formula as `src/lib/scoring.js`, just baselined per platform
instead of per author. The per-author score from the source extension
is preserved on the row as `score` for reference.

## Verifying

1. In the IG extension settings, configure the Airtable sink with token,
   baseId, and table. Leave `unifiedTable` at its default
   (`UnifiedPosts`) or override.
2. Capture a few posts; press **Sync filtered view now**. Confirm both
   the legacy table and `UnifiedPosts` populate.
3. Repeat from the TikTok extension (once its adapter ships) targeting
   the same base.
4. Open the dashboard via the extension popup → **Open dashboard**.
   Click **Import from IG sink** to copy creds, or paste them manually.
   Both platforms' rows should appear, ranked by per-platform outlier
   score.
