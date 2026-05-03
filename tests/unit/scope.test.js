import { describe, it, expect } from "vitest";
import { deriveScope, RESERVED } from "../../src/lib/scope.js";

describe("deriveScope", () => {
  it("returns 'other' for / (home feed)", () => {
    expect(deriveScope("/")).toEqual({ kind: "other", username: null });
  });

  it("recognizes /explore and /explore/...", () => {
    expect(deriveScope("/explore/")).toEqual({ kind: "explore", username: null });
    expect(deriveScope("/explore/people/")).toEqual({
      kind: "explore",
      username: null,
    });
  });

  it("recognizes /{user}/", () => {
    expect(deriveScope("/zachking/")).toEqual({
      kind: "profile",
      username: "zachking",
    });
  });

  it("recognizes /{user}/reels/", () => {
    expect(deriveScope("/zachking/reels/")).toEqual({
      kind: "profile",
      username: "zachking",
    });
  });

  it("recognizes single-segment /{user}", () => {
    expect(deriveScope("/zach")).toEqual({ kind: "profile", username: "zach" });
  });

  it("returns 'other' for /p/{shortcode}/", () => {
    expect(deriveScope("/p/abc/")).toEqual({ kind: "other", username: null });
  });

  it("returns 'other' for /reel/{shortcode}/", () => {
    expect(deriveScope("/reel/abc/")).toEqual({ kind: "other", username: null });
  });

  it("returns 'other' for /accounts/login/", () => {
    expect(deriveScope("/accounts/login/")).toEqual({
      kind: "other",
      username: null,
    });
  });

  it("returns 'other' for /direct/inbox/", () => {
    expect(deriveScope("/direct/inbox/")).toEqual({
      kind: "other",
      username: null,
    });
  });

  it("rejects reserved usernames as 'other'", () => {
    expect(deriveScope("/explore")).toEqual({ kind: "explore", username: null });
    // 'reels' / 'p' / 'api' / 'direct' as single segments → 'other'
    expect(deriveScope("/reels")).toEqual({ kind: "other", username: null });
    expect(deriveScope("/p")).toEqual({ kind: "other", username: null });
    expect(deriveScope("/api")).toEqual({ kind: "other", username: null });
  });

  it("lowercases username", () => {
    expect(deriveScope("/ZachKing/")).toEqual({
      kind: "profile",
      username: "zachking",
    });
  });

  it("RESERVED set contains expected keywords", () => {
    expect(RESERVED.has("explore")).toBe(true);
    expect(RESERVED.has("p")).toBe(true);
    expect(RESERVED.has("reels")).toBe(true);
    expect(RESERVED.has("zachking")).toBe(false);
  });
});
