// Order-aware transcription cascade.
//
// Each tier is a function `(post) => Promise<{ text, source } | null>`. Tiers
// are tried in order; the first non-null result wins. Per-tier latency is
// emitted via the injected `log` callback so callers can observe timing
// regardless of which tier landed the result.
//
// `mode` filters which tiers run:
//   - "auto"          → free → groq → hf → sidecar
//   - "free-only"     → free
//   - "cloud-only"    → groq → hf
//   - "sidecar-only"  → sidecar
//
// This module is the spec mirrored by src/lib/transcribe-cascade-runtime.js
// (IIFE for the MV3 service worker). Keep them in lock-step.

export const TIERS_FOR_MODE = Object.freeze({
  "auto": Object.freeze(["free", "groq", "hf", "sidecar"]),
  "free-only": Object.freeze(["free"]),
  "cloud-only": Object.freeze(["groq", "hf"]),
  "sidecar-only": Object.freeze(["sidecar"]),
});

/**
 * Run the cascade.
 * @param {object} opts
 * @param {object} opts.post                       The post to transcribe.
 * @param {string} [opts.mode]                     One of TIERS_FOR_MODE keys.
 * @param {Record<string, Function>} opts.tiers    Map of tier name → async fn.
 * @param {(event: string, data?: object) => void} [opts.log]
 * @param {() => number} [opts.now]                Clock; default Date.now.
 * @returns {Promise<{ok: true, text: string, source: string, latencyMs: number}
 *                 | {ok: false, err: string}>}
 */
export async function runCascade({ post, mode = "auto", tiers, log, now } = {}) {
  const order = TIERS_FOR_MODE[mode] || TIERS_FOR_MODE.auto;
  const emit = typeof log === "function" ? log : () => {};
  const clock = typeof now === "function" ? now : () => Date.now();

  for (const name of order) {
    const fn = tiers?.[name];
    if (typeof fn !== "function") continue;
    const t0 = clock();
    let result = null;
    try {
      result = await fn(post);
    } catch {
      result = null;
    }
    const ms = clock() - t0;
    emit("transcribe.tier", { tier: name, ok: !!result, ms });
    if (result) {
      return { ok: true, text: result.text, source: result.source, latencyMs: ms };
    }
  }
  return { ok: false, err: "all-tiers-exhausted" };
}
