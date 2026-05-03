import { describe, it, expect } from "vitest";
import {
  mapPost,
  RateLimiter,
  airtableUpsertBody,
  notionPageBody,
  sheetsPayload,
  chunk,
} from "../../src/lib/sinks-core.js";

const samplePost = {
  id: "3001",
  shortcode: "ABCXYZ",
  author: "AdrianoRomanini_",
  desc: "demo caption ".repeat(200), // long; expect clipping
  createTime: 1_700_000_000,
  surface: "reels",
  likes: 12345,
  views: 67890,
  comments: 42,
  _score: 5.123456789,
  url: "https://www.instagram.com/reel/ABCXYZ/",
  cover: "https://scontent.example/cover.jpg",
  videoUrl: "https://scontent.example/video.mp4",
};

describe("mapPost", () => {
  it("normalises numeric/string fields and ISO date", () => {
    const r = mapPost(samplePost);
    expect(r.id).toBe("3001");
    expect(r.author).toBe("AdrianoRomanini_");
    expect(r.likes).toBe(12345);
    expect(r.score).toBeCloseTo(5.123456789);
    expect(r.createdISO).toBe(new Date(1_700_000_000 * 1000).toISOString());
  });
  it("clips long descriptions to 1000 chars", () => {
    const r = mapPost(samplePost);
    expect(r.desc.length).toBeLessThanOrEqual(1000);
  });
  it("falls back to score field when _score is absent", () => {
    const r = mapPost({ ...samplePost, _score: undefined, score: 7 });
    expect(r.score).toBe(7);
  });
  it("handles a post with no createTime", () => {
    const r = mapPost({ id: "x" });
    expect(r.createdISO).toBe("");
    expect(r.createTime).toBe(0);
  });
});

describe("chunk", () => {
  it("splits into fixed-size chunks", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 10)).toEqual([]);
  });
});

describe("airtableUpsertBody", () => {
  it("includes performUpsert with id merge key", () => {
    const body = airtableUpsertBody([mapPost(samplePost)]);
    expect(body.performUpsert).toEqual({ fieldsToMergeOn: ["id"] });
    expect(body.typecast).toBe(true);
  });
  it("maps cover to attachment array and exposes coverUrl", () => {
    const body = airtableUpsertBody([mapPost(samplePost)]);
    const f = body.records[0].fields;
    expect(f.cover).toEqual([{ url: samplePost.cover }]);
    expect(f.coverUrl).toBe(samplePost.cover);
  });
  it("maps surface to a string (single-select compatible)", () => {
    const f = airtableUpsertBody([mapPost(samplePost)]).records[0].fields;
    expect(f.surface).toBe("reels");
  });
  it("uses ISO createdAt", () => {
    const f = airtableUpsertBody([mapPost(samplePost)]).records[0].fields;
    expect(f.createdAt).toBe(new Date(1_700_000_000 * 1000).toISOString());
  });
});

describe("notionPageBody", () => {
  it("sets parent.database_id", () => {
    const b = notionPageBody(mapPost(samplePost), "db-123");
    expect(b.parent).toEqual({ database_id: "db-123" });
  });
  it("uses external page cover", () => {
    const b = notionPageBody(mapPost(samplePost), "db-123");
    expect(b.cover).toEqual({ type: "external", external: { url: samplePost.cover } });
  });
  it("maps numeric properties as { number }", () => {
    const b = notionPageBody(mapPost(samplePost), "db-123");
    expect(b.properties.Likes).toEqual({ number: 12345 });
    expect(b.properties.Comments).toEqual({ number: 42 });
    expect(typeof b.properties.Score.number).toBe("number");
  });
  it("maps surface as a select option", () => {
    const b = notionPageBody(mapPost(samplePost), "db-123");
    expect(b.properties.Surface).toEqual({ select: { name: "reels" } });
  });
  it("clips title rich-text segments", () => {
    const long = mapPost({ ...samplePost, desc: "x".repeat(5000) });
    const b = notionPageBody(long, "db-123");
    expect(b.properties.Caption.rich_text[0].text.content.length).toBeLessThanOrEqual(1900);
  });
  it("omits cover when none present", () => {
    const r = mapPost({ ...samplePost, cover: "" });
    const b = notionPageBody(r, "db-123");
    expect(b.cover).toBeUndefined();
  });
});

describe("sheetsPayload", () => {
  it("wraps rows under {rows} with stable keys", () => {
    const p = sheetsPayload([mapPost(samplePost)]);
    expect(Array.isArray(p.rows)).toBe(true);
    expect(p.source).toBe("feed-sorter-ig");
    const row = p.rows[0];
    expect(Object.keys(row).sort()).toEqual([
      "author", "comments", "cover", "createdAt", "desc", "id",
      "likes", "score", "shortcode", "surface", "url", "videoUrl", "views",
    ]);
  });
});

describe("RateLimiter", () => {
  it("enforces minimum interval between calls", async () => {
    const rl = new RateLimiter(10); // 100ms apart
    const t0 = Date.now();
    await rl.wait();
    await rl.wait();
    await rl.wait();
    const dt = Date.now() - t0;
    // Two intervals between 3 calls — be lenient on slow CI.
    expect(dt).toBeGreaterThanOrEqual(180);
  });

  it("retries on 429 then succeeds", async () => {
    const rl = new RateLimiter(50); // ~20ms apart so the test stays fast
    let n = 0;
    const fn = async () => {
      n++;
      if (n < 3) return { ok: false, status: 429, retryAfter: 0 };
      return { ok: true, status: 200 };
    };
    const r = await rl.runWithBackoff(fn, { attempts: 5, baseMs: 10 });
    expect(r.ok).toBe(true);
    expect(n).toBe(3);
  });

  it("does NOT retry non-transient 4xx", async () => {
    const rl = new RateLimiter(50);
    let n = 0;
    const fn = async () => { n++; return { ok: false, status: 401 }; };
    const r = await rl.runWithBackoff(fn, { attempts: 5, baseMs: 5 });
    expect(r.ok).toBe(false);
    expect(n).toBe(1);
  });

  it("gives up after `attempts`", async () => {
    const rl = new RateLimiter(100);
    let n = 0;
    const fn = async () => { n++; return { ok: false, status: 503 }; };
    const r = await rl.runWithBackoff(fn, { attempts: 3, baseMs: 5 });
    expect(r.ok).toBe(false);
    expect(n).toBe(3);
  });
});
