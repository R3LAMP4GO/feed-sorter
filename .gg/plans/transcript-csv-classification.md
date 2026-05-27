# Transcript-powered CSV classification plan

Goal: make exported CSVs immediately filterable by niche/category (what the video is about) and format/presentation (how it is delivered), using TikTok/YouTube transcripts when available and local Ollama only as an optional fallback/refinement.

Current state observed:

- `src/analysis/post-analysis.js` already has cheap text format signals: `scoreFormats`, `FORMAT_LABELS`, `topFormat`, plus older single-label `detectFormat`.
- `src/lib/post-analysis-runtime.js` mirrors only the score-format helpers for the content script.
- `content.js` currently has an older inline `detectFormat` mirror and `runDetectFormats()` writes only `post.format`.
- `src/lib/visual-format.js` derives visual buckets (`talking-head`, `info-card`, `split-screen`, `product`, `b-roll`, `other`) from cover AI, and `src/store.js` persists `visualFormat`.
- `src/analysis/niche-cluster-posts.js` clusters by caption + transcript, then labels clusters via local LLM, but that is heavier and not a simple per-row CSV category.
- `analyzePost()` currently asks the LLM for a free-form lowercase `niche`, but it only sends caption + first 3 transcript segments, which is too little for reliable CSV organization.
- The worktree custom CSV code already exposes `Niche`, `Format`, `Caption format`, and `Visual format`; quick CSV remains legacy.
- There is already a script harness, `scripts/classify-test.mjs`, for fast offline format classification against exported JSON.

Recommended design:

Use a hybrid pipeline with deterministic rules first, and local LLM only where the cheap classifier is missing/low-confidence:

- `category` / `nicheCategory`: broad filterable vertical such as `business`, `finance`, `fitness`, `beauty`, `real-estate`, `ai-tools`, `marketing`, `food`, `travel`, `parenting`, `education`, `entertainment`, `other`.
- `niche`: narrower text label for deeper grouping, preserving the existing field; if LLM returns a good free-form niche, keep it here.
- `contentFormat`: transcript/caption-derived structure such as `tutorial`, `listicle`, `story`, `hottake`, `reaction`, `tip`, `explainer`, `educational`, `skit`, `pov`, `dayinlife`, `beforeafter`, `other`.
- `visualFormat`: cover/frame-derived presentation such as `talking-head`, `info-card`, `split-screen`, `product`, `b-roll`, `other`.
- `format`: the primary CSV filter format. Prefer `visualFormat` when it is strong and non-`other`; otherwise use `contentFormat`. This makes `talking-head` possible while still giving useful labels without cover analysis.
- Add optional confidence/source fields: `categoryConfidence`, `formatConfidence`, `classificationSource` (`rules`, `llm`, `mixed`), and `classificationAt`.

Implementation outline:

Add pure ESM classifier in `src/analysis/post-analysis.js`:

- Export `CATEGORY_LABELS`, `classifyCategory(post)`, `classifyForCsv(post, opts = {})`, and a helper that builds full classification text from title/caption/transcript.
- Reuse existing `scoreFormats()` for `contentFormat` and confidence.
- Add keyword/regex category scoring over `title`, `desc`, full `transcript`, hashtags, and author/category metadata. This is fast and will handle common verticals like business/finance/fitness/beauty/real-estate/AI.
- Combine with `visualFormat` to compute primary `format` and `classificationSource`.
- Keep output deterministic and stable for tests.

Update `src/lib/post-analysis-runtime.js`:

- Mirror the new `CATEGORY_LABELS`, `classifyCategory`, and `classifyForCsv` helpers.
- Expose them on `globalThis.__fsPostAnalysis` with existing `scoreFormats/topFormat`.

Update storage in `src/store.js`:

- Bump `DB_VERSION` from 11 to 12.
- Add a new `if (oldVersion < 12)` migration that stamps `category`, `categoryConfidence`, `contentFormat`, `formatConfidence`, `classificationSource`, and `classificationAt` to null/empty defaults on existing posts. Do not edit old migration blocks.
- Add `setPostClassification(id, classification)` to patch all classification fields at once.
- Export `setPostClassification` on `window.__fsStore`.

Update overlay/runtime in `content.js`:

- Replace the inline older `detectFormat` with calls to `globalThis.__fsPostAnalysis.classifyForCsv`.
- Change `runDetectFormats()` into a CSV classification pass that runs over `statsScope()` and writes `setPostClassification()` when available, falling back to `setPostFormat()` for older stores.
- Update button copy from “Caption fallback” to something like “⚡ Classify CSV fields”.
- After transcript persistence (`persistTranscript` / bulk transcript path), optionally classify that post immediately if the runtime helper exists, so TikTok/YouTube rows get CSV labels as soon as captions arrive.
- Keep the heavier local LLM cluster/analysis buttons separate; this pass must stay fast and local/offline.

Update CSV export in `content.js`:

- Add broad `Category` column near the front.
- Update `Niche` value to `p.niche || p.category || ai.niche || ai.nicheLabel`.
- Update `Format` value to `p.format || p.visualFormat || p.contentFormat` depending on the chosen primary label. The planned primary `format` field should already be the best filterable value.
- Add optional columns: `Content format`, `Visual format`, `Category confidence`, `Format confidence`, `Classification source`.
- Add those columns to default/research/metrics/transcripts presets so opening CSV in Sheets/Excel immediately allows filtering by `Category`, `Niche`, and `Format`.
- Consider adding these fields to `CSV_LEGACY_FIELDS` so Quick CSV also includes them, or change Quick CSV to use the default rich fields while retaining old key headers only if backwards compatibility is required.

Add fast local script:

- Create `scripts/classify-csv.mjs` or extend `scripts/classify-test.mjs`.
- Input: exported library JSON (`array` or `{ posts: [...] }`). Output: CSV to stdout or `--out file.csv`.
- Use `classifyForCsv()` and existing CSV escaping. No browser/IDB required, so it is much faster than opening the extension and can process thousands of rows locally.
- Add optional `--llm` mode that calls local Ollama using `src/lib/llm.js` for low-confidence rows only. Default should be pure rules for speed.
- LLM mode schema should return only normalized labels: `category`, `niche`, `contentFormat`, `confidence`, never free-form unbounded columns. Use caption + full/trimmed transcript, not just first 3 segments.

Tests:

- Extend `tests/unit/post-analysis.test.js` for category classification, `classifyForCsv` primary format precedence, transcript-driven business/fitness/AI examples, and fallback behavior.
- Add/extend runtime parity tests if there is an existing runtime mirror test; otherwise add a lightweight test that imports/evaluates `src/lib/post-analysis-runtime.js` and compares selected outputs to ESM.
- Extend `tests/unit/store-migration.test.js` with v11→v12 classification fields.
- Extend `tests/e2e/csv-custom.spec.js` to assert `Category`, `Format`, `Content format`, and confidence/source headers appear.
- Add script unit/smoke coverage only if project already tests scripts; otherwise validate by running the script against a small fixture JSON.

Verification:

- `node --check content.js`
- `node --check src/lib/post-analysis-runtime.js`
- `node --check scripts/classify-csv.mjs`
- `npm run test:unit`
- `npx playwright test tests/e2e/csv-custom.spec.js`

Risks and mitigations:

- Broad categories can be subjective. Mitigate with a fixed enum and confidence column, leaving `niche` as the narrower label.
- `talking-head` is visually derived; transcript-only classification can infer it weakly but should not overwrite a cover-derived visual label. Prefer `visualFormat` when present.
- Store migration touches IDB version; only add a new migration block, never mutate older blocks.
- Runtime mirror drift is likely; keep ESM as spec and add parity coverage.

## Steps
1. Add deterministic CSV classification exports (`CATEGORY_LABELS`, `classifyCategory`, `classifyForCsv`) to `src/analysis/post-analysis.js` using full transcript/caption text and existing `scoreFormats`.
2. Mirror those helpers in `src/lib/post-analysis-runtime.js` and expose them on `globalThis.__fsPostAnalysis`.
3. Bump `src/store.js` to DB version 12, add classification field migration, and export `setPostClassification`.
4. Update `content.js` classification action to call `classifyForCsv`, persist classification fields, and trigger classification after transcripts are saved.
5. Update `content.js` CSV field definitions/presets so `Category`, `Niche`, `Format`, `Content format`, `Visual format`, confidence, and source are near the front and included by default.
6. Add `scripts/classify-csv.mjs` for fast local JSON-to-CSV classification, with optional local Ollama refinement for low-confidence rows only.
7. Add/adjust unit tests for post-analysis classification and store migration, plus e2e CSV header coverage.
8. Run `node --check` on changed runtime/script files, `npm run test:unit`, and the CSV e2e spec; fix failures before reporting completion.
