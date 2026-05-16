import { describe, it, expect } from "vitest";
import {
  applyFilter,
  RANGES,
  matchesSurface,
  computeDerived,
  enrichForSort,
  comparePosts,
} from "../../src/lib/filter.js";

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

  it("sorts every visible numeric option descending with derived fields populated", () => {
    const hour = 60 * 60 * 1000;
    const list = [
      post({
        id: "a",
        likes: 10,
        views: 2_400,
        comments: 10,
        createTime: NOW / 1000 - 24 * 3600,
        snapshots: [
          { capturedAt: NOW - 4 * hour, views: 2_300, likes: 1, comments: 1 },
          { capturedAt: NOW - 1 * hour, views: 2_400, likes: 2, comments: 2 },
        ],
        firstSeenAt: NOW - 4 * hour,
        lastSeenAt: NOW - 1 * hour,
      }),
      post({
        id: "b",
        likes: 99,
        views: 1_200,
        comments: 1,
        createTime: NOW / 1000 - 2 * 3600,
        snapshots: [
          { capturedAt: NOW - 4 * hour, views: 100, likes: 1, comments: 1 },
          { capturedAt: NOW - 1 * hour, views: 600, likes: 2, comments: 2 },
        ],
        firstSeenAt: NOW - 4 * hour,
        lastSeenAt: NOW - 1 * hour,
      }),
      post({
        id: "c",
        likes: 50,
        views: 900,
        comments: 60,
        createTime: NOW / 1000 - 10 * 3600,
        snapshots: [
          { capturedAt: NOW - 4 * hour, views: 850, likes: 1, comments: 1 },
          { capturedAt: NOW - 1 * hour, views: 900, likes: 2, comments: 2 },
        ],
        firstSeenAt: NOW - 4 * hour,
        lastSeenAt: NOW - 1 * hour,
      }),
    ];
    const expectOrder = (sort, ids) => {
      const out = applyFilter(
        list,
        { sort, metric: "likes", range: "all", limit: 0, surface: "all" },
        NOW,
      );
      expect(out.map((p) => p.id)).toEqual(ids);
    };

    expectOrder("likes", ["b", "c", "a"]);
    expectOrder("views", ["a", "b", "c"]);
    expectOrder("comments", ["c", "a", "b"]);
    expectOrder("recent", ["b", "c", "a"]);
    expectOrder("velocity", ["b", "a", "c"]);
    expectOrder("vph", ["b", "a", "c"]);
    expectOrder("cpr", ["c", "a", "b"]);
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

  it("can compute velocity from one baseline snapshot plus lastSeenAt/current views", () => {
    const d = computeDerived(
      post({
        views: 1_300,
        firstSeenAt: NOW - 3 * 60 * 60 * 1000,
        lastSeenAt: NOW,
        snapshots: [
          { capturedAt: NOW - 3 * 60 * 60 * 1000, views: 1_000, likes: 5, comments: 1 },
        ],
      }),
      NOW,
    );

    expect(d.snapshotCount).toBe(1);
    expect(d.velocityReady).toBe(true);
    expect(d.velocityViewsPerHr).toBeCloseTo(100, 5);
  });

  it("marks brand-new single-snapshot posts as not velocity-ready", () => {
    const d = computeDerived(
      post({
        views: 1_000,
        firstSeenAt: NOW,
        lastSeenAt: NOW,
        snapshots: [{ capturedAt: NOW, views: 1_000, likes: 5, comments: 1 }],
      }),
      NOW,
    );

    expect(d.velocityReady).toBe(false);
    expect(d.velocityViewsPerHr).toBe(0);
  });

  it("comparePosts maps each dropdown sort key to the correct derived metric", () => {
    const low = enrichForSort(
      post({
        id: "low",
        likes: 1,
        views: 100,
        comments: 1,
        createTime: NOW / 1000 - 20 * 3600,
        snapshots: [{ capturedAt: NOW - 2 * 60 * 60 * 1000, views: 90 }],
        firstSeenAt: NOW - 2 * 60 * 60 * 1000,
        lastSeenAt: NOW,
      }),
      NOW,
    );
    const high = enrichForSort(
      post({
        id: "high",
        likes: 10,
        views: 1_000,
        comments: 300,
        createTime: NOW / 1000 - 2 * 3600,
        snapshots: [{ capturedAt: NOW - 2 * 60 * 60 * 1000, views: 100 }],
        firstSeenAt: NOW - 2 * 60 * 60 * 1000,
        lastSeenAt: NOW,
      }),
      NOW,
    );

    for (const key of ["likes", "views", "comments", "recent", "velocity", "vph", "cpr"]) {
      expect(comparePosts(high, low, key)).toBeLessThan(0);
    }
  });

  it("reels surface matches isReel posts captured via /graphql/query", () => {
    // Repro of the bug: IG profile-reels tab serves reels through GraphQL,
    // so posts arrive with surface="graphql" but isReel=true. Selecting
    // the "reels" surface filter must still surface them.
    const list = [
      post({ id: "r1", surface: "graphql", isReel: true, likes: 10 }),
      post({ id: "r2", surface: "graphql", isReel: true, likes: 20 }),
      post({ id: "p1", surface: "graphql", isReel: false, likes: 30 }),
      post({ id: "r3", surface: "reels", isReel: true, likes: 5 }),
    ];
    const out = applyFilter(
      list,
      { sort: "likes", metric: "likes", range: "all", limit: 0, surface: "reels" },
      NOW
    );
    expect(out.map((p) => p.id).sort()).toEqual(["r1", "r2", "r3"]);
  });

  it("profile surface matches non-reel posts captured via /graphql/query", () => {
    const list = [
      post({ id: "p1", surface: "graphql", isReel: false, likes: 30 }),
      post({ id: "r1", surface: "graphql", isReel: true, likes: 10 }),
      post({ id: "p2", surface: "profile", isReel: false, likes: 5 }),
      post({ id: "e1", surface: "explore", isReel: false, likes: 99 }),
    ];
    const out = applyFilter(
      list,
      { sort: "likes", metric: "likes", range: "all", limit: 0, surface: "profile" },
      NOW
    );
    expect(out.map((p) => p.id).sort()).toEqual(["p1", "p2"]);
  });

  it("matchesSurface helper handles all/explore/reels/profile", () => {
    const reelGraph = { surface: "graphql", isReel: true };
    const feedGraph = { surface: "graphql", isReel: false };
    const explore = { surface: "explore", isReel: false };
    expect(matchesSurface(reelGraph, "all")).toBe(true);
    expect(matchesSurface(reelGraph, "reels")).toBe(true);
    expect(matchesSurface(reelGraph, "profile")).toBe(false);
    expect(matchesSurface(feedGraph, "reels")).toBe(false);
    expect(matchesSurface(feedGraph, "profile")).toBe(true);
    expect(matchesSurface(explore, "explore")).toBe(true);
    expect(matchesSurface(explore, "profile")).toBe(false);
  });

  it("narrows by nicheFilter (drops null/non-matching niches)", () => {
    const list = [
      post({ id: "a", niche: "fitness", likes: 10 }),
      post({ id: "b", niche: "fitness", likes: 20 }),
      post({ id: "c", niche: "finance", likes: 30 }),
      post({ id: "d", niche: null, likes: 40 }),
    ];
    const out = applyFilter(
      list,
      { sort: "likes", metric: "likes", range: "all", limit: 0, surface: "all", nicheFilter: "fitness" },
      NOW
    );
    expect(out.map((p) => p.id).sort()).toEqual(["a", "b"]);
  });

  it("narrows by formatFilter (drops null/non-matching formats)", () => {
    const list = [
      post({ id: "a", format: "list", likes: 10 }),
      post({ id: "b", format: "story", likes: 20 }),
      post({ id: "c", format: "list", likes: 30 }),
      post({ id: "d", format: null, likes: 40 }),
    ];
    const out = applyFilter(
      list,
      { sort: "likes", metric: "likes", range: "all", limit: 0, surface: "all", formatFilter: "list" },
      NOW
    );
    expect(out.map((p) => p.id).sort()).toEqual(["a", "c"]);
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
