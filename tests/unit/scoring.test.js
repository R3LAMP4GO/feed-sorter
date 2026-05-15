import { describe, it, expect } from "vitest";
import {
  median,
  computeOutliers,
  MIN_AUTHOR_POSTS_FOR_WINDOW,
  WINDOW_RADIUS,
} from "../../src/lib/scoring.js";

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

  it("uses ±5 sliding window when author has ≥MIN_AUTHOR_POSTS_FOR_WINDOW posts", () => {
    // 13 chronological posts for author 'a'. createTime increases with index.
    // Likes: low for old posts, then a viral spike at index 6, then steady.
    // Index 6 should be scored against its 5 neighbours on each side, not
    // against the all-time median (which would be lower because of the
    // older low-view posts).
    const likesSeq = [50, 60, 55, 70, 80, 90, 1000, 100, 110, 120, 130, 140, 150];
    const list = likesSeq.map((likes, i) => ({
      id: String(i),
      author: "a",
      createTime: 1_700_000_000 + i * 86400,
      likes,
    }));
    expect(list.length).toBeGreaterThanOrEqual(MIN_AUTHOR_POSTS_FOR_WINDOW);
    const out = computeOutliers(list, "likes");
    const spike = out.find((p) => p.id === "6");
    expect(spike._scoreBasis).toBe("window");
    // Neighbours ±5 around chronological index 6 (after sorting desc by
    // createTime, position 6 from the end maps to original idx 6):
    // indices 1..5 + 7..11 → likes [60,55,70,80,90, 100,110,120,130,140].
    // Median of those 10 values = (90+100)/2 = 95. Score = 1000/95 ≈ 10.53.
    expect(spike._score).toBeCloseTo(1000 / 95, 4);
  });

  it("window score is independent of input order (chronological internally)", () => {
    const seq = [50, 60, 55, 70, 80, 90, 1000, 100, 110, 120, 130, 140, 150];
    const make = () => seq.map((likes, i) => ({
      id: String(i),
      author: "a",
      createTime: 1_700_000_000 + i * 86400,
      likes,
    }));
    const a = make();
    const b = make().reverse();
    const oa = computeOutliers(a, "likes");
    const ob = computeOutliers(b, "likes");
    const sa = oa.find((p) => p.id === "6")._score;
    const sb = ob.find((p) => p.id === "6")._score;
    expect(sa).toBeCloseTo(sb, 6);
  });

  it("window edges fall back gracefully (still produce a score)", () => {
    // Edge post (newest) only has neighbours on one side; with 13 posts
    // and radius=5 it still gets ≥5 neighbours → "window".
    const seq = Array.from({ length: 13 }, (_, i) => 100 + i * 10);
    const list = seq.map((likes, i) => ({
      id: String(i),
      author: "a",
      createTime: 1_700_000_000 + i * 86400,
      likes,
    }));
    const out = computeOutliers(list, "likes");
    // The newest post (highest createTime) is chrono index 0 → only 5
    // forward neighbours, which is exactly MIN_WINDOW_SAMPLES → windowed.
    const newest = out.find((p) => p.id === "12");
    expect(newest._scoreBasis).toBe("window");
    expect(newest._score).toBeGreaterThan(0);
  });

  it("falls back to author median when below the windowing threshold", () => {
    // 11 posts < MIN_AUTHOR_POSTS_FOR_WINDOW (12) → no window.
    const list = Array.from({ length: 11 }, (_, i) => ({
      id: String(i),
      author: "a",
      createTime: 1_700_000_000 + i * 86400,
      likes: 100,
    }));
    const out = computeOutliers(list, "likes");
    expect(out.every((p) => p._scoreBasis === "author")).toBe(true);
  });

  it("WINDOW_RADIUS is 5 (matches 1of10's ±5 algorithm)", () => {
    expect(WINDOW_RADIUS).toBe(5);
  });

  it("preserves caller order in the output array", () => {
    const list = [
      { id: "x", author: "a", likes: 10 },
      { id: "y", author: "b", likes: 20 },
      { id: "z", author: "a", likes: 30 },
    ];
    const out = computeOutliers(list, "likes");
    expect(out.map((p) => p.id)).toEqual(["x", "y", "z"]);
  });
});
