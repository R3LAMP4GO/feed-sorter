# Feed Sorter (Instagram + TikTok)

Manifest V3 Chrome extension that captures posts as you scroll on **both
Instagram** (profile feed, profile reels, Explore) **and TikTok**
(profile, For You, Explore, related) by intercepting each site's own feed
APIs, persists them in IndexedDB, and surfaces an overlay that sorts by
likes, views, comments, or **outlier score** (post metric ÷ author
median). The active platform is auto-dispatched from the host via
`src/lib/platform.js` (ESM spec) + `src/lib/platform-runtime.js` (IIFE
mirror); post ids are namespaced (`ig_<pk>` / `tt_<id>`) so rows from
both platforms share one IDB.

Layered on top: **fully local** AI analysis via Ollama + Gemma (rewrites,
hook fingerprint, cover/outlier diagnosis, full repurpose pipeline), reel
**transcription** via a faster-whisper Python sidecar, direct **sinks** to
Sheets / Airtable / Notion, and a cross-platform unified dashboard.
**No cloud calls. No API keys.**

## Project structure

```
feed-sorter-instagram/
├── manifest.json              MV3 manifest
├── background.js              Service worker (downloads, LLM bridge, sinks)
├── content.js                 In-page overlay + scraper (single big IIFE)
├── injected.js                Main-world bridge (network interception)
├── offscreen.html / .js       Offscreen doc for transformers.js / audio
├── overlay.css                Overlay styles
├── rules.json                 declarativeNetRequest rules
├── playwright-test.mjs        Custom Playwright harness (npm test)
├── src/
│   ├── pipeline.js            Repurpose orchestrator (ESM, spec for tests)
│   ├── store.js               IndexedDB store (posts, meta, voice, rewrites, pipeline_steps)
│   ├── lib/                   Pure ESM helpers (llm, cluster, parser, parser-tiktok, platform, scoring, hooks, stats, report, scope, scope-tiktok, filter, unified, sinks-core)
│   │   ├── pipeline-runtime.js   IIFE mirror of src/pipeline.js for content scripts
│   │   ├── platform-runtime.js   IIFE mirror of src/lib/platform.js + per-platform parsers + scope detectors
│   │   ├── llm-bridge.js         Content↔SW bridge for chat()
│   │   └── *-umd.js              Vendored idb / jspdf
│   ├── analysis/              Heavier passes (cover-analysis, diagnose, post-analysis, rewrite, voice-fingerprint)
│   ├── sinks/                 Export adapters (airtable, notion, sheets, index dispatcher)
│   └── dashboard/             Popup / cross-platform dashboard UI
├── sidecar/
│   ├── transcribe-server.py   Local Flask + faster-whisper server (127.0.0.1:8787)
│   └── requirements.txt
├── tests/
│   ├── unit/                  Vitest specs mirroring src/lib + src/analysis + src/pipeline (incl. parser-tiktok, platform, store-migration)
│   ├── e2e/                   Playwright specs + stub IG/TT/sink servers (stub-server.mjs, stub-tiktok-server.mjs)
│   └── fixtures/              IG + TT API JSON fixtures (feed, clips, discover, graphql, tiktok-profile, tiktok-foryou)
├── scripts/vendor-transformers.mjs  Vendors transformers.js + ORT wasm
└── docs/UNIFIED_SCHEMA.md     Cross-platform post schema
```

## Organization rules

- **One module = one responsibility.** Pure logic lives in `src/lib/` or
  `src/analysis/` as ESM with named exports — these are the spec, tested
  by Vitest. Side-effectful runtime code lives in `content.js` /
  `background.js` / sidecar. When pure logic must run inside an MV3
  content script, ship a parallel IIFE mirror in `src/lib/*-runtime.js`
  (see `pipeline-runtime.js` mirroring `src/pipeline.js`) and keep the
  two in lock-step.
- **All adapters injected.** Pipeline modules accept `chat`, `fetchImpl`,
  `store`, `signal`, etc. as opts so tests stay hermetic.
- **IDB schema changes** bump `DB_VERSION` in `src/store.js` and add a new
  `if (oldVersion < N)` block. Never edit an existing block.
- **All AI is local.** Ollama at `localhost:11434`, Whisper sidecar at
  `localhost:8787`. Never introduce a cloud LLM call.
- **Untracked files** (caches, downloads, scratch) go in `.gitignore`.

## Quality checks

No linter / typechecker is configured. The only gates are tests.

```bash
npm run test:unit      # vitest run — unit tests (must be green before commit)
npm run test:e2e       # playwright test — e2e against stub IG/sink servers
npm run test:all       # unit + e2e
npm run test:cov       # vitest run --coverage (v8, src/lib/**)
node --check <file>    # quick syntax check for content.js / background.js / IIFEs
```

Sidecar (run manually when working on transcription/pipeline):

```bash
cd sidecar && pip install -r requirements.txt
python transcribe-server.py        # FS_WHISPER_MODEL / FS_WHISPER_PORT to override
```

Ollama must be running separately for any AI feature: `ollama serve` with
a multimodal Gemma pulled (`gemma3:4b` / `gemma3:12b`).

**Zero tolerance**: do not commit if `npm run test:unit` is failing.
