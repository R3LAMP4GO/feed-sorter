// Unit tests for src/lib/visual-format.js.
//
// Derivation is pure — no DOM, no I/O. We assert the six named buckets fire
// for the canonical shape each represents, plus the fallback / null paths.
// The IIFE runtime mirror (src/lib/visual-format-runtime.js) is verified at
// the end by importing it and round-tripping every canonical case through
// globalThis.__fsVisualFormat — guards against the two copies drifting.

import { describe, it, expect, beforeAll } from "vitest";
import {
  VISUAL_FORMATS,
  deriveVisualFormat,
  deriveVisualFormatTrace,
} from "../../src/lib/visual-format.js";

const mkCover = (over = {}) => ({
  hasFace: false,
  faceCount: 0,
  expression: "none",
  hasTextOverlay: false,
  textContent: null,
  dominantColor: "#111111",
  composition: "other",
  ...over,
});

describe("deriveVisualFormat", () => {
  it("exposes the canonical bucket list and it includes 'talking-head'", () => {
    expect(Array.isArray(VISUAL_FORMATS)).toBe(true);
    expect(VISUAL_FORMATS).toContain("talking-head");
    expect(VISUAL_FORMATS).toContain("info-card");
    expect(VISUAL_FORMATS).toContain("other");
  });

  it("returns null for missing / non-object cover_ai", () => {
    expect(deriveVisualFormat(null)).toBeNull();
    expect(deriveVisualFormat(undefined)).toBeNull();
    expect(deriveVisualFormat("not-an-object")).toBeNull();
    expect(deriveVisualFormat([])).toBeNull();
  });

  it("closeup + face = talking-head", () => {
    expect(deriveVisualFormat(mkCover({ composition: "closeup", hasFace: true, faceCount: 1 })))
      .toBe("talking-head");
  });

  it("closeup + multiple faces still = talking-head (duets, podcasts)", () => {
    expect(deriveVisualFormat(mkCover({ composition: "closeup", hasFace: true, faceCount: 2 })))
      .toBe("talking-head");
  });

  it("closeup with faceCount > 0 but hasFace=false still = talking-head", () => {
    // Defensive: face-count int is more reliable than the bool in some model outputs.
    expect(deriveVisualFormat(mkCover({ composition: "closeup", hasFace: false, faceCount: 1 })))
      .toBe("talking-head");
  });

  it("text-heavy + no face = info-card", () => {
    expect(deriveVisualFormat(mkCover({
      composition: "text-heavy", hasTextOverlay: true, hasFace: false,
    }))).toBe("info-card");
  });

  it("text-heavy WITH face does NOT collapse to info-card (falls to 'other')", () => {
    // Talking head with a caption overlay is its own thing — the user's
    // sales-creator example. Don't mislabel as info-card.
    expect(deriveVisualFormat(mkCover({
      composition: "text-heavy", hasTextOverlay: true, hasFace: true, faceCount: 1,
    }))).toBe("other");
  });

  it("split composition = split-screen", () => {
    expect(deriveVisualFormat(mkCover({ composition: "split" })))
      .toBe("split-screen");
    // Split + face still split-screen (reaction overlays).
    expect(deriveVisualFormat(mkCover({ composition: "split", hasFace: true, faceCount: 1 })))
      .toBe("split-screen");
  });

  it("product composition = product", () => {
    expect(deriveVisualFormat(mkCover({ composition: "product" })))
      .toBe("product");
  });

  it("wide + no face + no text overlay = b-roll", () => {
    expect(deriveVisualFormat(mkCover({
      composition: "wide", hasFace: false, hasTextOverlay: false,
    }))).toBe("b-roll");
  });

  it("wide + face = other (not b-roll)", () => {
    expect(deriveVisualFormat(mkCover({
      composition: "wide", hasFace: true, faceCount: 1, hasTextOverlay: false,
    }))).toBe("other");
  });

  it("wide + text overlay = other (likely panoramic stat card)", () => {
    expect(deriveVisualFormat(mkCover({
      composition: "wide", hasFace: false, hasTextOverlay: true,
    }))).toBe("other");
  });

  it("composition === 'other' = other regardless of face/text", () => {
    expect(deriveVisualFormat(mkCover({ composition: "other" }))).toBe("other");
    expect(deriveVisualFormat(mkCover({ composition: "other", hasFace: true, faceCount: 1 })))
      .toBe("other");
  });

  it("defensive coercion: non-numeric faceCount treated as 0", () => {
    expect(deriveVisualFormat(mkCover({ composition: "closeup", hasFace: false, faceCount: "1" })))
      .toBe("other"); // string "1" doesn't count, and hasFace=false → fallback.
  });

  it("defensive coercion: non-string composition → 'other'", () => {
    expect(deriveVisualFormat(mkCover({ composition: 42, hasFace: true, faceCount: 1 })))
      .toBe("other");
  });
});

describe("deriveVisualFormatTrace", () => {
  it("returns a {format, reason} pair for every branch", () => {
    expect(deriveVisualFormatTrace(null)).toEqual({ format: null, reason: "no-cover-ai" });
    expect(deriveVisualFormatTrace(mkCover({ composition: "closeup", hasFace: true, faceCount: 1 })))
      .toEqual({ format: "talking-head", reason: "closeup+face" });
    expect(deriveVisualFormatTrace(mkCover({ composition: "text-heavy" })))
      .toEqual({ format: "info-card", reason: "text-heavy+noface" });
    expect(deriveVisualFormatTrace(mkCover({ composition: "split" })))
      .toEqual({ format: "split-screen", reason: "split" });
    expect(deriveVisualFormatTrace(mkCover({ composition: "product" })))
      .toEqual({ format: "product", reason: "product" });
    expect(deriveVisualFormatTrace(mkCover({ composition: "wide" })))
      .toEqual({ format: "b-roll", reason: "wide+noface+notext" });
  });

  it("reason explains why a fallback fired", () => {
    const t = deriveVisualFormatTrace(mkCover({
      composition: "wide", hasFace: true, faceCount: 1,
    }));
    expect(t.format).toBe("other");
    expect(t.reason).toContain("comp=wide");
    expect(t.reason).toContain("face=true");
  });
});

describe("IIFE runtime mirror (src/lib/visual-format-runtime.js) stays in lock-step", () => {
  let R;
  beforeAll(async () => {
    await import("../../src/lib/visual-format-runtime.js");
    R = globalThis.__fsVisualFormat;
  });

  it("exposes the same VISUAL_FORMATS list", () => {
    expect(R).toBeTruthy();
    expect(R.VISUAL_FORMATS).toEqual(VISUAL_FORMATS);
  });

  it("derives the same bucket for every canonical input", () => {
    const cases = [
      mkCover({ composition: "closeup", hasFace: true, faceCount: 1 }),
      mkCover({ composition: "text-heavy", hasFace: false }),
      mkCover({ composition: "split" }),
      mkCover({ composition: "product" }),
      mkCover({ composition: "wide" }),
      mkCover({ composition: "wide", hasFace: true, faceCount: 1 }),
      mkCover({ composition: "other" }),
      null,
      undefined,
    ];
    for (const c of cases) {
      expect(R.deriveVisualFormat(c)).toBe(deriveVisualFormat(c));
    }
  });
});
