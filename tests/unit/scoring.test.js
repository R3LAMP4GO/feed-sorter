import { describe, it, expect } from "vitest";
import { median, computeOutliers } from "../../src/lib/scoring.js";

describe("median", () => {
  it("returns 0 for empty", () => {
    expect(median([])).toBe(0);
  });
  it("works on single element", () => {
    expect(median([7])).toBe(7);
  });
  it("averages middle two on even length", () => {
    expect(median([1, 3])).toBe(2);
    expect(median([10, 20, 30, 40])).toBe(25);
  });
  it("returns the middle on odd length", () => {
    expect(median([1, 2, 3])).toBe(2);
    expect(median([5, 1, 9])).toBe(5);
  });
  it("does not mutate the input", () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe("computeOutliers", () => {
  it("uses per-author median when ≥2 samples", () => {
    const list = [
      { id: "1", author: "a", likes: 100 },
      { id: "2", author: "a", likes: 200 },
      { id: "3", author: "a", likes: 1000 },
    ];
    const out = computeOutliers(list, "likes");
    // author median of [100,200,1000] = 200; scores: 0.5, 1, 5
    expect(out[0]._scoreBasis).toBe("author");
    expect(out[0]._score).toBeCloseTo(0.5, 5);
    expect(out[1]._score).toBeCloseTo(1, 5);
    expect(out[2]._score).toBeCloseTo(5, 5);
  });

  it("falls back to global median for single-sample authors", () => {
    const list = [
      { id: "1", author: "a", likes: 50 },
      { id: "2", author: "b", likes: 100 },
      { id: "3", author: "c", likes: 200 },
    ];
    const out = computeOutliers(list, "likes");
    // Each author has 1 sample → all use global. Global median of [50,100,200] = 100.
    expect(out.every((p) => p._scoreBasis === "global")).toBe(true);
    expect(out.find((p) => p.id === "2")._score).toBeCloseTo(1, 5);
    expect(out.find((p) => p.id === "3")._score).toBeCloseTo(2, 5);
  });

  it("score=0 when there is no positive baseline", () => {
    const list = [
      { id: "1", author: "a", likes: 0 },
      { id: "2", author: "b", likes: 0 },
    ];
    const out = computeOutliers(list, "likes");
    expect(out.every((p) => p._score === 0)).toBe(true);
  });

  it("filters non-positive values from per-author baseline", () => {
    const list = [
      { id: "1", author: "a", likes: 0 },
      { id: "2", author: "a", likes: 100 },
      { id: "3", author: "a", likes: 200 },
    ];
    const out = computeOutliers(list, "likes");
    // positive values [100,200], median=150; only 2 positives → ≥MIN_SAMPLES
    expect(out[0]._score).toBe(0); // 0 / 150 = 0
    expect(out[1]._score).toBeCloseTo(100 / 150, 5);
    expect(out[2]._score).toBeCloseTo(200 / 150, 5);
  });

  it("treats missing author as the same '_unknown' bucket", () => {
    const list = [
      { id: "1", likes: 10 },
      { id: "2", likes: 30 },
    ];
    const out = computeOutliers(list, "likes");
    // _unknown bucket has 2 positives → author basis
    expect(out[0]._scoreBasis).toBe("author");
  });
});
