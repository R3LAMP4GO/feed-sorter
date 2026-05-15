// IIFE mirror of src/lib/bulk-transcribe.js for MV3 content scripts.
// Exposes globalThis.__fsBulkTranscribe = { createTokenBucket, runBulkTranscribe }.
// Keep in lock-step with the ESM spec — tests run against the spec.

(function (root) {
  function createTokenBucket(opts) {
    opts = opts || {};
    const limit = typeof opts.limit === "number" ? opts.limit : 30;
    const windowMs = typeof opts.windowMs === "number" ? opts.windowMs : 60000;
    const now = typeof opts.now === "function" ? opts.now : () => Date.now();
    const sleep = typeof opts.sleep === "function"
      ? opts.sleep
      : (ms) => new Promise((r) => setTimeout(r, ms));
    const calls = [];
    return {
      async acquire() {
        while (true) {
          const t = now();
          while (calls.length && calls[0] <= t - windowMs) calls.shift();
          if (calls.length < limit) { calls.push(t); return; }
          const wait = Math.max(0, calls[0] + windowMs - t);
          await sleep(wait);
        }
      },
      size: () => calls.length,
      _calls: () => calls.slice(),
    };
  }

  const hasMedia = (p) => !!(p && (p.captionUrl || p.videoUrl));
  const hasTranscript = (p) => !!(p && p.transcript && String(p.transcript).trim());

  async function runBulkTranscribe(opts) {
    opts = opts || {};
    const posts = opts.posts;
    const transcribe = opts.transcribe;
    if (!Array.isArray(posts)) throw new TypeError("posts must be an array");
    if (typeof transcribe !== "function") throw new TypeError("transcribe must be a function");
    const concurrency = Math.max(1, opts.concurrency || 2);
    const log = typeof opts.log === "function" ? opts.log : () => {};
    const shouldCancel = typeof opts.shouldCancel === "function" ? opts.shouldCancel : () => false;
    const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : () => {};
    const now = typeof opts.now === "function" ? opts.now : () => Date.now();
    const sleep = typeof opts.sleep === "function"
      ? opts.sleep
      : (ms) => new Promise((r) => setTimeout(r, ms));
    const jitter = typeof opts.jitter === "function" ? opts.jitter : () => 500;
    const tb = opts.bucket || createTokenBucket({ now, sleep });

    const start = now();
    const counts = { done: 0, skipped: 0, failed: 0, cancelled: false };
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

        if (hasTranscript(p)) {
          counts.skipped++;
          emit({ id: p && p.id, skipped: true, reason: "already-transcribed" });
          continue;
        }
        if (!hasMedia(p)) {
          counts.skipped++;
          emit({ id: p && p.id, skipped: true, reason: "no-media" });
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
            result = { ok: false, err: String((e && e.message) || e) };
          }
          const ms = now() - t0;

          if (result && result.ok) {
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
          counts.failed++;
          emit({ id: p.id, ok: false, err: (result && result.err) || "unknown", ms });
          handled = true;
          break;
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

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

  root.__fsBulkTranscribe = { createTokenBucket, runBulkTranscribe };
})(typeof globalThis !== "undefined" ? globalThis : self);
