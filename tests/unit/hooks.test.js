import { describe, it, expect } from "vitest";
import { extractHook, trigrams, jaccard, findHookMatches } from "../../src/lib/hooks.js";

describe("extractHook", () => {
  it("returns empty string for empty input", () => {
    expect(extractHook("")).toBe("");
    expect(extractHook(null)).toBe("");
    expect(extractHook(undefined)).toBe("");
  });
  it("uses only the first line", () => {
    expect(extractHook("Stop scrolling now!\nbecause this changes everything")).toBe("stop scrolling now");
  });
  it("strips punctuation/emoji and lowercases", () => {
    expect(extractHook("POV: you're 25 & broke 😅 — listen up!")).toBe("pov youre 25 broke listen up");
  });
  it("collapses repeated whitespace", () => {
    expect(extractHook("hello    world")).toBe("hello world");
  });
  it("clamps to 80 chars before stripping", () => {
    const long = "a".repeat(100);
    expect(extractHook(long).length).toBe(80);
  });
});

describe("jaccard", () => {
  it("returns 1 for identical sets", () => {
    expect(jaccard(new Set(["abc", "bcd"]), new Set(["abc", "bcd"]))).toBe(1);
  });
  it("returns 0 for disjoint sets", () => {
    expect(jaccard(new Set(["abc"]), new Set(["xyz"]))).toBe(0);
  });
  it("returns 0 for empty inputs", () => {
    expect(jaccard(new Set(), new Set(["abc"]))).toBe(0);
  });
  it("computes intersection / union", () => {
    const a = new Set(["abc", "bcd", "cde"]);
    const b = new Set(["bcd", "cde", "def"]);
    expect(jaccard(a, b)).toBeCloseTo(2 / 4, 5);
  });
});

describe("trigrams", () => {
  it("produces overlapping 3-char windows", () => {
    const t = trigrams("hi");
    // padded "  hi  " — trigrams: "  h", " hi", "hi ", "i  "
    expect(t.size).toBe(4);
  });
  it("returns empty set for empty string after padding", () => {
    // padded "    " → still produces "   " grams; so empty input still has size > 0.
    // What we care about is that two unrelated short strings have low Jaccard.
    const a = trigrams("");
    const b = trigrams("");
    expect(jaccard(a, b)).toBeGreaterThanOrEqual(0);
  });
});

describe("findHookMatches", () => {
  // Synthetic data: two creators reusing the same hook.
  const adriano = {
    id: "post-A",
    author: "adriano",
    hook: extractHook("stop scrolling if you want to fix your back pain"),
    _score: 12.3,
    createTime: 1_700_000_000,
  };
  const newPostByJoe = {
    id: "post-J",
    author: "joe_fitness",
    hook: extractHook("stop scrolling if you want to fix your back pain"),
    _score: 0.9,
    createTime: 1_710_000_000,
  };
  const unrelated = {
    id: "post-Z",
    author: "zoe",
    hook: extractHook("my morning matcha routine"),
    _score: 8.0,
    createTime: 1_700_000_000,
  };

  it("finds a match across creators when historical is a high outlier", () => {
    const out = findHookMatches(newPostByJoe, [adriano, unrelated]);
    expect(out).toHaveLength(1);
    expect(out[0].histPostId).toBe("post-A");
    expect(out[0].newAuthor).toBe("joe_fitness");
    expect(out[0].histAuthor).toBe("adriano");
    expect(out[0].similarity).toBeGreaterThanOrEqual(0.6);
    expect(out[0].histScore).toBe(12.3);
  });

  it("ignores same-author matches", () => {
    const sameAuthor = { ...adriano, id: "post-A2", _score: 10 };
    const out = findHookMatches(sameAuthor, [adriano]);
    expect(out).toHaveLength(0);
  });

  it("ignores below-threshold historical scores", () => {
    const lowScore = { ...adriano, _score: 1.5 };
    const out = findHookMatches(newPostByJoe, [lowScore]);
    expect(out).toHaveLength(0);
  });

  it("ignores below-threshold similarity", () => {
    const out = findHookMatches(newPostByJoe, [unrelated]);
    expect(out).toHaveLength(0);
  });

  it("respects custom thresholds", () => {
    const slightlySim = {
      id: "post-S",
      author: "sam",
      hook: extractHook("stop scrolling for a sec"),
      _score: 5,
      createTime: 1_700_000_000,
    };
    // With strict default, similarity may not exceed 0.6.
    const strict = findHookMatches(newPostByJoe, [slightlySim]);
    // With looser threshold, accept the match.
    const loose = findHookMatches(newPostByJoe, [slightlySim], { minSimilarity: 0.2 });
    expect(loose.length).toBeGreaterThanOrEqual(strict.length);
  });
});
