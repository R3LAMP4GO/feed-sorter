// Bulk transcription runner.
//
// Drives a worker pool over a list of posts, invoking an injected
// `transcribe(post)` adapter (which itself runs the cascade defined in
// src/lib/transcribe-cascade.js). Adds two pieces the per-row path doesn't
// have:
//
//   - **Token-bucket pacing.** Tracks the timestamps of the last N calls in
//     a sliding `windowMs` window. Default 30 calls / 60s — Groq's free-tier
//     limit. When the bucket is full, callers `await acquire()` which sleeps
//     until the oldest entry ages out. Workers share a single bucket so the
//     concurrency=2 worker pool can't burst past the limit.
//
//   - **429 retry-after.** If `transcribe(post)` resolves with
//     `{ ok: false, status: 429, retryAfter }`, the runner sleeps
//     `retryAfter*1000 + jitter()` and retries the same post once. Two
//     consecutive 429s on the same post → log `bulk.transcribe.skip` with
//     `reason: "rate-limit-exhausted"` and move on.
//
// All side effects (clock, sleep, jitter, cancellation, log) are injected so
// the runner is fully testable with a stub `transcribe` and a fake clock.
// This module is the spec mirrored by src/lib/bulk-transcribe-runtime.js.

/**
 * Sliding-window token bucket. `acquire()` resolves once a slot is available,
 * sleeping via the injected `sleep(ms)` if the window is full.
 */
export function createTokenBucket({
  limit = 30,
  windowMs = 60_000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  /** @type {number[]} */
  const calls = [];
  return {
    async acquire() {
      // Loop because `sleep` may not advance the clock past the wait
      // (in tests with a fake clock that doesn't auto-advance).
      // After waking we re-check.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const t = now();
        while (calls.length && calls[0] <= t - windowMs) calls.shift();
        if (calls.length < limit) { calls.push(t); return; }
        const wait = Math.max(0, calls[0] + windowMs - t);
        await sleep(wait);
      }
    },
    size: () => calls.length,
    /** Test hook — current snapshot of the call window. */
    _calls: () => calls.slice(),
  };
}

const hasMedia = (p) => !!(p && (p.captionUrl || p.videoUrl));
const hasTranscript = (p) => !!(p?.transcript && String(p.transcript).trim());

/**
 * Run the bulk transcription pool.
 *
 * @param {object} opts
 * @param {Array<object>} opts.posts                       Posts to transcribe.
 * @param {(post: object) => Promise<{ok:boolean, source?:string, text?:string,
 *   status?:number, retryAfter?:number, err?:string}>} opts.transcribe
 *   Adapter that runs the cascade for one post.
 * @param {number} [opts.concurrency=2]
 * @param {ReturnType<typeof createTokenBucket>} [opts.bucket]
 * @param {(level: "info"|"warn"|"error", event: string, data?: object) => void} [opts.log]
 * @param {() => boolean} [opts.shouldCancel]              Polled before each item.
 * @param {(snapshot: object) => void} [opts.onProgress]   Called after every item.
 * @param {() => number} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.jitter]                     Returns ms jitter on 429.
 */
export async function runBulkTranscribe({
  posts,
  transcribe,
  concurrency = 2,
  bucket,
  log = () => {},
  shouldCancel = () => false,
  onProgress = () => {},
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  jitter = () => 500,
} = {}) {
  if (!Array.isArray(posts)) throw new TypeError("posts must be an array");
  if (typeof transcribe !== "function") throw new TypeError("transcribe must be a function");
  const tb = bucket || createTokenBucket({ now, sleep });

  const start = now();
  const counts = { done: 0, skipped: 0, failed: 0, cancelled: false };
  /** @type {Record<string, number>} */
  const tierBreakdown = {};
  let cursor = 0;

  const emit = (last) => onProgress({
    done: counts.done,
    skipped: counts.skipped,
    failed: counts.failed,
    total: posts.length,
    last: last || null,
  });

  const worker = async () => {
    while (true) {
      if (shouldCancel()) { counts.cancelled = true; return; }
      const idx = cursor++;
      if (idx >= posts.length) return;
      const p = posts[idx];

      // Skip already-done or no-media — these never count against the bucket.
      if (hasTranscript(p)) {
        counts.skipped++;
        emit({ id: p?.id, skipped: true, reason: "already-transcribed" });
        continue;
      }
      if (!hasMedia(p)) {
        counts.skipped++;
        emit({ id: p?.id, skipped: true, reason: "no-media" });
        continue;
      }

      let attempts = 0;
      let handled = false;
      while (attempts < 2 && !handled) {
        if (shouldCancel()) { counts.cancelled = true; return; }
        await tb.acquire();
        if (shouldCancel()) { counts.cancelled = true; return; }
        const t0 = now();
        let result;
        try {
          result = await transcribe(p);
        } catch (e) {
          result = { ok: false, err: String((e?.message) || e) };
        }
        const ms = now() - t0;

        if (result?.ok) {
          counts.done++;
          const src = result.source || "unknown";
          tierBreakdown[src] = (tierBreakdown[src] || 0) + 1;
          emit({ id: p.id, ok: true, source: src, ms });
          handled = true;
          break;
        }
        if (result && result.status === 429) {
          attempts++;
          if (attempts >= 2) {
            log("info", "bulk.transcribe.skip", { id: p.id, reason: "rate-limit-exhausted" });
            counts.skipped++;
            emit({ id: p.id, skipped: true, reason: "rate-limit-exhausted", ms });
            handled = true;
            break;
          }
          const ra = (Number(result.retryAfter) || 1) * 1000 + (Number(jitter()) || 0);
          await sleep(ra);
          continue;
        }
        // Generic, non-rate-limit failure — count once, no retry.
        counts.failed++;
        emit({
          id: p.id,
          ok: false,
          err: (result?.err) || "unknown",
          ms,
        });
        handled = true;
        break;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

  const durationMs = now() - start;
  const summary = {
    done: counts.done,
    skipped: counts.skipped,
    failed: counts.failed,
    cancelled: counts.cancelled,
    durationMs,
    tierBreakdown,
  };
  log("info", "bulk.transcribe.done", summary);
  return summary;
}
