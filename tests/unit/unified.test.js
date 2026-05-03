import { describe, it, expect, beforeAll } from "vitest";

let U;
beforeAll(async () => {
  await import("../../src/lib/unified.js"); // registers globalThis.__fsUnified
  U = globalThis.__fsUnified;
});

describe("unified schema", () => {
  it("exposes the documented surface", () => {
    expect(U.SCHEMA_VERSION).toBe(1);
    expect(U.PLATFORMS.INSTAGRAM).toBe("instagram");
    expect(U.PLATFORMS.TIKTOK).toBe("tiktok");
    expect(U.PLATFORMS.YOUTUBE_SHORTS).toBe("youtube_shorts");
    expect(typeof U.makeUnified).toBe("function");
    expect(typeof U.fromInstagramPost).toBe("function");
    expect(typeof U.unifiedToAirtableFields).toBe("function");
    expect(typeof U.computeCrossPlatformOutliers).toBe("function");
  });

  it("makeUnified coerces and defaults all fields", () => {
    const u = U.makeUnified({ platform: "tiktok", id: "abc", author: "@foo", views: "1000", likes: -5 });
    expect(u.author).toBe("foo");          // strips @
    expect(u.views).toBe(1000);            // string -> number
    expect(u.likes).toBe(0);               // negative clamped
    expect(u.shares).toBe(0);              // missing default
    expect(u.schemaVersion).toBe(1);
    expect(u.capturedAt).toBeGreaterThan(0);
    expect(U.validateUnified(u)).toEqual([]);
  });

  it("rejects unknown platform / missing id", () => {
    expect(() => U.makeUnified({ platform: "myspace", id: "x" })).toThrow();
    expect(() => U.makeUnified({ platform: "tiktok" })).toThrow();
  });

  it("fromInstagramPost prefixes id and infers reel URL", () => {
    const u = U.fromInstagramPost(
      { id: "999", shortcode: "ABC", isReel: true, author: "x", likes: 10, _score: 3, _scoreBasis: "author" },
      { extensionVersion: "0.1.0" },
    );
    expect(u.id).toBe("ig_999");
    expect(u.url).toBe("https://www.instagram.com/reel/ABC/");
    expect(u.platform).toBe("instagram");
    expect(u.score).toBe(3);
    expect(u.sourceExtensionVersion).toBe("ig@0.1.0");
  });

  it("computeCrossPlatformOutliers baselines per platform", () => {
    const rows = [
      { platform: "instagram", views: 100 },
      { platform: "instagram", views: 200 },
      { platform: "instagram", views: 1000 }, // 5x IG median (200)
      { platform: "tiktok", views: 10000 },
      { platform: "tiktok", views: 20000 },
      { platform: "tiktok", views: 200000 },  // 10x TikTok median (20000)
    ];
    const scored = U.computeCrossPlatformOutliers(rows, "views");
    expect(scored[2]._score).toBe(5);
    expect(scored[5]._score).toBe(10);
    // TikTok absolute view count is 200x larger but gets scored on its
    // own scale — the IG row would be unfairly dwarfed without this.
  });

  it("unifiedToAirtableFields preserves keys", () => {
    const u = U.makeUnified({ platform: "instagram", id: "ig_1", createTime: 1700000000 });
    const f = U.unifiedToAirtableFields(u);
    expect(f.id).toBe("ig_1");
    expect(f.platform).toBe("instagram");
    expect(f.createdAt).toMatch(/^2023-/);
    expect(f.schemaVersion).toBe(1);
  });
});
