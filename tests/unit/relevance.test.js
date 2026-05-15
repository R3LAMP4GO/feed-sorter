// Tests for src/lib/relevance.js — scoreRelevance, byRelevance, topByRelevance,
// LEARNING_MODES presets.

import { describe, it, expect } from "vitest";
import {
  scoreRelevance,
  byRelevance,
  topByRelevance,
  LEARNING_MODES,
  _internals,
} from "../../src/lib/relevance.js";

describe("saturateOutlier", () => {
  const f = _internals.saturateOutlier;
  it("baseline 1× scores 0", () => expect(f(1)).toBeCloseTo(0, 4));
  it("2× ≈ 0.5", () => expect(f(2)).toBeCloseTo(0.5, 1));
  it("5× ≈ 0.93", () => expect(f(5)).toBeGreaterThan(0.9));
  it("monotonic", () => {
    expect(f(2)).toBeLessThan(f(3));
    expect(f(3)).toBeLessThan(f(10));
  });
  it("zero/negative → 0", () => {
    expect(f(0)).toBe(0);
    expect(f(-1)).toBe(0);
  });
});

describe("scoreRelevance — defaults (Hybrid mode)", () => {
  it("zero-signal post scores low (no outlier, no format, no niche pref)", () => {
    const r = scoreRelevance({ id: "x" });
    // niche neutral 0.5 contributes 0.20*0.5 = 0.10.
    expect(r.score).toBeLessThan(0.15);
  });

  it("strong outlier dominates the default score", () => {
    const r = scoreRelevance({ id: "x", outlier: 5 });
    expect(r.score).toBeGreaterThan(0.4);
    expect(r.reason).toContain("outlier");
  });

  it("format-only signal contributes meaningfully", () => {
    const r = scoreRelevance({
      id: "x",
      formatScores: { talking_head: 0.9, educational: 0.8 },
    });
    expect(r.components.format).toBeGreaterThan(0.4);
  });

  it("pinned post gets a boost", () => {
    const base = scoreRelevance({ id: "x", outlier: 2 });
    const pinned = scoreRelevance({ id: "x", outlier: 2, pinned: true });
    expect(pinned.score).toBeGreaterThan(base.score);
  });

  it("explore-page low-outlier post is dampened", () => {
    const explore = scoreRelevance({ id: "x", surface: "explore", outlier: 1.0 });
    const profile = scoreRelevance({ id: "x", surface: "profile", outlier: 1.0 });
    expect(explore.score).toBeLessThan(profile.score);
  });
});

describe("scoreRelevance — niche match", () => {
  it("no niche preference → neutral 0.5", () => {
    const r = scoreRelevance({ id: "x", niche: "fitness" });
    expect(r.components.niche).toBe(0.5);
  });

  it("exact niche match → 1.0", () => {
    const r = scoreRelevance({ id: "x", niche: "fitness" }, { niches: ["fitness"] });
    expect(r.components.niche).toBe(1);
  });

  it("substring fuzzy match → 0.6", () => {
    const r = scoreRelevance({ id: "x", niche: "fitness coaching" }, { niches: ["fitness"] });
    expect(r.components.niche).toBe(0.6);
  });

  it("strict mode penalizes mismatches to ~0", () => {
    const r = scoreRelevance(
      { id: "x", niche: "cooking" },
      { niches: ["fitness"], nicheStrictness: 1 }
    );
    expect(r.components.niche).toBe(0);
  });

  it("loose mode forgives mismatches", () => {
    const r = scoreRelevance(
      { id: "x", niche: "cooking" },
      { niches: ["fitness"], nicheStrictness: 0 }
    );
    expect(r.components.niche).toBe(1);
  });
});

describe("scoreRelevance — format weights", () => {
  it("user-weighted format pulls score up for matching labels", () => {
    const post = {
      id: "x",
      formatScores: { talking_head: 0.9, skit: 0.2 },
    };
    const personalBrand = scoreRelevance(post, {
      formatWeights: { talking_head: 1.0, skit: 0.0 },
    });
    const reverse = scoreRelevance(post, {
      formatWeights: { talking_head: 0.0, skit: 1.0 },
    });
    expect(personalBrand.components.format).toBeGreaterThan(reverse.components.format);
  });
});

describe("byRelevance / topByRelevance", () => {
  const posts = [
    { id: "low",    outlier: 0.5 },
    { id: "med",    outlier: 2.0 },
    { id: "high",   outlier: 8.0 },
    { id: "pinned", outlier: 0.5, pinned: true },
  ];

  it("sorts descending by relevance", () => {
    const ranked = byRelevance(posts).map((r) => r.post.id);
    expect(ranked[0]).toBe("high");
    expect(ranked[ranked.length - 1]).toBe("low");
  });

  it("topByRelevance picks the top N", () => {
    const top2 = topByRelevance(posts, {}, 2).map((p) => p.id);
    expect(top2).toContain("high");
    expect(top2.length).toBe(2);
  });

  it("does not mutate the input array", () => {
    const before = posts.map((p) => p.id);
    byRelevance(posts);
    expect(posts.map((p) => p.id)).toEqual(before);
  });
});

describe("LEARNING_MODES presets", () => {
  const post = {
    id: "x",
    formatScores: { talking_head: 0.9 },
    niche: "cooking",
    outlier: 3,
  };

  it("personalBrand weights format heavily, niche lightly", () => {
    const prefs = LEARNING_MODES.personalBrand({
      niches: ["fitness"], // cooking ≠ fitness
      formatWeights: { talking_head: 1.0 },
    });
    const r = scoreRelevance(post, prefs);
    // Even though niche mismatches, format match + outlier carry the score up.
    expect(r.score).toBeGreaterThan(0.4);
  });

  it("nicheOperator penalizes off-niche even with strong outlier", () => {
    const operator = LEARNING_MODES.nicheOperator({ niches: ["fitness"] });
    const onNiche = scoreRelevance({ ...post, niche: "fitness" }, operator);
    const offNiche = scoreRelevance(post, operator);
    expect(onNiche.score).toBeGreaterThan(offNiche.score);
    // Strict niche mode: a 0.85 strictness on cooking-vs-fitness should drop niche to ~0.15.
    expect(offNiche.components.niche).toBeLessThan(0.2);
  });

  it("hybrid sits between the two extremes", () => {
    const post2 = { ...post, niche: "fitness" };
    const prefs = { niches: ["fitness"], formatWeights: { talking_head: 1.0 } };
    const pb = scoreRelevance(post2, LEARNING_MODES.personalBrand(prefs));
    const op = scoreRelevance(post2, LEARNING_MODES.nicheOperator(prefs));
    const hy = scoreRelevance(post2, LEARNING_MODES.hybrid(prefs));
    // For a post that matches BOTH format and niche, all three modes score it
    // strongly — but hybrid never wildly outscores either pure mode.
    expect(hy.score).toBeGreaterThan(0.5);
    expect(hy.score).toBeLessThanOrEqual(Math.max(pb.score, op.score) + 0.01);
  });
});

describe("scoreRelevance — reason text", () => {
  it("explains a strong outlier", () => {
    const r = scoreRelevance({ id: "x", outlier: 4.5 });
    expect(r.reason).toContain("outlier 4.5");
  });

  it("returns 'baseline' for a featureless post", () => {
    const r = scoreRelevance({ id: "x" });
    expect(r.reason).toBe("baseline");
  });
});
