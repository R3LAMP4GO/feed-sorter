import { describe, it, expect } from "vitest";
import {
  formatOf,
  cprOf,
  computeFormatStats,
  computeHashtagLift,
  computeCaptionHist,
  computeCprStats,
  computeCadence,
  computeStats,
  makeScoreOf,
  computeKeywords,
  captionWords,
  STOPWORDS,
} from "../../src/lib/stats.js";

const mk = (over = {}) => ({
  id: String(Math.random()),
  author: "a",
  desc: "",
  likes: 100,
  views: 1000,
  comments: 5,
  createTime: 1700000000,
  isReel: false,
  mediaType: 1,
  carouselCount: 0,
  _score: 1,
  cpr: cprOf({ comments: 5, likes: 100 }),
  ...over,
});

describe("formatOf", () => {
  it("reel detection via isReel or mediaType=2", () => {
    expect(formatOf({ isReel: true })).toBe("reel");
    expect(formatOf({ mediaType: 2 })).toBe("reel");
  });
  it("carousel via mediaType=8 or carouselCount>1", () => {
    expect(formatOf({ mediaType: 8 })).toBe("carousel");
    expect(formatOf({ carouselCount: 3 })).toBe("carousel");
  });
  it("single image fallback", () => {
    expect(formatOf({ mediaType: 1 })).toBe("single");
    expect(formatOf({})).toBe("single");
  });
});

describe("cprOf", () => {
  it("comments per 1k likes", () => {
    expect(cprOf({ comments: 50, likes: 1000 })).toBeCloseTo(50);
    expect(cprOf({ comments: 0, likes: 100 })).toBe(0);
  });
  it("guards zero likes", () => {
    expect(cprOf({ comments: 5, likes: 0 })).toBe(5000);
  });
});

describe("computeFormatStats", () => {
  it("computes n, medianViews, outlierPct per format", () => {
    const list = [
      mk({ isReel: true, views: 1000, _score: 3 }),
      mk({ isReel: true, views: 2000, _score: 1 }),
      mk({ mediaType: 8, views: 500, _score: 2.5 }),
      mk({ mediaType: 1, views: 100, _score: 0.5 }),
    ];
    const r = computeFormatStats(list);
    const reel = r.find((x) => x.format === "reel");
    expect(reel.n).toBe(2);
    expect(reel.medianViews).toBe(1500);
    expect(reel.outlierPct).toBe(50);
    const car = r.find((x) => x.format === "carousel");
    expect(car.outlierPct).toBe(100);
  });
});

describe("computeHashtagLift", () => {
  it("lifts hashtags appearing in ≥3 posts", () => {
    const list = [
      mk({ desc: "#tip workout", _score: 5 }),
      mk({ desc: "#tip morning", _score: 4 }),
      mk({ desc: "morning #tip", _score: 6 }),
      mk({ desc: "boring", _score: 1 }),
      mk({ desc: "boring #other", _score: 1 }),
    ];
    const r = computeHashtagLift(list, { minN: 3 });
    expect(r).toHaveLength(1);
    expect(r[0].tag).toBe("tip");
    expect(r[0].n).toBe(3);
    expect(r[0].lift).toBeGreaterThan(1);
    expect(r[0].meanWith).toBe(5);
  });
  it("dedupes a tag inside one caption", () => {
    const list = Array.from({ length: 3 }, () => mk({ desc: "#x #x #x", _score: 2 }));
    const r = computeHashtagLift(list, { minN: 3 });
    expect(r[0].n).toBe(3);
  });
  it("requires minN", () => {
    const list = [mk({ desc: "#once", _score: 9 }), mk({ desc: "#once", _score: 9 })];
    expect(computeHashtagLift(list, { minN: 3 })).toEqual([]);
  });
});

describe("computeCaptionHist", () => {
  it("splits outliers vs others into 20 log buckets", () => {
    const list = [
      ...Array.from({ length: 50 }, () => mk({ desc: "x".repeat(10), _score: 0.5 })),
      ...Array.from({ length: 50 }, () => mk({ desc: "y".repeat(500), _score: 3 })),
    ];
    const h = computeCaptionHist(list);
    expect(h.nb).toBe(20);
    const totalNon = h.non.reduce((a, b) => a + b, 0);
    const totalOut = h.out.reduce((a, b) => a + b, 0);
    expect(totalNon).toBe(50);
    expect(totalOut).toBe(50);
    // outliers (long captions) should sit in the higher buckets
    const outHi = h.out.slice(10).reduce((a, b) => a + b, 0);
    expect(outHi).toBeGreaterThan(40);
  });
});

describe("computeCprStats", () => {
  it("medians positive cprs", () => {
    const list = [mk({ cpr: 10 }), mk({ cpr: 20 }), mk({ cpr: 30 }), mk({ cpr: 0 })];
    const c = computeCprStats(list);
    expect(c.n).toBe(3);
    expect(c.median).toBe(20);
    expect(c.mean).toBe(20);
  });
});

describe("computeCadence", () => {
  it("aggregates by dow×hour", () => {
    // Pick a deterministic timestamp: 2024-01-01 00:00:00 UTC = Mon
    const ts = Math.floor(Date.UTC(2024, 0, 1, 12) / 1000);
    const list = [mk({ createTime: ts, _score: 4 }), mk({ createTime: ts, _score: 2 })];
    const cell = computeCadence(list);
    const d = new Date(ts * 1000);
    expect(cell[d.getDay()][d.getHours()].n).toBe(2);
    expect(cell[d.getDay()][d.getHours()].sum).toBe(6);
  });
});

describe("makeScoreOf (Explore fallback)", () => {
  it("returns _score when present", () => {
    const list = [mk({ _score: 3, vph: 100 }), mk({ _score: 1, vph: 50 })];
    const f = makeScoreOf(list);
    expect(f(list[0])).toBe(3);
    expect(f(list[1])).toBe(1);
  });
  it("falls back to vph / median(vph) when _score is 0 (Explore)", () => {
    // List has vph values 50, 100, 150 → median = 100.
    const list = [
      mk({ _score: 0, vph: 50 }),
      mk({ _score: 0, vph: 100 }),
      mk({ _score: 0, vph: 150 }),
    ];
    const f = makeScoreOf(list);
    expect(f(list[0])).toBeCloseTo(0.5);
    expect(f(list[1])).toBeCloseTo(1);
    expect(f(list[2])).toBeCloseTo(1.5);
  });
  it("returns 0 when neither _score nor vph is positive", () => {
    const list = [mk({ _score: 0, vph: 0 }), mk({ _score: 0, vph: 0 })];
    const f = makeScoreOf(list);
    expect(f(list[0])).toBe(0);
  });
});

describe("captionWords", () => {
  it("strips URLs, hashtags, and @mentions", () => {
    const ws = captionWords("check https://example.com #fitness @coach awesome routine");
    // "check" is a stopword → dropped. "awesome" is a stopword → dropped.
    // "routine" should survive.
    expect(ws).toContain("routine");
    expect(ws).not.toContain("check");
    expect(ws).not.toContain("fitness"); // hashtag stripped before matching
    expect(ws).not.toContain("coach"); // mention stripped
    expect(ws).not.toContain("https");
  });
  it("drops stopwords and short tokens", () => {
    const ws = captionWords("I am the one who eats my food");
    expect(ws.every((w) => !STOPWORDS.has(w))).toBe(true);
    expect(ws.every((w) => w.length >= 3)).toBe(true);
  });
  it("lowercases and dedupes letters from Unicode scripts", () => {
    const ws = captionWords("Música TRÄINING training Café");
    expect(ws).toContain("música");
    expect(ws).toContain("träining");
    expect(ws).toContain("training");
    expect(ws).toContain("café");
  });
});

describe("computeKeywords", () => {
  it("returns frequency-sorted niche words above n≥3", () => {
    const list = [
      mk({ desc: "morning workout routine", _score: 2 }),
      mk({ desc: "workout splits routine for beginners", _score: 3 }),
      mk({ desc: "upper body workout routine", _score: 4 }),
      mk({ desc: "recipe for protein shake", _score: 1 }),
      mk({ desc: "recipe of the day", _score: 1 }),
    ];
    const r = computeKeywords(list, { minN: 3 });
    const words = r.map((x) => x.word);
    expect(words).toContain("workout");
    expect(words).toContain("routine");
    // "recipe" only appears in 2 posts → below threshold.
    expect(words).not.toContain("recipe");
    // Frequency-first: workout (3) and routine (3) outrank everything below 3.
    expect(r[0].n).toBe(3);
  });

  it("falls back gracefully on Explore (scoreOf returns 0)", () => {
    // _score=0 across the board → sums.get(w)=0 → lift=0.
    // Should still return rows ordered by frequency without crashing.
    const list = Array.from({ length: 5 }, (_, i) => mk({
      desc: "trending hook reveal storyline plot",
      _score: 0,
      vph: 100 + i * 10,
    }));
    const scoreOf = makeScoreOf(list);
    const r = computeKeywords(list, { minN: 3, scoreOf });
    // Words appear in 5 posts each → n=5; words "trending", "hook", etc.
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].n).toBe(5);
  });

  it("dedupes the same word inside one caption", () => {
    const list = Array.from({ length: 3 }, () => mk({
      desc: "protein protein protein shake",
      _score: 2,
    }));
    const r = computeKeywords(list, { minN: 3 });
    const protein = r.find((x) => x.word === "protein");
    expect(protein.n).toBe(3);
  });
});

describe("computeStats on Explore (no _score)", () => {
  it("format outlierPct uses vph fallback instead of collapsing to 0", () => {
    // Median vph across the list = 100. Two reels at 100 (=1×), one
    // viral reel at 500 (=5×) → the 5× post is an outlier under the
    // vph fallback.
    const list = [
      mk({ isReel: true, _score: 0, vph: 100 }),
      mk({ isReel: true, _score: 0, vph: 100 }),
      mk({ isReel: true, _score: 0, vph: 500 }),
    ];
    const s = computeStats(list);
    const reel = s.formats.find((r) => r.format === "reel");
    expect(reel.outlierPct).toBeGreaterThan(0);
  });
});

describe("computeStats — 100+ post profile sanity", () => {
  it("aggregates without errors and returns expected shape", () => {
    const tags = ["fitness", "tip", "muscle", "diet"];
    const list = Array.from({ length: 120 }, (_, i) => {
      const tag = tags[i % tags.length];
      const len = 20 + ((i * 17) % 400);
      return mk({
        author: i % 5 === 0 ? "guest" : "a",
        desc: `Post ${i} #${tag} ` + "x".repeat(len),
        isReel: i % 3 === 0,
        mediaType: i % 7 === 0 ? 8 : 1,
        carouselCount: i % 7 === 0 ? 3 : 0,
        likes: 100 + (i % 50) * 10,
        views: 1000 + (i % 30) * 200,
        comments: 1 + (i % 20),
        _score: 0.5 + (i % 10) * 0.4,
        createTime: 1700000000 + i * 3600,
        cpr: cprOf({ comments: 1 + (i % 20), likes: 100 + (i % 50) * 10 }),
      });
    });
    const s = computeStats(list);
    expect(s.total).toBe(120);
    expect(s.authors).toBeGreaterThanOrEqual(2);
    expect(s.formats).toHaveLength(3);
    expect(s.formats.reduce((a, r) => a + r.n, 0)).toBe(120);
    expect(s.hashtags.length).toBeGreaterThan(0);
    expect(s.hashtags.length).toBeLessThanOrEqual(15);
    expect(Array.isArray(s.keywords)).toBe(true);
    expect(s.hist.nb).toBe(20);
    expect(s.hist.out.length).toBe(20);
    expect(s.cpr.n).toBeGreaterThan(0);
    expect(s.cadence).toHaveLength(7);
    expect(s.cadence[0]).toHaveLength(24);
  });
});
