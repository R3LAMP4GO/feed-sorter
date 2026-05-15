# Pro/Studio cloud-LLM routing

Route the SW-side `llm.chat` calls (and the per-row Whisper transcribe call)
through the managed Railway API for Pro/Studio users. Free tier keeps the
existing local Ollama / sidecar paths. On any cloud error fall through to the
local path so the surface keeps working when the user is offline or quota'd.

## Why a runtime mirror

Following the project's organization rule ("pure logic lives in `src/lib/` as
ESM with named exports — these are the spec, tested by Vitest. When pure
logic must run inside an MV3 service worker we ship a parallel IIFE mirror"),
the cloud-routing logic goes in **two** new files:

- `src/lib/llm-cloud.js` — ESM spec (tested by Vitest)
- `src/lib/llm-cloud-runtime.js` — IIFE mirror, attached to
  `globalThis.__fsLlmCloud`, loaded by `background.js` via `importScripts`

Background.js stays a thin dispatcher; the cloud branching, response
shaping, and 429 cooldown live in the spec module.

## Surface of `src/lib/llm-cloud.js`

```js
export const LLM_CLOUD_ANALYZE_KINDS = new Set([
  "analyze", "hook", "topic", "per-post-analysis",
]);
export const LLM_CLOUD_COVER_KINDS = new Set(["cover"]);
export const LLM_CLOUD_RATE_LIMIT_MS = 60_000;
export const LLM_CLOUD_TIERS = new Set(["pro", "studio"]);

export const isCloudEligibleTier = (tier) => LLM_CLOUD_TIERS.has(tier);
export const cloudRouteForKind = (kind) =>
  LLM_CLOUD_ANALYZE_KINDS.has(kind) ? "analyze"
  : LLM_CLOUD_COVER_KINDS.has(kind) ? "cover"
  : null;

// Synthetic 429 cooldown cache.
export function createRateLimitState() {
  return { until: Object.create(null) };
}
export function isRateLimited(state, route, now) { ... }
export function setRateLimited(state, route, now, durationMs = LLM_CLOUD_RATE_LIMIT_MS) { ... }

// Pure shape converters.
export function shapeAnalyzeResponse({ kind, body, durationMs, model }) { ... }
export function shapeCoverResponse({ body, durationMs, model }) { ... }

// Main routing function. Throws on failure with `.status` set so caller can
// log + fall through to local Ollama.
export async function cloudChat({
  kind, payload, apiRequest, now, rateLimitState,
}) {
  // payload has: postId, caption, transcript, coverUrl (and the original
  // messages/schema which we ignore — the cloud route builds its own prompt).
  // apiRequest: async ({ path, method, body }) => { ok, status, body, retryAfter }
  // now: () => number (injectable for tests)
}
```

`cloudChat` behaviour:

1. Look up the route from `cloudRouteForKind(kind)`. If `null`, throw
   `Error("cloud: kind not eligible")` — caller shouldn't have called us.
2. Check `isRateLimited(state, route, now())`. If true, throw an error with
   `.status = 429` and `.kind = "rate-limit-cached"` — caller falls through.
3. Build the request body:
   - analyze route: `{ postId, caption, transcript }`
   - cover route: `{ postId, coverUrl }`
4. POST via `apiRequest({ path: "/v1/llm/{route}", method: "POST", body })`.
5. On `status === 429`: call `setRateLimited` and throw with `.status = 429`.
6. On any non-2xx: throw with `.status` set.
7. On 2xx: shape the response into the local-LLM shape
   `{ text, json, model, durationMs, cached, provider }`:
   - `text` = `JSON.stringify(json)` (matches what local Ollama returns).
   - `json` = the cloud body sliced per-kind (analyze→ pick hook+hookType for
     kind="hook", topic+angle for kind="topic", full for kind="analyze" /
     "per-post-analysis"; cover→ full body minus `cached`).
   - `model` = a stable identifier (`"gemini-cloud"` is fine — the cloud
     route doesn't echo a model id).
   - `cached` = `body.cached === true`.
   - `provider = "cloud-gemini"`.

## Surface of `src/lib/llm-cloud-runtime.js`

IIFE mirror that attaches `globalThis.__fsLlmCloud = { ...all exports }`. No
behaviour drift.

## `background.js` changes

### 1. Load the runtime mirror

Right next to the other `importScripts(...)` lines (after the
`post-analysis-runtime.js` import on line 47-ish), add:

```js
try { importScripts("src/lib/llm-cloud-runtime.js"); }
catch (e) { console.warn("[fs-bg] llm-cloud import", e); }
const LlmCloud = globalThis.__fsLlmCloud || null;
```

### 2. Create a module-level rate-limit state

Near the top of the LLM block (line ~1780), add:

```js
const LLM_CLOUD_STATE = LlmCloud ? LlmCloud.createRateLimitState() : null;
```

### 3. Add `provider` to local LLM responses

In `llmChatOllama` (line 1948) the returned object becomes:
```js
{ text, json, tokensIn, tokensOut, durationMs, model, cached: false, provider: "local-ollama" }
```
…and the cached-hit branch on line 1891 returns:
```js
{ ...hit.body, cached: true, provider: hit.body.provider || "local-ollama" }
```

Same for `llmChatGroq` (line 2061): `provider: "cloud-groq"` (this is the
BYOK Groq path, not the managed-cloud Gemini path). Cached-hit on line 1993
returns provider unchanged.

### 4. Refactor the `llm.chat` SW handler

Currently (line 1488-1502):

```js
if (msg.cmd === "llm.chat") {
  (async () => {
    const t0 = Date.now();
    const p = msg.payload || {};
    try {
      const r = await llmChat(p);
      sendResponse({ ok: true, body: r });
    } catch (e) {
      const status = e && e.status;
      log("llm.call.fail", { err: String(e?.message || e), status, ms: Date.now() - t0, kind: p.kind });
      sendResponse({ ok: false, status: status || 0, err: String(e?.message || e) });
    }
  })();
  return true;
}
```

New version dispatches to cloud first when eligible:

```js
if (msg.cmd === "llm.chat") {
  (async () => {
    const t0 = Date.now();
    const p = msg.payload || {};
    const cfg = await chrome.storage.local.get(["fs.api.baseUrl", "fs.api.token", "fs.api.tier"]);
    const tier = cfg["fs.api.tier"] || "free";
    const token = cfg["fs.api.token"] || "";
    const route = LlmCloud ? LlmCloud.cloudRouteForKind(p.kind) : null;
    const cloudEligible = LlmCloud && token && LlmCloud.isCloudEligibleTier(tier) && route;

    if (cloudEligible) {
      const baseUrl = cfg["fs.api.baseUrl"] || "https://api.feedsorter.app";
      log("llm.cloud.start", { kind: p.kind, route, postId: p.postId });
      try {
        const r = await LlmCloud.cloudChat({
          kind: p.kind,
          payload: p,
          rateLimitState: LLM_CLOUD_STATE,
          now: () => Date.now(),
          apiRequest: async ({ path, method, body }) => {
            const res = await fetch(baseUrl + path, {
              method,
              headers: {
                "content-type": "application/json",
                authorization: "Bearer " + token,
              },
              body: JSON.stringify(body),
              credentials: "include",
            });
            const text = await res.text();
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch {}
            const retryAfter = res.headers.get ? res.headers.get("retry-after") : null;
            return { ok: res.ok, status: res.status, body: json, retryAfter };
          },
        });
        log("llm.cloud.ok", {
          kind: p.kind, route, postId: p.postId,
          provider: r.provider, cached: r.cached, ms: Date.now() - t0,
        });
        sendResponse({ ok: true, body: r });
        return;
      } catch (e) {
        const status = e && e.status;
        log("llm.cloud.fallback", {
          kind: p.kind, route, postId: p.postId,
          err: String(e?.message || e), status: status || 0,
        });
        // Fall through to local.
      }
    }

    try {
      const r = await llmChat(p);
      sendResponse({ ok: true, body: r });
    } catch (e) {
      const status = e && e.status;
      log("llm.call.fail", { err: String(e?.message || e), status, ms: Date.now() - t0, kind: p.kind });
      sendResponse({ ok: false, status: status || 0, err: String(e?.message || e) });
    }
  })();
  return true;
}
```

### 5. New SW command `api.transcribe-url`

Right after the existing `api.transcribe-text` handler (line 1755), add a
JSON-body version that does NOT fetch the video extension-side — backend
fetches:

```js
if (msg.cmd === "api.transcribe-url"
    && typeof msg.postId === "string"
    && typeof msg.videoUrl === "string") {
  (async () => {
    const t0 = Date.now();
    try {
      const cfg = await chrome.storage.local.get(["fs.api.baseUrl", "fs.api.token"]);
      const baseUrl = cfg["fs.api.baseUrl"] || "https://api.feedsorter.app";
      const token = cfg["fs.api.token"] || "";
      if (!token) { sendResponse({ ok: false, err: "not-signed-in" }); return; }
      const res = await fetch(
        baseUrl + "/v1/posts/" + encodeURIComponent(msg.postId) + "/transcribe",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: "Bearer " + token,
          },
          body: JSON.stringify({ videoUrl: msg.videoUrl }),
          credentials: "include",
        },
      );
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch {}
      const retryAfter = res.headers.get ? res.headers.get("retry-after") : null;
      log("api.transcribe-url", {
        ok: res.ok, status: res.status, postId: msg.postId, ms: Date.now() - t0,
      });
      sendResponse({
        ok: res.ok, status: res.status, body: json,
        provider: "cloud-groq-whisper", retryAfter,
      });
    } catch (e) {
      log("api.transcribe-url.fail", { err: String(e), postId: msg.postId });
      sendResponse({ ok: false, err: String(e && e.message || e) });
    }
  })();
  return true;
}
```

## `content.js` changes

### 1. Pass cloud hints on analyze/cover chat calls

`analyzeOne` (line 4918-4926) — pass `caption` + `transcript` + `postId` so
the SW can route to cloud:

```js
const transcriptHead = (Array.isArray(p.transcriptSegments)
  ? p.transcriptSegments.slice(0, 3).map((s) => String(s && s.text || "").trim()).filter(Boolean).join(" ")
  : "");
const [hookR, topicR] = await Promise.all([
  window.__fsLlm.chat({
    model, messages: hookMessages, schema: HOOK_SCHEMA,
    kind: "hook", postId: p.id, options: { temperature: 0.1 },
    caption: p.desc || "", transcript: transcriptHead,
  }),
  window.__fsLlm.chat({
    model, messages: topicMessages, schema: TOPIC_SCHEMA,
    kind: "topic", postId: p.id, options: { temperature: 0.1 },
    caption: p.desc || "", transcript: transcriptHead,
  }),
]);
```

`analyzeCoverOne` (line 5334) — pass `coverUrl`:

```js
const resp = await window.__fsLlm.chat({
  model, messages, schema: COVER_SCHEMA,
  images: [coverB64],
  kind: "cover", postId: p.id, options: { temperature: 0.1 },
  coverUrl: p.cover,
});
```

(Local Ollama still uses `images` from the base64; cloud uses `coverUrl`.)

### 2. Whisper transcribe — branch on Pro

In `transcribeOne` (line 4232), before calling `sendBg("transcribe", ...)`,
check if the user is Pro and the post has a `videoUrl`. If so, call the new
SW command:

```js
// Pro path: backend fetches the video, runs Groq Whisper, returns transcript.
// We never need to touch the IG/TT CDN client-side. The button is already
// gated to proAccess(), so non-Pro tiers never get here.
if (proAccess() && p.videoUrl) {
  const r = await sendBg("api.transcribe-url", {
    postId: p.id,
    videoUrl: p.videoUrl,
  });
  if (r.ok && r.body && (r.body.text || "").length) {
    const body = {
      ...r.body,
      source: "groq-whisper",
      provider: r.provider || "cloud-groq-whisper",
    };
    const merged = await persistTranscript(p.id, body);
    if (!quiet) setStatus(`transcribed: ${(body.text || "").length} chars`);
    logInfo("transcribe.cloud.ok", {
      id: p.id, chars: body.text.length, cached: !!r.body.cached,
    });
    return { ok: true, body, post: merged };
  }
  // 429 → fall through to local sidecar (if configured) so the row still
  // resolves. Otherwise surface the error.
  if (r.status === 429) {
    logWarn("transcribe.cloud.rate-limit", { id: p.id, retryAfter: r.retryAfter });
  } else {
    logWarn("transcribe.cloud.fail", { id: p.id, err: r.err, status: r.status });
  }
  // Fall through to existing sidecar / BYOK cascade.
}
```

The existing free-tier code path stays intact below this branch.

## Tests

### `tests/unit/llm-cloud.test.js` (new)

Cover:
- `cloudRouteForKind` truth table for each eligible kind + an ineligible one.
- `isCloudEligibleTier` for pro / studio / free / null.
- Rate-limit state: set → isRateLimited true within 60s, expires after.
- `cloudChat` analyze path:
  - Routes to `/v1/llm/analyze` with `{ postId, caption, transcript }`.
  - On kind=hook returns `json: { hook, hookType }` only.
  - On kind=topic returns `json: { topic, angle }` only.
  - On kind=analyze returns full set.
  - Sets `provider: "cloud-gemini"` and `text` = JSON-stringified body.
  - On 429: sets cooldown + throws with `.status === 429`.
  - On 500: throws with `.status === 500`, no cooldown.
- `cloudChat` cover path:
  - Routes to `/v1/llm/cover` with `{ postId, coverUrl }`.
  - Returns full cover json + provider.
  - On rate-limit-cached (second call within 60s): throws with
    `.status === 429`, `.kind === "rate-limit-cached"`, does NOT call
    apiRequest.

The test uses a mock `apiRequest` adapter (the same shape as the one
background.js builds). No fetch mocking needed.

## Verification

`npm run test:unit` — should be green; new file adds ~10–15 cases.

## Risks / non-goals

- Don't touch the `voice-fingerprint` / `rewrite` / `diagnose` paths — those
  aren't in the cloud route set yet. They keep going local for Pro users
  too, which is fine (the cloud route only covers analyze + cover today).
- The `provider` field is additive — no existing consumer reads it, so
  nothing breaks if it's missing on legacy cached entries.
- Don't change the existing `api.transcribe` (multipart) handler — leave it
  for any caller that still needs the proxy-fetch path.
- Cloud path uses `JSON.stringify(json)` for `text`. Existing callers
  (analyzeOne, analyzeCoverOne) only read `.json`, so this is safe.

## Steps

1. Create `src/lib/llm-cloud.js` with the pure helpers and `cloudChat` function described above.
2. Create `src/lib/llm-cloud-runtime.js` IIFE mirror attaching `globalThis.__fsLlmCloud`.
3. Create `tests/unit/llm-cloud.test.js` with the cases listed under Tests.
4. In `background.js`: importScripts the runtime mirror after the existing import block.
5. In `background.js`: add `LLM_CLOUD_STATE` near the LLM block constants.
6. In `background.js`: add `provider` field to `llmChatOllama` + `llmChatGroq` return objects (both fresh-call and cache-hit branches).
7. In `background.js`: rewrite the `llm.chat` SW handler to try cloud first when eligible, fall through to local on error with `llm.cloud.fallback` log.
8. In `background.js`: add the new `api.transcribe-url` SW command after `api.transcribe-text`.
9. In `content.js` `analyzeOne`: pass `caption` + `transcript` (head) on both `__fsLlm.chat` calls.
10. In `content.js` `analyzeCoverOne`: pass `coverUrl` on the chat call.
11. In `content.js` `transcribeOne`: add the Pro/cloud branch that calls `api.transcribe-url` before falling through to the existing sidecar/BYOK cascade.
12. Run `npm run test:unit` and fix any failures.
