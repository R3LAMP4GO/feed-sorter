// Visual-format rollup derived from cover-AI primitives.
//
// `cover_ai` (see src/analysis/cover-analysis.js) classifies low-level cover
// features — hasFace, faceCount, composition, hasTextOverlay, expression.
// On its own that's a 6-dim fingerprint that's annoying to filter against.
// The user-facing UX wants a single named bucket like "talking-head" or
// "info-card" so the Explore overlay can say "show me what's winning in
// MY niche AND MY format". This module is the rollup.
//
// Pure ESM — no DOM, no chrome APIs. The IIFE runtime mirror lives at
// src/lib/visual-format-runtime.js and must stay in lock-step (see
// CLAUDE.md). The same logic also runs at IDB-write time in store.js
// when cover_ai is patched (see setPostCoverAi).
//
// Buckets — ordered by specificity (first match wins):
//   talking-head   — closeup composition + at least one face
//   info-card      — text-heavy composition with no face (lyric/quote/stat overlay)
//   split-screen   — split composition (regardless of face count)
//   product        — product composition (no face is implicit but not required)
//   b-roll         — wide composition, no face, no overlay (cinematic shots)
//   other          — every cover_ai shape that doesn't match the above
//
// Returns null when cover_ai is missing or malformed — caller can choose
// to skip / display "unanalyzed" / re-run cover-analysis.

export const VISUAL_FORMATS = Object.freeze([
  "talking-head",
  "info-card",
  "split-screen",
  "product",
  "b-roll",
  "other",
]);

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

export function deriveVisualFormat(coverAi) {
  if (!isObj(coverAi)) return null;

  // Defensive coercion: cover_ai fields may be missing or wrong-typed if a
  // partial response was persisted. Treat anything non-canonical as falsy.
  const composition = typeof coverAi.composition === "string" ? coverAi.composition : "";
  const hasFace = coverAi.hasFace === true;
  const faceCount = Number.isFinite(coverAi.faceCount) ? coverAi.faceCount : 0;
  const hasTextOverlay = coverAi.hasTextOverlay === true;

  // Talking head: someone's face is the focal point. Closeup is the strong
  // signal; we don't require faceCount===1 because duets / podcast covers
  // still read as "talking head" to a viewer.
  if (composition === "closeup" && (hasFace || faceCount > 0)) {
    return "talking-head";
  }

  // Info card: text dominates, no face. Captures lyric overlays, quote
  // cards, stat drops, "swipe →" carousel intros. Faces here would be a
  // talking-head with overlay caption — different beat, different bucket.
  if (composition === "text-heavy" && !hasFace) {
    return "info-card";
  }

  // Split: side-by-side / before-after / reaction overlays.
  if (composition === "split") {
    return "split-screen";
  }

  // Product: e-commerce-style cover. Faces optional (creator holding it).
  if (composition === "product") {
    return "product";
  }

  // B-roll: cinematic wide shot, no face, no text overlay.
  if (composition === "wide" && !hasFace && !hasTextOverlay) {
    return "b-roll";
  }

  // Everything else — typically text-heavy WITH face (talking head + caption),
  // wide WITH face, or composition === "other".
  return "other";
}

// Test-only: surface the bucket decision tree as a tiny string so log lines
// can explain which branch fired. Not part of the public contract.
export function deriveVisualFormatTrace(coverAi) {
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
