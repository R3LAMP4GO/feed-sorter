# Feed Sorter — Full Feature Inventory

This document is an exhaustive map of every user-facing feature currently
shipped in the IG/TikTok overlay (`content.js` + `overlay.css`), the popup
dashboard (`src/dashboard/`), the service worker (`background.js`), and the
local sidecars (Ollama, faster-whisper). It exists so we can audit what is
actually used vs. what is noise.

Legend: **🟢 core** (most users hit this) · **🟡 power** (useful but niche) ·
**🔴 fringe** (debatable; UI cost > value) · **⚙ infra** (settings/wiring).

---

## 1. Header (overlay top bar)

| Control | What it does | Tier |
|--|--|--|
| `Feed Sorter · IG · <scope>` | Title — shows platform + page-scope (profile/explore/foryou) | 🟢 |
| 📡 Radar | Opens the **Outlier Radar** floating panel (cross-creator outliers from IDB, all-time) | 🟡 |
| 📄 Report | Generates a **PDF profile report** (jspdf) — only visible on a profile page | 🔴 |
| 🔗 Share | Copies a `#hash`-encoded view link (sort/filter state is serialized to URL) | 🟡 |
| ❓ Help | Keyboard-shortcut cheat sheet | 🟢 |
| – Collapse | Minimizes overlay | 🟢 |
| ⟳ Re-scan | Clears in-mem `posts` and re-pulls page | 🟢 |

---

## 2. Tabs

The overlay has **4 tabs**. Default active = `current`. (Down from 7 —
Pinned, Patterns, and Signals were folded into other surfaces.)

1. **Current** — main list (sort + filter + rows). 🟢
2. **Sounds** — trending audio aggregation (TT-heavy; IG only has audio when reels expose it). 🟡
3. **Niche** — tracked-creator watchlist (per-creator stats, voice fingerprint, auto-cluster, auto-rescrape). 🟡
4. **Settings** — config, organised as an accordion (see §9). ⚙

**Header bell (🔔 Signals)** — replaces the old Signals tab. Visible only
when there are stored signals or notify is on. Click → floating drawer
with filters + rescan/clear. Unread count rendered as a badge.

**Pinned** is now exclusively the `📌 Pinned only` chip on Current
(legacy `view=pinned` shareable links auto-coerce to that). **Patterns**
is now a `Hook × Topic clusters` block inside the Stats panel.

---

## 3. Sort & Filter (Current tab)

### Sort by
`outlier`, `velocity (views/hr)`, `likes`, `views`, `comments`,
`cpr (comments/1k likes)`, `recent`. **7 options.** 🟢

### Group by (sibling control)
`none`, `status`, `hookType`, `topic`, `angle`, `coverWinRate`. When
active, the row list is pre-sorted by the group key and a section
header (`.fs-group-h`) is emitted between groups. The `Limit` slice is
applied **before** grouping so high-N groups can’t crowd out low-N
groups below the cap.

### Outlier metric
`likes | views | comments | velocity` — what the outlier ratio divides by. 🟢

### Filter row
- **Search** (captions, @authors, transcripts, notes, tags). 🟢
- **Surface** (all / profile / reels / explore). 🟢
- **Date range** (all / 1w / 1m / 3m / 6m / 1y). 🟢
- **Limit** (0 / 25 / 50 / 100 / 200 / 1000). 🟢
- **Data scope** (`session` vs `alltime` IDB). 🟢

### Filter chips / selects (compact strip below dropdowns)
- **📌 Pinned only** chip
- **Status** select — any / Idea / Drafted / Posted / Skip
- **Has** select — any / Note / Transcript / Analysis (single value;
  drives the underlying `hasNote` / `hasTranscript` / `hasAi` booleans
  so `filtered()` is unchanged)
- **More…** disclosure (cover-vision filters): 😊 Has face / 🅱️
  Text overlay / 🔍 Closeup / 📝 Text-heavy
- Dynamic chips (only when an AI filter is active): `hook` / `topic` /
  `angle` / `#tag`

---

## 4. Stats sidebar

`<details>` block ("📊 Stats") above the list. Aggregations:
- counts (posts / authors / analyzed)
- top hooks / top topics / top angles (LLM-derived, click to filter)
- "Analyze top N" button (bulk hook+topic+angle pass with Ollama)
- "Diagnose top N outliers" (multimodal cover diagnosis)
- "Analyze covers top N" (face/composition vision)

🟡 — useful, but overlaps with the **Patterns** tab and the dynamic chips.

---

## 5. Pinned drawer

`<details>` ("📌 Pinned · N") between stats and list. 🔴 — duplicates the
**Pinned tab** _and_ the **Pinned only** chip. Three entry points for the
same data.

---

## 6. Row (per post)

Each row in Current renders:
- thumbnail (hover-to-preview video if `videoUrl`)
- author handle + age + surface badge
- caption (truncated)
- stat strip: ❤ likes · ▶ views · 💬 comments · ⚡ velocity · 🎯 outlier ×
- action buttons (right side):
  - **📌 pin/unpin**
  - **⬇ download** (single)
  - **🎙️ transcribe** (sidecar)
  - **🧠 analyze** (hook+topic+angle, Ollama)
  - **🅱 cover** (vision: face/text-overlay/closeup)
  - **🔬 diagnose** (multimodal: why this post outlier'd)
  - **✍ repurpose** (4-platform rewrites)
  - **expand** (note/tag/status editor)
- expanded panel: note · tags · status (idea/drafted/posted/skip) · transcript · AI panel

🟢 thumbnail/stats/expand. 🟡 transcribe/analyze/repurpose/diagnose. 🔴 cover.

---

## 7. Batch bar

Appears when ≥1 row selected. Buttons: **Download · Compare · CSV · Copy
URLs · Clear · Select all visible · Select none**. 🟢

---

## 8. Footer

Footer crams **5 grouped controls** into a single horizontal strip:

1. **Collect all** / **Stop** / **CSV** — base footer. 🟢
2. **✨ Repurpose top N** — pipeline (download → transcribe → diagnose → rewrite → README per post). 🟡
3. **Download outliers ≥ N×** + threshold input + cancel. 🟢
4. **🎙️ Transcribe outliers ≥ N×** + cancel. 🟡
5. **✍ Repurpose top N** + topN input. 🟡 *(plain rewrite — different from button 2 which is the full pipeline. Naming collision is a known pain point.)*

This footer is the densest area of the UI and the source of most confusion.

---

## 9. Per-tab panels

### Sounds panel
- chips: `Original sounds only`, `Music only`, `Min uses ≥ 3`
- **⟳ Recompute** trending
- "Filtering by sound: …" cleared via ×
- list rows: tag (orig/music) · title · artist · ▶ uses · `med ×` · `growth %`

### Signals panel
- inputs: `Min similarity`, `Min historical score`, `Max age (days)`
- chip: `Unread only`
- **⟳ Rescan** / **Clear**
- rows: new-post ↔ historical-outlier pair with similarity %, mark-as-read


### Niche panel
- bar: `+ Add current profile` · `Re-scan stale` · `⚙ Auto-cluster`
- manual add row: `@username` + niche label + Add
- batch bar: `Compare 2-3 selected` · `Clear`
- per-creator row: select · @name · 📌 niche-pin · last-scrape age · ⟳ rescan · 📄 PDF report · ✕ remove · post count + median likes · 🎙 voice fingerprint button + meta · niche label / interval / auto checkbox

### Settings panel (accordion — each section is a `<details class="fs-set-section">`; first section open by default)
1. **Outlier Radar defaults** — minScore / radarRange / radarLimit
2. **Signals** — notify / minSim / minHistScore / maxAgeDays
3. **Bulk download** — bulkZip toggle (JSZip)
4. **Transcription sidecar** — URL · status · Check
5. **Local AI (Ollama)** — endpoint · model · vision model · concurrency · status · Check · Clear cache
6. **My voice (for repurpose)** — IG handle
7. **Storage** — IDB usage info
8. **Outbound webhooks** — Generic / Slack / Discord URLs · auto-on-collect · Test ping · Send view · Send top-5 to Slack · Send top-5 to Discord · Run weekly digest now
9. **Direct sinks** — Sheets / Airtable / Notion (each a nested `<details>`: enable · creds · auto-on-collect · Test · Sync now)

### Per-row buttons
`📍 pin` · `⬇ download video` · **`🎵 download audio`** (new — disabled
when `audio.downloadUrl` is empty, e.g. licensed IG music) · `🧠
analyze` · `✍ repurpose` · `🎙 transcribe`.

### Footer bulk control (single dropdown)
`Bulk action` select (`Download videos` / `Download audio` /
`Transcribe` / `Generate rewrites (md)`) + `where score ≥ N` threshold
input + `Run` + shared `Cancel`. The pipeline `✨ Repurpose top N`
button is unchanged.

---

## 10. Modals

- **Compare** (2-3 rows) — side-by-side stats + covers
- **Repurpose** — 4 tabs (TikTok / YT Shorts / X / LinkedIn), per-platform regenerate
- **Pipeline** — full multi-step run (download → transcribe → diagnose → rewrite → README) with progress
- **Help** — keyboard shortcuts

---

## 11. Cross-platform popup dashboard

`src/dashboard/dashboard.js` — opened from toolbar icon. Reads the
`UnifiedPosts` Airtable table (or self-hosted Postgres via webhook
mirror), recomputes outlier scores per-platform, renders a combined feed
across IG + TT + (future) YT Shorts. **Independent surface** — does not
share UI with the in-page overlay.

---

## 12. Background / infra

- declarativeNetRequest rules (`rules.json`) for IG/TT API capture
- service worker (`background.js`): downloads, LLM bridge, sinks dispatcher,
  weekly-digest alarm
- offscreen doc: transformers.js (MiniLM embeddings for niche auto-cluster
  + signals trigram fallback) + audio post-processing
- IndexedDB (`src/store.js`): `posts`, `meta`, `voice`, `rewrites`,
  `pipeline_steps`, `audio`, `signals`, `creators`, `logs`
- Ollama at `localhost:11434` (Gemma 3/4)
- faster-whisper sidecar at `localhost:8787`
- 3 sinks: Sheets (Apps Script), Airtable (upsert), Notion (append-only)
- 3 webhooks: generic, Slack, Discord + weekly digest alarm

---

# Findings — UI Audit

## A. The tab bar is the #1 source of confusion

Seven tabs, but only 2 are independent surfaces:

| Tab | Independent? | Verdict |
|--|--|--|
| **Current** | yes | keep |
| **Pinned** | **no** — same data as `📌 Pinned only` chip and the pinned drawer | **remove the tab** (3 entry points → 1) |
| **Sounds** | yes (different table) | keep, but TT-only realistically |
| **Signals** | half — derived from posts; novel UX | demote to a **🔔 badge in header**, push panel into Stats or remove |
| **Niche** | yes (different table = creators) | keep |
| **Patterns** | **no** — same data as Stats "top hooks/topics" | **fold into Stats**, remove the tab |
| **Settings** | yes | keep, but split into sections |

**Recommended tab bar (4 tabs):** `Current · Sounds · Niche · Settings`,
plus a header **🔔 Signals** indicator that opens an inline drawer (only
when `signalsBadge > 0`).

## B. Pinned has 3 entry points, pick one

Currently:
1. `Pinned` tab
2. `📌 Pinned only` filter chip
3. `📌 Pinned · N` collapsible drawer above the list

Pick #2. Delete #1 and #3. Pinned-only is one click; the chip is already
there.

## C. Filter chip row is over-stuffed (13 chips)

Cover-vision chips (`Has face`, `Has text overlay`, `Closeup`, `Text-heavy`)
are 4 of the 13 slots and almost no user picks "show me text-heavy posts"
as a primary filter — they're tertiary signals. Move them into a "more
filters" `<details>` or a single `🅱 Cover…` dropdown that fans them out.

Likewise the 3 dynamic AI chips (`hook`, `topic`, `angle`) appear inline
and only after a click — at rest they're hidden, which is fine, but the
**Pinned/Status/Note/Transcript/Analysis** group already takes 6 chips
and you really only need:

- `📌 Pinned`
- a **Status** dropdown (Idea / Drafted / Posted / —) instead of 3 chips
- a single **Has…** dropdown (Note / Transcript / Analysis / Cover meta)

That collapses 13 chips → 3 controls.

## D. Footer has 5 mini-toolbars

The footer mixes:
- session controls (`Collect all`, `Stop`, `CSV`)
- 2 different "Repurpose top N" buttons (the **pipeline** vs the **rewrite**)
- 3 separate "outliers ≥ N" bulk controls (download, transcribe), each
  with their own threshold input and cancel button

Two changes:
1. Rename: only one button should be called "Repurpose". The plain
   rewrite-only one should become `✍ Rewrites top N` (or fold it into the
   pipeline modal as a "fast-mode" preset).
2. Collapse the three "outliers ≥ N" controls into one **▼ Bulk** menu
   (download / transcribe / rewrite / pipeline) sharing a single threshold
   input. Today the user has to set 3 different N inputs.

## E. Sort dropdown has 12 options — split it

Half are stats (outlier / velocity / likes / views / comments / cpr /
recent), the other half are **groupings** (status / hookType / topic /
angle / coverWinRate). These behave differently — group-sort changes the
visual layout (section headers). Split into:

- **Sort:** outlier · velocity · likes · views · comments · recent
- **Group by:** none · status · hook · topic · angle · cover-win-rate

## F. Settings panel is one long scroll

8 sections in one `<details>`-less column. Convert to a vertical sub-tab
list (or accordions): `Radar · Signals · AI · Sidecar · Voice · Storage ·
Webhooks · Sinks`. The sinks already use `<details>`; apply the same
pattern to the rest.

## G. Two badges, neither necessary in the tab bar

The `Signals 0` badge is always visible even when count = 0. Only show
the badge when `> 0`, and prefer a header bell icon with a dot (less
visual weight than a dedicated tab).

## H. Stats panel + Patterns tab + Niche tab voice meta = three places telling you about hooks/topics

Consolidate. Stats panel should be the one canonical surface for hook /
topic / angle distributions; Patterns becomes a Stats sub-view; Niche
keeps only **per-creator** data (voice, intervals, rescrape).

---

# Summary recommendation

**Cuts (zero feature loss):**
- Remove the `Pinned` tab and the pinned drawer (chip stays).
- Remove the `Patterns` tab (fold into Stats).
- Demote `Signals` from a tab to a header bell + inline drawer.
- Remove the 4 cover-vision chips from the always-visible row (move to a
  "More filters" disclosure).
- Merge 3 "Status" chips into a `Status` select.
- Merge 4 "Has-X" chips into a `Has…` multi-select.

**Renames / regroups:**
- "Repurpose top" (footer, plain rewrite) → "Rewrites top N" or remove
  (subsumed by the pipeline button).
- Sort dropdown → split into `Sort` + `Group by`.
- Footer "outliers ≥ N" controls → one `▼ Bulk` menu with shared threshold.

**Settings:**
- Sub-tabs / accordions for the 8 sections.

**Result:** tab bar 7 → 4. Filter chips 13 → 3 controls. Footer 5
toolbars → 3. Sort dropdown 12 → 6 + grouping. Net UI density drops by
roughly 50% with no feature loss.
