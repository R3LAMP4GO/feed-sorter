# YouTube Shorts: make "Collect all" advance the snap player

## The problem

Today, **none** of the YouTube Shorts paths actually capture posts when the user clicks "Collect all" — even though the parser libraries (`parser-youtube*.js`, `scope-youtube*.js`) exist and are loaded in the manifest. Two structural gaps cause this:

1. **`src/lib/platform-runtime.js` (the IIFE that content.js actually consumes) has no YouTube branch.** It only registers `igConfig` and `ttConfig`, and `detectPlatform()` only returns `tiktok` or `instagram`. On `youtube.com`, `getActiveConfig()` falls back to `igConfig`. The result: `pageScope.kind` is computed by IG's `deriveScope` against YouTube paths → `/shorts/<id>` returns `{ kind: "other" }` → the very first line of `startCollect` short-circuits with `bad-scope`.

2. **Even if scope were correct, the collector loop is hard-coded to page-scroll.** It calls `window.scrollTo(0, document.documentElement.scrollHeight)` in a loop and stops when `scrollHeight` stalls. That's correct for the IG profile grid, the IG explore grid, the TT profile grid, and (importantly) the YouTube `/@handle/shorts` channel grid — but it does **nothing** in the YouTube Shorts vertical-snap player at `/shorts/<id>` or `/feed/shorts`, where the page document is fixed-height and you advance by clicking `#navigation-button-down` (or pressing ArrowDown).

The user wants a single "Collect all" UX:
- On `/@handle/shorts` (channel shorts grid) → page-scroll until the grid stops growing. (Existing behavior — just needs platform wiring.)
- On `/shorts/<id>` and `/feed/shorts` (snap player) → click the next-short button until no new shorts arrive. (New behavior.)

## Approach

### A. Wire YouTube into the IIFE platform-runtime

Mirror the existing `igConfig` / `ttConfig` shape with a `ytConfig` inside `src/lib/platform-runtime.js`. This is the single thing blocking every YouTube path right now.

- Add `PLATFORMS.YOUTUBE = "youtube"` to the frozen enum.
- Add a `youtube.com` host branch + `/shorts/` / `/feed/shorts` path-fallback to `detectPlatform`.
- Reuse the already-loaded `globalThis.FeedSorterYouTubeScope.deriveScope` and `globalThis.FeedSorterYouTubeParser.*` namespaces (they're already in the manifest, loaded before `platform-runtime.js`).
- For the harvest mirror: `parser-youtube-runtime.js` is missing `harvestBrowse`, `enrichFromNext`, and `surfaceFromUrlTag` (only ESM `parser-youtube.js` has them). Add these three to the runtime IIFE so the platform-runtime config can use them without reinventing them inline.
- Add a `nextFromPlayer(playerJson)` adapter so the YT config's `parser.harvest(root, surface, pageScope)` can dispatch over the three innertube response shapes:
  - `/youtubei/v1/browse` → `harvestBrowse(root, pageScope)` → list of partial posts (one per shorts thumbnail).
  - `/youtubei/v1/player` → `playerToPost(root, pageScope)` → one fully-hydrated post wrapped in a 1-element array.
  - `/youtubei/v1/next` → `enrichFromNext(root)` returns `{ likes, views, comments, uploadedAt }` — needs to be re-shaped to a partial post that ingest's `Math.max` merger can fold into the existing row from `/player`.

### B. Per-platform / per-scope collect strategy

Replace the inline scroll loop in `content.js`'s `startCollect` with a call into the platform config:

```js
// PLATFORM config gains:
//   collectStrategy(pageScope) -> { advance, useScrollHeightStall, kind }
// where kind is "scroll" or "snap" — used only for logging.
```

Defaults (IG, TT, YT-profile, YT-search): `{ advance: scrollToBottom, useScrollHeightStall: true, kind: "scroll" }` — preserves today's behavior exactly.

YT shorts-feed: `{ advance: clickNextShort, useScrollHeightStall: false, kind: "snap" }` where `clickNextShort` queries — in order of preference, mirroring the pattern used by `Tyson3101/Auto-Youtube-Shorts-Scroller`, `SoRadGaming/...`, `YouTube-Enhancer/extension` and `Archimetrix/Youtube-Pro-Plus`:

```js
document.querySelector('ytd-reel-video-renderer[is-active] #navigation-button-down button')
  || document.querySelector('#navigation-button-down ytd-button-renderer button')
  || document.querySelector('#navigation-button-down button')
```

If the button is missing/disabled, `advance()` returns `false` so the collector knows it's hit the bottom and can short-circuit on the next idle check.

Why click instead of synthetic ArrowDown KeyboardEvent: real-world Shorts auto-scrollers near-universally use the click path. KeyboardEvent dispatch is fragile (requires player focus, relies on YouTube's hotkey handler being attached, breaks subtly across YouTube redesigns). The next-button selector has been stable for years across the cited extensions.

Pure function design: the strategy factory accepts `{ doc }` so tests can pass a stub document with a fake `#navigation-button-down`. `advance()` reads from the `doc` parameter, never `globalThis.document`.

### C. Collector loop changes (minimal)

In `content.js`'s `startCollect` (around line 800):

- Resolve `const strategy = PLATFORM.collectStrategy(pageScope)` once at the top of the loop.
- Replace `window.scrollTo(0, document.documentElement.scrollHeight)` with `const advanced = strategy.advance({ doc: document })`.
- Skip the `scrollBy(-400)` jiggle when `strategy.kind === "snap"` (it's a scroll-list workaround that doesn't apply).
- Skip the `scrollHeight`-stall guard when `strategy.useScrollHeightStall === false` — instead, treat `advanced === false` (no next button) as an immediate `end-of-feed` signal.
- Keep the post-count-stagnation guard (`IDLE_MS` / `IDLE_MS_BELOW_LIMIT`) — it works equally well for snap players: when no new `/youtubei/v1/next` or `/player` response arrives for the idle window, we're at the bottom of the FYP / channel.

Default-config callers (IG, TT) take the same branch and behave bit-for-bit as today.

### D. Keep the ESM spec in lock-step

`src/lib/platform.js` already declares `ytConfig` with `parser: parserYt, scope: scopeYt`. Add `collectStrategy` here too so the ESM spec matches the IIFE. Tests in `tests/unit/platform.test.js` already assert `getConfig(YOUTUBE)` exists — extend those assertions to cover `collectStrategy`.

### E. DNR rules for YouTube (nice-to-have)

Add three rules to `rules.json` tagging `/youtubei/v1/(player|next|browse)` as `yt-player` / `yt-next` / `yt-shorts`. Not strictly required (the URL-regex in `injected.js` already matches these endpoints) but it lets `surfaceFromUrlTag` short-circuit on the tag instead of re-regexing the URL, matches the pattern set by IG/TT, and makes capture logs (`{ tag: "yt-shorts" }`) consistent.

### F. Tests

Unit:
- `tests/unit/platform.test.js` — extend `getConfig` assertions to cover `getConfig(YOUTUBE)`: parser/scope/collectStrategy present, `postUrl({nativeId})`, `profileUrl(handle)`. Add an IIFE-mirror smoke test that loads `platform-runtime.js` in a `vm` sandbox with a fake `window.location.host = "www.youtube.com"`, asserts `getActiveConfig().platform === "youtube"`. Will need to also load `scope-youtube-runtime.js` and `parser-youtube-runtime.js` into the same sandbox first (same pattern as the existing `loadRuntime()` helper, just two extra `runInContext` calls).
- `tests/unit/parser-youtube.test.js` — add cases for the now-promoted-to-runtime `surfaceFromUrlTag` and `enrichFromNext` (using the existing `youtube-next.json` fixture).
- `tests/unit/collect-strategy.test.js` (new) — pure tests:
  - YT shorts-feed strategy returns `kind: "snap"`, `useScrollHeightStall: false`.
  - `advance({ doc })` calls `.click()` on a fake `#navigation-button-down button` and returns `true`.
  - `advance({ doc })` with no button present returns `false`.
  - YT profile strategy returns `kind: "scroll"`, `useScrollHeightStall: true` (channel grid).
  - IG/TT strategies return `kind: "scroll"`, `useScrollHeightStall: true` (regression).

E2E:
- `tests/e2e/stub-youtube-server.mjs` (new) — vanilla `node:http`, mirrors `stub-tiktok-server.mjs`. Serves three pages:
  - `/@handle/shorts` → HTML that fires `fetch('/youtubei/v1/browse', { method: 'POST' })` → returns `youtube-browse.json` with `x-feed-sorter-tag: yt-shorts`.
  - `/shorts/abc123XYZ_-` → HTML that fires `fetch('/youtubei/v1/player')` and `/youtubei/v1/next` → returns `youtube-player.json` and `youtube-next.json` with appropriate tags. Includes a fake `<ytd-reel-video-renderer is-active>` containing `#navigation-button-down > button` so the strategy's click path can be exercised.
- `tests/e2e/capture-youtube.spec.js` (new) — mirrors `capture-tiktok.spec.js`:
  - Channel grid: navigate to `/@fitwithmaya/shorts`, poll `window.fs.posts()`, assert ≥ 2 posts with `yt_` prefix and `platform === "youtube"` and `surface === "shorts-feed"`.
  - Snap player: navigate to `/shorts/abc123XYZ_-`, call `window.fs.startCollect("test")`, install a tiny instrumentation on the fake next-button to count clicks and (on each click) trigger another `fetch('/youtubei/v1/player?v=newId)` so the loop has fresh data. Assert collector runs N rounds and `posts.length` increases.
- `tests/e2e/helpers.js` — add `parser-youtube-runtime.js`, `scope-youtube-runtime.js`, and `yt-transcript-runtime.js` to `EXTENSION_FILES` and to the test manifest's `content_scripts.js` array (mirroring production manifest order: scope/parser before platform-runtime). This is a prerequisite for the new e2e spec and is harmless to existing IG/TT specs.

## Risks

- **Selector stability.** `#navigation-button-down` has been the canonical Shorts next-button selector across multiple actively-maintained extensions for years, but YouTube has redesigned the Shorts player at least twice. Mitigation: three-tier fallback selector, `advance()` returns `false` when none match, and the post-stagnation idle guard means we still exit cleanly even if every selector breaks (the loop just ends after `IDLE_MS` with no new posts).
- **Channel `/@handle/shorts` grid.** This route is currently `kind: 'profile'` per `scope-youtube.js`'s `HANDLE_RE` — confirmed already correct, no changes needed beyond wiring YT into platform-runtime.
- **`onScopeMaybeChanged` on Shorts SPA navs.** As `/shorts/A` → `/shorts/B`, `kind` and `username` stay the same (only `videoId` changes), so the early-return at line 175 keeps the collector running across short-to-short transitions. Confirmed by reading the function — no change needed.
- **Tier gating.** `tier-gate.js` only allows `'profile'` scope on free; `'shorts-feed'` is Pro-gated for sync. This task does not change tier policy — collector is allowed to run on `shorts-feed`, but Pro is still required to sync the captured posts to the web app. That matches the existing IG-Explore behavior.
- **DNR rules** are additive (new IDs 10/11/12); no rule conflicts with existing 1–9.

## Verification

```bash
node --check content.js
node --check src/lib/platform-runtime.js
node --check src/lib/parser-youtube-runtime.js
npm run test:unit                           # must include the new files
npm run test:e2e -- capture-youtube         # new spec
npm run test:e2e                            # full e2e (regression check on IG/TT specs)
```

Manual smoke (post-merge):
1. Load extension on a real YouTube tab.
2. Visit `youtube.com/shorts/<any-id>`. Open the overlay (Alt+S). Confirm "scope: shorts-feed". Click "Collect all". Player should advance through ~5–10 shorts at the configured `STEP_MS` cadence; capture log should fire `{ event: "capture", platform: "youtube", surface: "shorts-feed" }` per ingested response.
3. Visit `youtube.com/@<any-channel>/shorts`. Click "Collect all". Page should scroll, grid should grow, posts populate.
4. Stop collection mid-way; collector cleanly aborts, log shows `{ reason: "user-stopped" }`.

## Steps

1. Add `harvestBrowse`, `enrichFromNext`, and `surfaceFromUrlTag` to `src/lib/parser-youtube-runtime.js`'s `globalThis.FeedSorterYouTubeParser` namespace, mirroring the ESM versions in `src/lib/parser-youtube.js`.
2. Add a `collectStrategy(pageScope)` field to `igConfig` and `ttConfig` in `src/lib/platform.js` (ESM) returning the default scroll strategy. Add the same field to `ytConfig` returning the snap strategy when `pageScope.kind === 'shorts-feed'` and the scroll strategy otherwise. Pure factory; reads no DOM.
3. Add `PLATFORMS.YOUTUBE`, a `ytConfig`, and a YouTube branch to `detectPlatform` in `src/lib/platform-runtime.js` (IIFE). Bind to `globalThis.FeedSorterYouTubeScope.deriveScope` and `globalThis.FeedSorterYouTubeParser.*` for parser/scope; mirror the `collectStrategy` from the ESM. Include a `/shorts/` and `/feed/shorts` path fallback in `detectPlatform` for localhost stubs.
4. Refactor the auto-collector loop in `content.js` (around line 768–890) to resolve `const strategy = PLATFORM.collectStrategy(pageScope)` once, call `strategy.advance({ doc: document })` instead of inlining `window.scrollTo`, gate the `scrollBy(-400)` jiggle on `strategy.kind === 'scroll'`, gate the `scrollHeight`-stall check on `strategy.useScrollHeightStall`, and treat `advanced === false` as an immediate `end-of-feed` reason. Log `strategy: strategy.kind` in the `collect.start` payload.
5. Add three DNR rules (ids 10/11/12) to `rules.json` tagging `||youtube.com/youtubei/v1/player`, `/next`, and `/browse` as `yt-player`, `yt-next`, `yt-shorts` respectively.
6. Add `'src/lib/parser-youtube-runtime.js'`, `'src/lib/scope-youtube-runtime.js'`, and `'src/lib/yt-transcript-runtime.js'` to the `EXTENSION_FILES` list and to the test manifest's `content_scripts.js` array in `tests/e2e/helpers.js`, in the same order as the production `manifest.json`.
7. Extend `tests/unit/platform.test.js` to assert `getConfig(YOUTUBE)` returns parser/scope/collectStrategy and that the IIFE runtime detects `host: "www.youtube.com"` as YOUTUBE (loading `scope-youtube-runtime.js` + `parser-youtube-runtime.js` into the same `vm` sandbox first).
8. Extend `tests/unit/parser-youtube.test.js` with cases for the now-runtime-mirrored `surfaceFromUrlTag` and `enrichFromNext` using the existing `tests/fixtures/youtube-next.json` fixture.
9. Add `tests/unit/collect-strategy.test.js` covering: YT shorts-feed snap strategy clicks the fake next-button and returns `true`; missing button returns `false`; YT profile + IG + TT all return the scroll strategy with `useScrollHeightStall: true`.
10. Add `tests/e2e/stub-youtube-server.mjs` serving fake `/@handle/shorts` (browse JSON), `/shorts/<id>` (player + next JSON), and a tiny shorts-DOM stub containing `<ytd-reel-video-renderer is-active><div id="navigation-button-down"><button></button></div></ytd-reel-video-renderer>` so the snap-strategy click path can be exercised in-browser.
11. Add `tests/e2e/capture-youtube.spec.js` mirroring `capture-tiktok.spec.js`: assert channel grid populates `window.fs.posts()` with `yt_`-prefixed posts; assert `startCollect()` on `/shorts/<id>` advances the fake next-button and ingests subsequent player responses.
12. Run `npm run test:unit` then `npm run test:e2e` to confirm both new specs pass and IG/TT regression specs are unaffected.
