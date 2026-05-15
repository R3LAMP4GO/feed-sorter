// Classic-script (IIFE) mirror of src/lib/visual-format.js for the content
// script and service worker. MV3 content scripts can't import ES modules,
// so the pure-module logic is duplicated here. Keep this in lock-step with
// src/lib/visual-format.js — the pure module is the spec (tests live there);
// this is the runtime.
//
// Exposes globalThis.__fsVisualFormat = { deriveVisualFormat, VISUAL_FORMATS,
// deriveVisualFormatTrace }.

(function attach(global) {
  if (global.__fsVisualFormat) return;

  const VISUAL_FORMATS = Object.freeze([
    "talking-head",
    "info-card",
    "split-screen",
    "product",
    "b-roll",
    "other",
  ]);

  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

  function deriveVisualFormat(coverAi) {
    if (!isObj(coverAi)) return null;
    const composition = typeof coverAi.composition === "string" ? coverAi.composition : "";
    const hasFace = coverAi.hasFace === true;
    const faceCount = Number.isFinite(coverAi.faceCount) ? coverAi.faceCount : 0;
    const hasTextOverlay = coverAi.hasTextOverlay === true;
    if (composition === "closeup" && (hasFace || faceCount > 0)) return "talking-head";
    if (composition === "text-heavy" && !hasFace) return "info-card";
    if (composition === "split") return "split-screen";
    if (composition === "product") return "product";
    if (composition === "wide" && !hasFace && !hasTextOverlay) return "b-roll";
    return "other";
  }

  function deriveVisualFormatTrace(coverAi) {
    if (!isObj(coverAi)) return { format: null, reason: "no-cover-ai" };
    const composition = typeof coverAi.composition === "string" ? coverAi.composition : "";
    const hasFace = coverAi.hasFace === true;
    const faceCount = Number.isFinite(coverAi.faceCount) ? coverAi.faceCount : 0;
    const hasTextOverlay = coverAi.hasTextOverlay === true;
    if (composition === "closeup" && (hasFace || faceCount > 0)) {
      return { format: "talking-head", reason: "closeup+face" };
    }
    if (composition === "text-heavy" && !hasFace) {
      return { format: "info-card", reason: "text-heavy+noface" };
    }
    if (composition === "split") return { format: "split-screen", reason: "split" };
    if (composition === "product") return { format: "product", reason: "product" };
    if (composition === "wide" && !hasFace && !hasTextOverlay) {
      return { format: "b-roll", reason: "wide+noface+notext" };
    }
    return { format: "other", reason: `fallback(comp=${composition || "?"},face=${hasFace},text=${hasTextOverlay})` };
  }

  global.__fsVisualFormat = { VISUAL_FORMATS, deriveVisualFormat, deriveVisualFormatTrace };
})(typeof self !== "undefined" ? self : this);
