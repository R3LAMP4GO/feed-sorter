import { describe, expect, it } from "vitest";
import { deriveScope } from "../../src/lib/scope-tiktok.js";

describe("scope-tiktok", () => {
  it("classifies discovery pages without a current video", () => {
    expect(deriveScope("/")).toEqual({ kind: "explore", username: null, videoId: null });
    expect(deriveScope("/foryou")).toEqual({ kind: "explore", username: null, videoId: null });
    expect(deriveScope("/explore")).toEqual({ kind: "explore", username: null, videoId: null });
  });

  it("classifies profile pages without a current video", () => {
    expect(deriveScope("/@Khaby.Lame")).toEqual({ kind: "profile", username: "khaby.lame", videoId: null });
  });

  it("extracts current video ids from TikTok permalinks", () => {
    expect(deriveScope("/@Khaby.Lame/video/7301000000000000001")).toEqual({
      kind: "profile",
      username: "khaby.lame",
      videoId: "7301000000000000001",
    });
  });

  it("handles reserved and off-feed paths", () => {
    expect(deriveScope("/api/foo")).toEqual({ kind: "other", username: null, videoId: null });
    expect(deriveScope("/video/123")).toEqual({ kind: "other", username: null, videoId: null });
  });
});
