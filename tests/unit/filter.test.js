import { describe, it, expect } from "vitest";
import { applyFilter, RANGES } from "../../src/lib/filter.js";

const NOW = 1_700_000_000_000; // fixed reference time
const SEC = (offsetDays) => NOW / 1000 - offsetDays * 86400;

const post = (over = {}) => ({
  id: "x",
  author: "a",
  surface: "profile",
  likes: 0,
  views: 0,
  comments: 0,
  createTime: SEC(0),
  ...over,
});

describe("applyFilter", () => {
  it("filters by surface", () => {
    const list = [
      post({ id: "1", surface: "profile", likes: 5 }),
      post({ id: "2", surface: "reels", likes: 10 }),
    ];
    const out = applyFilter(
      list,
      { sort: "likes", metric: "likes", range: "all", limit: 0, surface: "reels" },
      NOW
    );
    expect(out.map((p) => p.id)).toEqual(["2"]);
  });

  it("filters by date range", () => {
    const list = [
      post({ id: "fresh", createTime: SEC(3) }),
      post({ id: "old", createTime: SEC(60) }),
    ];
    const out = applyFilter(
      list,
      { sort: "recent", metric: "likes", range: "1m", limit: 0, surface: "all" },
      NOW
    );
    expect(out.map((p) => p.id)).toEqual(["fresh"]);
  });

  it("sorts by likes descending", () => {
    const list = [
      post({ id: "a", likes: 1 }),
      post({ id: "b", likes: 99 }),
      post({ id: "c", likes: 50 }),
    ];
    const out = applyFilter(
      list,
      { sort: "likes", metric: "likes", range: "all", limit: 0, surface: "all" },
      NOW
    );
    expect(out.map((p) => p.id)).toEqual(["b", "c", "a"]);
  });

  it("respects limit", () => {
    const list = Array.from({ length: 5 }, (_, i) =>
      post({ id: String(i), likes: i })
    );
    const out = applyFilter(
      list,
      { sort: "likes", metric: "likes", range: "all", limit: 2, surface: "all" },
      NOW
    );
    expect(out).toHaveLength(2);
  });

  it("attaches outlier score when sorted by outlier", () => {
    const list = [
      post({ id: "1", author: "a", likes: 100 }),
      post({ id: "2", author: "a", likes: 200 }),
      post({ id: "3", author: "a", likes: 1000 }),
    ];
    const out = applyFilter(
      list,
      { sort: "outlier", metric: "likes", range: "all", limit: 0, surface: "all" },
      NOW
    );
    expect(out[0].id).toBe("3");
    expect(out[0]._score).toBeGreaterThan(out[1]._score);
  });

  it("RANGES table exposes all expected keys", () => {
    expect(Object.keys(RANGES)).toEqual([
      "all",
      "1w",
      "1m",
      "3m",
      "6m",
      "1y",
    ]);
  });
});
