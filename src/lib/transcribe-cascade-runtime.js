// IIFE mirror of src/lib/transcribe-cascade.js for the MV3 service worker
// (importScripts) and content scripts. Keep in lock-step with the ESM spec.
//
// Exposes globalThis.__fsTranscribeCascade = { runCascade, TIERS_FOR_MODE }.

(function (root) {
  const TIERS_FOR_MODE = Object.freeze({
    "auto": Object.freeze(["free", "groq", "hf", "sidecar"]),
    "free-only": Object.freeze(["free"]),
    "cloud-only": Object.freeze(["groq", "hf"]),
    "sidecar-only": Object.freeze(["sidecar"]),
  });

  async function runCascade({ post, mode = "auto", tiers, log, now } = {}) {
    const order = TIERS_FOR_MODE[mode] || TIERS_FOR_MODE.auto;
    const emit = typeof log === "function" ? log : () => {};
    const clock = typeof now === "function" ? now : () => Date.now();

    for (const name of order) {
      const fn = tiers && tiers[name];
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

  root.__fsTranscribeCascade = { runCascade, TIERS_FOR_MODE };
})(typeof self !== "undefined" ? self : this);
