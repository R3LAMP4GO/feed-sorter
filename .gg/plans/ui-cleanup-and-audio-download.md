# UI cleanup (steps 1-6) + audio download

## Architecture decision (already given to user)

Stick with the extension + the existing cross-platform popup dashboard.
Do NOT build a login-gated website — it would break the "no cloud, no
keys, all-local" guarantee in CLAUDE.md and duplicate `src/dashboard/`.

## Audio download — design

**Where the URL lives (after parser update):**

- IG: `clips_metadata.original_sound_info.progressive_download_url` (direct
  m4a/mp4 of the original-sound stem) — only present for original sounds.
  Licensed-music is not downloadable for legal reasons; we surface only
  what IG already exposes.
- TT: `music.playUrl` (mp3, present on most items).

Both will be captured and stored on `post.audio.downloadUrl` (new field,
empty string when absent — same convention as `videoUrl`).

**UI:** add a `🎵` icon button on each row, sibling to `⬇`. Disabled when
no `audio.downloadUrl`. Single-row only — no bulk audio. Filename:
`<author>-<shortcode>-audio.<ext>` in the same `Downloads/<platform>/`
folder. Reuses the existing `bgDownload(url, filename)` SW path so we get
proper Chrome download UX (no CDN-blocked blob fallback needed for short
audio, but include the same try/blob/window.open fallback for parity).

## UI cleanup map

### 1. Remove `Pinned` tab + drawer (chip stays)

- Drop the `<button data-tab="pinned">` from the tab strip
  (`content.js:926`).
- Drop the `<details data-pinned-section>` block
  (`content.js:1044-1050`).
- Remove `pinnedSection` references: el cache (`1338`), toggle handler
  (`1381-1385`), `state.pinnedSectionOpen` (`775`), the `state.view ===
  "pinned"` branch in `updateView` (`5566`), and the `renderPinnedSection`
  function (`5311-5336`) + its call from `render()` (`5357`).
- If `state.view === "pinned"` ever loads from URL hash, coerce to
  `"current"` + flip `state.pinnedOnly = true` so old shareable links
  still work.
- CSS: delete `.fs-pinned-section`, `.fs-pinned-summary-label`,
  `.fs-pinned-list`, `.fs-pinned-empty`, `.fs-pinned-count`.

### 2. Fold `Patterns` into Stats; demote `Signals` to header bell

**Patterns:**
- Drop the `<button data-tab="patterns">` and the `fs-patterns-panel`
  block from buildUI.
- Add a new Stats block "Hook × Topic clusters" rendered by
  `computePatterns(statsScope())` — reuses the existing function — with
  the same row template and click-to-filter behaviour. Inserted between
  the existing "LLM analysis" block and "Outlier diagnosis" block in
  `renderStats` (`5293`).
- Keep `state.view === "patterns"` redirecting to `"current"` + auto-open
  the Stats `<details>` so old hash links still land somewhere reasonable.
- Remove the `state.view === "patterns"` branch from `updateView`.
- CSS: keep `.fs-patterns-*` (still used by the Stats block); just drop
  panel-specific layout.

**Signals → header bell:**
- Drop the `<button data-tab="signals">` from the tab strip.
- Add a new header button `<button data-act="signals" data-signals-btn
  title="…">🔔<span class="fs-tab-badge" data-signals-badge hidden>0</span></button>`
  next to 📡 Radar. Hidden entirely when no signals stored AND no notify
  flag. Otherwise visible; badge shows unread count.
- Convert the `<div class="fs-signals-panel" data-signals-panel hidden>`
  into a floating drawer that toggles on click (mirrors radar pattern).
  Move it to render position next to `<div class="fs-radar">`.
- `updateView`: drop the panel-show branch; replace with
  `state.signalsOpen` toggling.
- Old `state.view === "signals"` redirects to `"current"`; auto-opens the
  drawer.

### 3. Collapse status / has-X chips into selects + cover chips behind disclosure

Replace the chip strip (`content.js:1003-1019`) with:

```
<div class="fs-chips" data-chips>
  <button data-chip="pinnedOnly">📌 Pinned</button>
  <select data-ctl="statusFilter">
    <option value="">Status: any</option>
    <option value="idea">Idea</option>
    <option value="drafted">Drafted</option>
    <option value="posted">Posted</option>
    <option value="skip">Skip</option>
  </select>
  <select data-ctl="hasFilter">
    <option value="">Has: any</option>
    <option value="note">Note</option>
    <option value="transcript">Transcript</option>
    <option value="ai">Analysis</option>
  </select>
  <details class="fs-chips-more">
    <summary>More…</summary>
    <button data-chip="hasFace">😊 Has face</button>
    <button data-chip="hasTextOverlay">🅱️ Text overlay</button>
    <button data-chip="compositionCloseup">🔍 Closeup</button>
    <button data-chip="compositionTextHeavy">📝 Text-heavy</button>
  </details>
  <button data-chip="hookType" hidden data-hooktype-chip></button>
  <button data-chip="topic" hidden data-topic-chip></button>
  <button data-chip="angle" hidden data-angle-chip></button>
  <button data-chip="hashtag" hidden data-hashtag-chip></button>
</div>
```

- New `hasFilter` is a single value (`""|"note"|"transcript"|"ai"`)
  derived by setting one of `state.hasNote/hasTranscript/hasAi` and
  clearing the others — keep the underlying boolean state shape intact
  so `filtered()` doesn't change.
- `statusFilter` already lives in state as a string; just wire the
  select.
- Wire the new selects in the existing `if (els.root) root.addEventListener
  ("change", …)` block (around `1486-1510` where `[data-ctl]` controls
  are handled).
- `renderChips` updated: drop status/has-note/has-transcript/has-ai
  buttons (now selects), keep pinned + AI dynamic + hashtag + cover
  ones.

### 4. Split sort dropdown into Sort + Group by

- Replace the single `<select data-ctl="sort">` with two:
  - `data-ctl="sort"`: outlier · velocity · likes · views · comments · recent
  - `data-ctl="groupBy"`: none · status · hookType · topic · angle · coverWinRate
- New `state.groupBy = "none"`. Add to `HASH_KEYS`.
- Sorting logic in `filtered()`: when `state.sort` is one of the now-removed
  group values, route to a primary-stat sort (`outlier`) and set
  `state.groupBy = <removed value>` once at boot for back-compat.
- Group rendering in `render()`: when `groupBy !== "none"` insert section
  headers (`<div class="fs-group-h">…</div>`) between consecutive rows
  with different group keys. (Cheap: compute `groupKeyFn(p)` once,
  pre-sort by it, then by current sort within.)

### 5. Merge footer "outliers ≥ N" controls into one ▼ Bulk menu

Replace these three blocks (`content.js:1076-1091`):
- Download outliers ≥ N
- Transcribe outliers ≥ N
- Repurpose top N (the plain rewrite one)

…with a single dropdown:

```
<span class="fs-bulk">
  <select data-ctl="bulkAction">
    <option value="download">Download videos</option>
    <option value="audio">Download audio</option>     <!-- new -->
    <option value="transcribe">Transcribe</option>
    <option value="rewrite">Generate rewrites (md)</option>
  </select>
  <span class="fs-bulk-cond">where score ≥</span>
  <input data-ctl="outlierThresh" type="number" min="1" step="0.5" />
  <button data-act="bulk-run">Run</button>
  <span data-bulk-status hidden></span>
  <button data-act="bulk-cancel-any" hidden>Cancel</button>
</span>
```

- `bulk-run` dispatches to existing functions (`bulkDownloadOutliers`,
  `bulkTranscribe`, `bulkRewrite`) by `state.bulkAction`. Add a new
  `bulkDownloadAudio` that mirrors `bulkDownloadOutliers` but uses
  `audio.downloadUrl` and skips rows without one.
- Pipeline `✨ Repurpose top N` stays separate (different control: top N,
  not threshold). It's the marquee feature.

### 6. Accordion-ize Settings

- Wrap each section in an existing `<details class="fs-set-section"
  open?>` — first opens by default, others collapsed:
  - Outlier Radar defaults
  - Signals
  - Bulk download (bulkZip)
  - Transcription sidecar
  - Local AI (Ollama)
  - My voice (for repurpose)
  - Storage
  - Outbound webhooks
  - Direct sinks (already have inner `<details>` per-sink — leave as-is)
- Pure markup change. CSS: add `.fs-set-section > summary` styling that
  matches the existing `.fs-pinned-section > summary` look so it's
  consistent.

## Files to touch

- `content.js` — buildUI markup, chip handlers, sort routing, view
  switching, audio download fn, signals drawer.
- `overlay.css` — drop unused selectors, add new ones for `.fs-bulk`,
  `.fs-set-section > summary`, `.fs-chips-more`, `.fs-group-h`,
  `.fs-signals-drawer` (rename of panel).
- `src/lib/platform-runtime.js` — add `downloadUrl` to `igAudio` (from
  `original_sound_info.progressive_download_url`) and `ttAudio` (from
  `music.playUrl`).
- `src/lib/parser-tiktok.js` — same field on the spec-side `audioOf`.
  (IG parser is in platform-runtime only; spec parser already harvests
  whatever the platform-runtime emits.)
- `tests/fixtures/tiktok-foryou.json` + `tests/fixtures/tiktok-profile.json`
  — add a `playUrl` to one music object so we can write a regression test.
- `tests/unit/parser-tiktok.test.js` — assert `post.audio.downloadUrl` is
  populated when `music.playUrl` is set.
- `tests/unit/platform.test.js` — same for IG fixture (add a fixture line
  with `progressive_download_url`).

## Verification

- `node --check content.js background.js src/lib/platform-runtime.js`
- `npm run test:unit` — must stay green; add the 2 new audio assertions.
- `npm run test:e2e` — must stay green (sinks & webhooks paths
  unchanged). E2E loads the overlay and exercises tab clicks; the e2e
  spec needs a quick scan to confirm no test depends on the
  Pinned/Patterns/Signals tabs by name (I'll grep before editing).
- Manual smoke list (extension reload):
  - Tab strip shows 4 tabs.
  - Header bell appears with badge when there are unread signals,
    hidden otherwise.
  - 📌 Pinned only chip still filters.
  - Status / Has dropdowns work.
  - Group-by produces section headers.
  - Footer dropdown runs each of: download / audio / transcribe /
    rewrite, with shared threshold.
  - 🎵 row button downloads audio when present, disabled otherwise.
  - Settings sections open/close independently.

## Risks

- **Hash compatibility**: `HASH_KEYS` change. Old links containing
  `view=pinned|patterns|signals` need a redirect in the boot
  hash-restore path. Do this in one place (`applyHash` or the boot
  sequence).
- **Group-by + limit interaction**: limit currently slices the
  pre-grouped list. Keep that order — slice first, group headers
  second, so high-N groups don't crowd out low-N ones below the limit.
- **Audio downloads CORS**: TT `playUrl` and IG `progressive_download_url`
  are direct CDNs; the existing video download path falls back to
  `window.open(url)` if `fetch` blocks. Same fallback for audio.
- **Licensed music**: IG returns `progressive_download_url` mostly only
  for original sounds. Tooltip on the disabled button: "Audio not
  downloadable (licensed music)" so users understand why.

## Steps

1. Add `downloadUrl` to `igAudio` and `ttAudio` in `src/lib/platform-runtime.js`; mirror in `src/lib/parser-tiktok.js`'s `audioOf`. Update one IG fixture and one TT fixture and add unit-test assertions in `tests/unit/parser-tiktok.test.js` + `tests/unit/platform.test.js`.
2. Implement `downloadAudio(p)` in `content.js` mirroring `downloadVideo` (with same fetch→blob→window.open fallback). Add row 🎵 button next to ⬇ in `rowHTML`, wire `data-act="audio-download"`, disable when no `audio.downloadUrl`.
3. Remove the `Pinned` tab and pinned drawer: drop the tab button, the `<details data-pinned-section>` markup, the `pinnedSection` el cache + toggle handler, `state.pinnedSectionOpen`, the `view === "pinned"` branch in `updateView`, `renderPinnedSection`, and its call from `render()`. In hash restore, coerce legacy `view=pinned` → `view=current` + `pinnedOnly=true`.
4. Remove the `Patterns` tab: drop the tab button, the `fs-patterns-panel` block, the panel branch in `updateView`. In `renderStats`, append a new "Hook × Topic clusters" block driven by `computePatterns(statsScope())` reusing existing CSS. Hash redirect: `view=patterns` → `view=current` and auto-open the Stats `<details>`.
5. Demote Signals to a header bell: drop the `Signals` tab button; add a `<button data-act="signals" data-signals-btn>🔔<span data-signals-badge>` to the header. Wrap the existing `fs-signals-panel` as a floating drawer (`fs-signals-drawer`) toggled by `state.signalsOpen`. Update click handler; remove panel branch from `updateView`. Hash redirect: `view=signals` → `view=current` + `signalsOpen=true`.
6. Replace the filter chip strip with: `📌 Pinned` chip + `Status` select + `Has` select + `<details class="fs-chips-more">` containing the 4 cover chips. Add `state.hasFilter` derivation that maps the single select value back to the existing `hasNote`/`hasTranscript`/`hasAi` booleans so `filtered()` is unchanged. Wire selects in the existing `[data-ctl]` change handler. Update `renderChips` to skip removed chips.
7. Split the sort dropdown into `Sort` + `Group by`: add `state.groupBy = "none"`, include it in `HASH_KEYS`. On boot, if hash `sort` is one of `status|hookType|topic|angle|coverWinRate`, transfer it to `groupBy` and reset `sort=outlier`. In `render()`, when `groupBy !== "none"` pre-sort by `groupKeyFn(p)` then by the current sort, and emit `<div class="fs-group-h">` headers between groups.
8. Merge footer bulk controls: replace the three "outliers ≥ N" spans with one `.fs-bulk` group containing a `bulkAction` select (download / audio / transcribe / rewrite), the existing threshold input, a `bulk-run` button, status span, and shared cancel. Implement `bulkDownloadAudio` (mirrors `bulkDownloadOutliers` but uses `audio.downloadUrl`). The plain `✍ Repurpose top N` button is removed (subsumed by `rewrite` action). Pipeline `✨ Repurpose top` button stays untouched.
9. Accordion-ize Settings: wrap each of the 8 sections (Radar / Signals / Bulk / Sidecar / AI / Voice / Storage / Webhooks; Sinks already nested) in `<details class="fs-set-section">`. First section `open` by default. Add minimal CSS for `.fs-set-section > summary` matching the existing pinned-section summary style.
10. CSS cleanup in `overlay.css`: remove unused `.fs-pinned-section/-summary-label/-list/-empty/-count` and unused panel-specific patterns/signals selectors; add new `.fs-bulk`, `.fs-bulk-cond`, `.fs-chips-more`, `.fs-chips-more > summary`, `.fs-group-h`, `.fs-set-section`, `.fs-signals-drawer` (mirrors `.fs-radar` positioning), and a header `.fs-signals-bell`.
11. Update `docs/FEATURES.md`: rewrite the post-cleanup state — 4 tabs, header bell, single bulk menu, accordion settings, audio-download row button — so the doc matches the shipped UI.
12. Run `node --check content.js background.js src/lib/platform-runtime.js`, then `npm run test:unit` (with the 2 new audio assertions), then `npm run test:e2e`. Fix any e2e tab-name regressions by mapping legacy tab clicks to their new homes.
