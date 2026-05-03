# Feature Inventory

A complete map of every user-facing feature currently in the extension,
plus a recommendation for **where each one should live** once the web
app (`web/`) is in production.

Legend:

| Symbol | Meaning |
|--------|---------|
| 🟢 | Stays in the extension |
| 🔵 | Moves to the web app |
| 🟡 | Lives in **both** (extension calls it; web app exposes the polished UI) |
| 🔴 | Delete / deprecate |

Tier column reflects what we should charge for:

| Tier   | Price guess     | What unlocks |
|--------|-----------------|--------------|
| Free   | $0              | Extension capture + 30-day history + BYO-Ollama |
| Pro    | $19–29 / mo     | Hosted AI, unlimited history, watchlists, scheduled exports |
| Team   | $99–199 / mo    | 3 seats, shared workspace, Slack/Discord digests |

---

## 1. Capture (data ingestion)

| Feature | Location now | Where it should live | Tier | Notes |
|---|---|---|---|---|
| Intercept Instagram feed/profile/reels/explore APIs | `injected.js` + `content.js` | 🟢 Extension only | Free | Cannot be done anywhere else — MV3 main-world hook is the moat. |
| Intercept TikTok profile/foryou/explore/related APIs | `injected.js` + `src/lib/parser-tiktok.js` | 🟢 Extension only | Free | Same. |
| Auto-scroll harvester ("Collect all") | `content.js` `startCollect()` | 🟢 Extension only | Free | Triggers the page's own pagination. Surface a button + progress in overlay. |
| Per-page scope detection (profile / reels / explore / foryou) | `src/lib/scope.js`, `scope-tiktok.js`, `platform-runtime.js` | 🟢 Extension only | Free | Tells the rest of the system what the user is looking at. |
| Unified row schema (`makeUnified`) | `src/lib/unified.js` | 🟡 Both | Free | Same code on both sides. Web app uses the typed mirror at `web/src/lib/unified.ts`. |
| Bulk POST to `/api/ingest` | (not built yet) | 🟢 Extension calls 🔵 Web app | Free | New: extension fires every batch through the bridge. |

---

## 2. Storage

| Feature | Location now | Where it should live | Tier | Notes |
|---|---|---|---|---|
| Local IndexedDB (`feed-sorter`, v5) | `src/store.js` | 🟡 Both (extension as cache, web as source of truth) | Free | Keep IDB so the overlay works offline and on slow networks. Treat it as a write-through cache to the server. |
| Posts store (~50 fields) | `src/store.js` `posts` | 🔵 Postgres (`posts` table in `web/`) | Free / Pro for >30d | History retention is the easiest paywall lever. |
| Creators / niche store | `src/store.js` `creators` | 🔵 Postgres | Pro | Watchlists need a server anyway (cron). |
| Audio (sounds) store | `src/store.js` `audio` | 🔵 Postgres | Pro | Trending sound rollup is server work. |
| Voice fingerprint store | `src/store.js` `voice` | 🔵 Postgres | Pro | One row per creator, used by Repurpose. |
| Rewrites cache | `src/store.js` `rewrites` | 🔵 Postgres | Pro | Tied to LLM output — server owns this once hosted AI is on. |
| Pipeline steps log | `src/store.js` `pipeline_steps` | 🔵 Postgres | Pro | Audit trail for the Repurpose pipeline. |
| Signals (cross-creator hook reuse) | `src/store.js` `signals` | 🔵 Postgres | Pro | Real-time alerts need a server. |

---

## 3. Sorting · filtering · grouping

All of this is currently in `content.js` overlay. None of it is **moat**;
all of it is much nicer with a real UI.

| Feature | Location now | Where it should live | Tier |
|---|---|---|---|
| Sort: outlier score | overlay + `src/lib/scoring.js` | 🔵 Web app | Free |
| Sort: velocity (views/hr) | overlay | 🔵 Web app | Free |
| Sort: likes / views / comments / CPR / recent | overlay | 🔵 Web app | Free |
| Group by: status / hookType / topic / angle / coverWinRate | overlay | 🔵 Web app | Free |
| Outlier metric picker | overlay | 🔵 Web app | Free |
| Search captions / @authors | overlay | 🔵 Web app | Free |
| Surface filter (profile / reels / explore) | overlay | 🟢 Extension (page-scoped) + 🔵 Web (cross-session) | Free |
| Date range filter | overlay | 🔵 Web app | Free |
| Limit (25/50/100/…) | overlay | 🔵 Web app | Free |
| Data scope (session vs all-time) | overlay | 🔴 Becomes obsolete once server is the source of truth | — |
| Status filter (idea / drafted / posted / skip) | overlay | 🔵 Web app | Free |
| "Has note / transcript / AI" filter | overlay | 🔵 Web app | Free |
| Cover-attribute chips (Has face / Text overlay / Closeup / Text-heavy) | overlay (removed on `explore-only`) | 🔵 Web app | Pro (depends on cover analysis) |
| Hashtag / hookType / topic / angle chips | overlay | 🔵 Web app | Pro |
| Pinned-only filter | overlay | 🔵 Web app | Free |

---

## 4. Per-row actions

| Feature | Location now | Where it should live | Tier |
|---|---|---|---|
| Pin post | overlay | 🟡 Both (sync via API) | Free |
| Set status (idea / drafted / posted / skip) | overlay | 🟡 Both | Free |
| Add note / tags | overlay | 🟡 Both | Free |
| Open original on platform | overlay | 🟡 Both | Free |
| Download video | overlay → `background.js` `download` | 🟢 Extension (CORS + cookie auth) | Free |
| Download audio | overlay → `background.js` | 🟢 Extension | Free |
| Copy URL / CSV / batch copy | overlay | 🔵 Web app | Free |
| Compare 2–3 posts side-by-side | overlay (modal) | 🔵 Web app **only** | Free |

---

## 5. Local AI analysis (Ollama / Gemma)

Currently all run in the content script via `chat()` → background → Ollama.
**This is the biggest "should-it-move?" question.** Two answers:

- **Power users (BYO Ollama)**: keep it triggerable from the extension *and* the web app via a local-AI toggle. Privacy moat.
- **Everyone else**: hosted AI on the web app. Charge for it. Most users will never run Ollama.

| Feature | Location now | Where it should live | Tier |
|---|---|---|---|
| Hook fingerprint (text classifier) | `src/lib/hooks.js` + `src/analysis/post-analysis.js` | 🟡 Both, but UI on web | Pro (hosted) / Free (BYO) |
| Cover diagnosis (face / text / composition) | `src/analysis/cover-analysis.js` (vision model) | 🔵 Web app | Pro |
| Outlier diagnosis (why did this hit?) | `src/analysis/diagnose.js` | 🔵 Web app | Pro |
| Voice fingerprint per creator | `src/analysis/voice-fingerprint.js` | 🔵 Web app | Pro |
| Rewrites (caption variations, hooks, scripts) | `src/analysis/rewrite.js` | 🔵 Web app | Pro |
| Niche auto-clustering (MiniLM embeddings) | `background.js` + `src/lib/cluster.js` + `offscreen.js` | 🔵 Web app | Pro |
| AI cache | local IDB | 🔵 Postgres | Pro |
| AI health / endpoint settings | overlay Settings tab | 🔵 Web app (account settings) | — |

---

## 6. Repurpose pipeline

The "✨ Repurpose top N" button runs: download → transcribe → diagnose →
rewrite → README. This is a long-running multi-stage job — terrible fit
for an extension service worker (30s idle kill), perfect fit for a
server queue.

| Feature | Location now | Where it should live | Tier |
|---|---|---|---|
| Pipeline orchestrator | `src/pipeline.js` + `src/lib/pipeline-runtime.js` | 🔵 Web app (server job) | Pro |
| Per-step progress UI | overlay modal | 🔵 Web app | Pro |
| Pipeline step audit log | IDB `pipeline_steps` | 🔵 Postgres | Pro |
| Bulk actions (download / audio / transcribe / rewrite where score ≥ N) | overlay footer | 🟡 Both — extension handles raw downloads, server handles transcribe/rewrite | Pro |

---

## 7. Transcription

| Feature | Location now | Where it should live | Tier |
|---|---|---|---|
| faster-whisper sidecar (Python, port 8787) | `sidecar/transcribe-server.py` | 🟡 Both — keep as BYO option, also offer hosted | Pro / Free (BYO) |
| Per-row "Transcribe" action | overlay row | 🟡 Both | Pro / Free (BYO) |
| Sidecar health check | overlay Settings | 🔵 Web app account settings | — |

---

## 8. Exports & sinks

| Feature | Location now | Where it should live | Tier |
|---|---|---|---|
| CSV export (current view) | overlay | 🔵 Web app | Free |
| CSV export (selected) | overlay | 🔵 Web app | Free |
| PDF report | `src/lib/report.js` (jsPDF) | 🔵 Web app | Pro |
| Google Sheets sink | `src/sinks/sheets.js` | 🔵 Web app | Pro |
| Airtable sink | `src/sinks/airtable.js` | 🔵 Web app | Pro |
| Notion sink | `src/sinks/notion.js` | 🔵 Web app | Pro |
| Generic webhook | `background.js` `webhook-post` | 🔵 Web app | Pro |
| Slack digest (top 5) | `background.js` `sendTopToSlack` | 🔵 Web app | Pro |
| Discord digest (top 5) | `background.js` | 🔵 Web app | Pro |
| Auto-sync on `collect.end` | `background.js` `runAutoOnCollect` | 🔵 Web app (server cron) | Pro |
| Weekly digest | `background.js` `sendWeeklyDigest` | 🔵 Web app (server cron) | Pro |

---

## 9. Cross-creator features (require server in practice)

| Feature | Location now | Where it should live | Tier |
|---|---|---|---|
| Outlier Radar (cross-creator ranked feed) | `content.js` `renderRadar` | 🔵 Web app | Pro |
| Signals (cross-creator hook reuse alerts) | `content.js` + `background.js` `notify-signal` | 🔵 Web app | Pro |
| Niche tab (track creators, auto re-scrape) | `content.js` + `background.js` alarm | 🔵 Web app | Pro |
| Rescrape stale | `background.js` `rescrape-stale` | 🔵 Web app cron | Pro |
| Compare creators (2–3 side-by-side) | overlay | 🔵 Web app | Pro |

---

## 10. Settings (currently the Settings tab)

Every one of these moves to **/account** or **/workspace/settings** on the
web app. The Settings tab in the overlay should die.

| Setting | Notes |
|---|---|
| Outlier Radar defaults (min score / range / limit) | per-user preferences |
| Signals thresholds | per-user |
| Bulk download → ZIP toggle | per-user |
| Transcription sidecar URL | per-user (BYO) |
| Local AI endpoint / model / vision model / concurrency | per-user (BYO) |
| AI cache clear | account action |
| My voice (handle) | per-user |
| Storage stats | account dashboard |
| Outbound webhooks (Generic / Slack / Discord) | per-workspace |
| Sinks (Sheets / Airtable / Notion creds) | per-workspace |

---

## 11. UX / overlay chrome

| Feature | Location now | Where it should live | Tier |
|---|---|---|---|
| Floating overlay panel | `content.js` + `overlay.css` | 🟢 Extension (much smaller) | Free |
| Tabs (Current / Sounds / Niche / Settings) | overlay | 🔴 Delete (only Current survives) | — |
| Stats summary (post count, authors) | overlay | 🟡 Both | Free |
| Logs panel (debug / info / warn / error) | overlay | 🟢 Extension only (debugging tool) | Free |
| Keyboard shortcuts (j/k/o/d/x/p/c/s/?) | overlay | 🟢 Extension | Free |
| Help / cheat sheet | overlay modal | 🟢 Extension | Free |
| Share view link | overlay | 🔵 Web app (real share URLs) | Free |
| Modal system (compare / rewrites / pipeline) | overlay | 🔵 Web app | Pro |

---

## 12. Account / billing (new, web app only)

None of this exists yet.

| Feature | Tier |
|---|---|
| Sign-up / sign-in (Clerk or Auth.js) | Free |
| API key for the extension (`Authorization: Bearer …`) | Free |
| Stripe checkout & customer portal | Pro / Team |
| Usage meter (AI tokens, transcription minutes) | Pro |
| Workspace + invites | Team |
| Audit log | Team |

---

## Recommended target shape

**Extension** (≤ 500 lines of UI, no AI, no settings):

- Overlay shows: scope badge, post count, "Collect all", "Stop", "Open dashboard ↗".
- Per-row quick actions: pin, status, download, open.
- POSTs every harvest batch to `/api/ingest`.
- Service worker handles only: downloads, BYO-Ollama proxy, BYO-Whisper proxy.

**Web app** (everything else):

- Dashboard: sortable/filterable/groupable cross-platform table.
- Compare view (2–3 posts).
- Outlier Radar.
- Watchlists & Signals (server cron).
- Repurpose pipeline.
- Exports (CSV, PDF, Sheets, Airtable, Notion, webhooks).
- Account, billing, workspace.

**Sidecar** (unchanged — for BYO power users):

- `sidecar/transcribe-server.py` keeps running locally. Web app calls it
  via the extension if the user toggles "Use my local sidecar".

---

## Decision checklist (use this when adding a new feature)

1. **Does it need to read the page DOM or intercept network?** → Extension.
2. **Does it need to run for >30 seconds, or on a schedule?** → Web app.
3. **Does it need to be shared across devices or seats?** → Web app.
4. **Is it a cosmetic chrome thing on top of the IG/TT page?** → Extension.
5. **Would I want to charge money for it?** → Web app, behind Stripe.
6. **Is it complex UI (tables, side-by-side, charts)?** → Web app.
7. **None of the above clearly true?** → Default to web app. Extensions
   are a worse place to ship UI: smaller surface, harder to debug,
   slower iteration, no SEO.
