# Tests

Two layers:

- **Unit (vitest)** — pure helpers in `src/lib/*.js`. Fast, no browser.
  - `npm run test:unit`
  - `npm run test:watch`
  - `npm run test:cov` (v8 coverage on `src/lib/**`)
- **E2E (playwright)** — loads the extension into a real Chromium against a
  local stub server that serves Instagram-shaped fixture JSON.
  - `npm run test:e2e`
- **Both**: `npm run test:all`

## Architecture note: pure helpers vs. content.js

The pure functions exercised by unit tests live in `src/lib/`:

| module | exports |
|---|---|
| `src/lib/parser.js` | `looksLikeMedia`, `cover`, `captionText`, `author`, `videoUrlOf`, `likesOf`, `commentsOf`, `viewsOf`, `surfaceFromUrlTag`, `toPost`, `harvest`, `num` |
| `src/lib/scoring.js` | `median`, `computeOutliers`, `MIN_SAMPLES` |
| `src/lib/scope.js` | `deriveScope`, `RESERVED` |
| `src/lib/filter.js` | `applyFilter`, `RANGES` |

These are byte-equivalent (modulo `export` keywords and the `pageScope` arg
on `toPost`) to the IIFE-locals in `content.js`. **They are currently the
source of truth for tests, but content.js still ships its own inline copies.**

### Why not import the modules directly into content.js?

We tried. MV3 content scripts don't natively support `"type": "module"` in the
manifest; the workaround is dynamic `import(chrome.runtime.getURL(...))`,
which is async and conflicts with the existing IIFE that runs synchronously
at `document_start`. Restructuring the IIFE into an async bootstrap created
race conditions with early XHR captures and the page-world `injected.js`
hook, so we reverted.

**Followup work**: add a tiny build step (e.g. `esbuild --bundle content.js`
with `src/lib/*` aliased) that produces the shipped `content.js` from the lib
modules, removing the duplication. Until then, **if you change a pure helper
in `content.js`, mirror the change in the matching `src/lib/*.js` file** (or
the tests will keep passing while the extension regresses).

## E2E setup details

`tests/e2e/helpers.js#launchWithExtension` writes a temp manifest pointed at
`http://127.0.0.1/*` (host_permissions and `content_scripts.matches`), copies
the extension files into a temp dir, and launches Chromium with
`--load-extension=`. Headless uses `--headless=new` (extensions don't load in
the legacy headless mode).

`tests/e2e/stub-server.mjs` is a vanilla `node:http` server (no Express). It
serves a synthetic profile/explore HTML page that fetches the same
fixture JSON shapes the extension would see in the wild. The HTML page
delays its own fetches by 500ms so the content script's `boot()` has time to
set `pageScope` before responses arrive (otherwise the scope-change handler
clears captured posts).

### Isolated vs. page world

`window.__feedSorter` is set by `content.js` in the **isolated world** and
isn't visible to `page.evaluate()` (which runs in the page world). The
**page-world** API set by `injected.js` is `window.fs` — that's what the e2e
tests use to inspect captured posts.

DOM elements (the `.fs-root` overlay, the `[data-act="csv"]` button, etc.)
are shared and assertable directly.

## CI

`.github/workflows/test.yml` runs `npm ci` → `playwright install` → `npm run
test:all` on push/PR. The headless `--headless=new` flag is honored when
`CI=1`.
