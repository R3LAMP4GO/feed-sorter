import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

// report.js is a content-script IIFE that registers itself on `window`.
// Load it into a fresh sandbox so we can exercise `_computeReport` from Node.
let computeReport;
beforeAll(() => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../../src/lib/report.js"),
    "utf8",
  );
  const sandbox = { window: {}, document: {}, Image: class {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  computeReport = sandbox.window.__fsReport._computeReport;
});

const post = (over = {}) => ({
  id: String(Math.random()),
  author: "foo",
  likes: 100,
  views: 1000,
  comments: 5,
  createTime: 1_700_000_000,
  desc: "",
  surface: "profile",
  cover: "https://x/y.jpg",
  url: "https://x/p",
  isReel: false,
  mediaType: 1,
  ...over,
});

describe("report.computeReport", () => {
  it("returns username, totals, and date range", () => {
    const r = computeReport(
      [post({ createTime: 1_700_000_000 }), post({ createTime: 1_705_000_000 })],
      "foo",
    );
    expect(r.username).toBe("foo");
    expect(r.total).toBe(2);
    expect(r.dateRange.from).toBe(1_700_000_000);
    expect(r.dateRange.to).toBe(1_705_000_000);
  });

  it("computes headline median + p90 for likes/views/comments", () => {
    const r = computeReport(
      [
        post({ likes: 10, views: 100, comments: 1 }),
        post({ likes: 20, views: 200, comments: 2 }),
        post({ likes: 30, views: 300, comments: 3 }),
        post({ likes: 100, views: 1000, comments: 10 }),
      ],
      "foo",
    );
    expect(r.headline.medianLikes).toBe(25);
    expect(r.headline.p90Likes).toBeGreaterThan(30);
    expect(r.headline.medianViews).toBe(250);
    expect(r.headline.medianComments).toBeGreaterThan(0);
  });

  it("buckets formats and surfaces", () => {
    const r = computeReport(
      [
        post({ isReel: true, mediaType: 2, surface: "reels" }),
        post({ mediaType: 8, carouselCount: 3, surface: "profile" }),
        post({ mediaType: 1, surface: "profile" }),
        post({ mediaType: 1, surface: "explore" }),
      ],
      "foo",
    );
    expect(r.formats.reel).toBe(1);
    expect(r.formats.carousel).toBe(1);
    expect(r.formats.single).toBe(2);
    expect(r.surfaces.profile).toBe(2);
    expect(r.surfaces.reels).toBe(1);
    expect(r.surfaces.explore).toBe(1);
  });

  it("ranks top10 by score, capped at 10, requires cover/url", () => {
    const list = [];
    for (let i = 0; i < 15; i++) {
      list.push(post({ id: `p${i}`, likes: (i + 1) * 10, cover: "c" }));
    }
    list.push(post({ id: "noCover", likes: 999_999, cover: "", url: "" }));
    const r = computeReport(list, "foo");
    expect(r.top10).toHaveLength(10);
    expect(r.top10.find((p) => p.id === "noCover")).toBeUndefined();
    expect(r.top10[0]._score).toBeGreaterThanOrEqual(r.top10[1]._score);
  });

  it("hashtag lift requires n≥3 and tops out at 10", () => {
    const list = [];
    for (let i = 0; i < 6; i++) {
      list.push(post({ id: `h${i}`, likes: 1000, desc: "post #viral #fitness #tag1" }));
    }
    for (let i = 0; i < 6; i++) {
      list.push(post({ id: `n${i}`, likes: 100, desc: "boring" }));
    }
    const r = computeReport(list, "foo");
    expect(r.hashtags.length).toBeGreaterThanOrEqual(2);
    for (const h of r.hashtags) expect(h.n).toBeGreaterThanOrEqual(3);
    expect(r.hashtags.length).toBeLessThanOrEqual(10);
  });

  it("groups hooks by type", () => {
    const r = computeReport(
      [
        post({ desc: "Why does this work?" }),
        post({ desc: "How to grow fast" }),
        post({ desc: "5 things you must know" }),
        post({ desc: "Stop doing this" }),
      ],
      "foo",
    );
    const types = new Set(r.hooks.map((h) => h.type));
    expect(types.has("question")).toBe(true);
    expect(types.has("how-to")).toBe(true);
    expect(types.has("list")).toBe(true);
    expect(types.has("warning")).toBe(true);
    // Trailing-! short-circuits to exclamation before warning would fire.
    const r2 = computeReport([post({ desc: "Stop doing this!" })], "foo");
    expect(r2.hooks[0].type).toBe("exclamation");
  });

  it("builds a 7×24 cadence grid that counts every post", () => {
    const list = [];
    for (let i = 0; i < 200; i++) {
      list.push(post({ id: `c${i}`, createTime: 1_700_000_000 + i * 3600 }));
    }
    const r = computeReport(list, "foo");
    let total = 0;
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) total += r.cadence[d][h].n;
    expect(total).toBe(200);
  });

  it("monthly trend is sorted ascending and capped at 18 buckets", () => {
    const list = [];
    // 24 distinct months
    for (let i = 0; i < 24; i++) {
      const t = Date.UTC(2022, i, 15) / 1000;
      list.push(post({ id: `t${i}`, createTime: t, likes: 100 + i }));
    }
    const r = computeReport(list, "foo");
    expect(r.trend.length).toBeLessThanOrEqual(18);
    for (let i = 1; i < r.trend.length; i++) {
      expect(r.trend[i].bucket > r.trend[i - 1].bucket).toBe(true);
    }
  });
});
