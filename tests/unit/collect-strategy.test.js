// Per-platform / per-scope collect-strategy factory.
//
// Two flavors:
//   - "scroll" (default): page-scroll until scrollHeight stalls. IG, TT, and
//     YT-channel-grid all use this.
//   - "snap":   advance the YT Shorts vertical-snap player by clicking
//     #navigation-button-down. Only YT /shorts/<id> + /feed/shorts.
//
// `advance({ doc })` reads only from the injected doc — never globalThis.
// document — so tests pass a stub document with the relevant elements.

import { describe, it, expect } from "vitest";
import { PLATFORMS, getConfig } from "../../src/lib/platform.js";

// Tiny stub of the bits of `document` that strategies touch:
//   - querySelector(selector) → returns the matching element or null
//   - documentElement.scrollHeight (read-only)
//   - defaultView.scrollTo(x, y) (write-only side effect)
const makeStubDoc = ({ buttons = {}, scrollHeight = 1000, disabledNext = false } = {}) => {
  const scrollCalls = [];
  const clickCalls = [];

  const makeButton = (sel) => ({
    click: () => clickCalls.push(sel),
    disabled: disabledNext,
  });

  const matched = new Map();
  for (const sel of Object.keys(buttons)) {
    matched.set(sel, buttons[sel] === true ? makeButton(sel) : buttons[sel]);
  }

  const doc = {
    documentElement: { scrollHeight },
    querySelector(sel) {
      return matched.get(sel) || null;
    },
    defaultView: {
      scrollTo: (x, y) => scrollCalls.push([x, y]),
    },
  };
  return { doc, scrollCalls, clickCalls };
};

describe("YT shorts-feed collect strategy (snap)", () => {
  const cfg = getConfig(PLATFORMS.YOUTUBE);
  const strategy = cfg.collectStrategy({ kind: "shorts-feed", username: null, videoId: "abc" });

  it("identifies itself as snap and skips the scrollHeight stall guard", () => {
    expect(strategy.kind).toBe("snap");
    expect(strategy.useScrollHeightStall).toBe(false);
  });

  it("advance() clicks the active reel-renderer next-button (selector tier 1)", () => {
    const { doc, clickCalls } = makeStubDoc({
      buttons: {
        "ytd-reel-video-renderer[is-active] #navigation-button-down button": true,
      },
    });
    expect(strategy.advance({ doc })).toBe(true);
    expect(clickCalls).toEqual([
      "ytd-reel-video-renderer[is-active] #navigation-button-down button",
    ]);
  });

  it("advance() falls through to selector tier 3 when the active-reel selector misses", () => {
    const { doc, clickCalls } = makeStubDoc({
      buttons: { "#navigation-button-down button": true },
    });
    expect(strategy.advance({ doc })).toBe(true);
    expect(clickCalls).toEqual(["#navigation-button-down button"]);
  });

  it("advance() returns false when no next-button is present (end-of-feed signal)", () => {
    const { doc, clickCalls } = makeStubDoc({ buttons: {} });
    expect(strategy.advance({ doc })).toBe(false);
    expect(clickCalls).toEqual([]);
  });

  it("advance() skips disabled buttons and returns false", () => {
    const { doc, clickCalls } = makeStubDoc({
      buttons: { "#navigation-button-down button": true },
      disabledNext: true,
    });
    expect(strategy.advance({ doc })).toBe(false);
    expect(clickCalls).toEqual([]);
  });
});

describe("YT channel-grid collect strategy (scroll)", () => {
  const cfg = getConfig(PLATFORMS.YOUTUBE);

  it("returns the scroll strategy for kind=profile", () => {
    const s = cfg.collectStrategy({ kind: "profile", username: "fitwithmaya" });
    expect(s.kind).toBe("scroll");
    expect(s.useScrollHeightStall).toBe(true);
  });

  it("scroll.advance() calls scrollTo(0, scrollHeight)", () => {
    const s = cfg.collectStrategy({ kind: "profile", username: "fitwithmaya" });
    const { doc, scrollCalls } = makeStubDoc({ scrollHeight: 4242 });
    expect(s.advance({ doc })).toBe(true);
    expect(scrollCalls).toEqual([[0, 4242]]);
  });
});

describe("IG + TT collect strategies (scroll, regression)", () => {
  it("IG returns the scroll strategy regardless of scope", () => {
    const ig = getConfig(PLATFORMS.INSTAGRAM);
    const s1 = ig.collectStrategy({ kind: "profile", username: "zachking" });
    const s2 = ig.collectStrategy({ kind: "explore", username: null });
    expect(s1.kind).toBe("scroll");
    expect(s2.kind).toBe("scroll");
    expect(s1.useScrollHeightStall).toBe(true);
    expect(s2.useScrollHeightStall).toBe(true);
  });

  it("TT returns the scroll strategy regardless of scope", () => {
    const tt = getConfig(PLATFORMS.TIKTOK);
    const s1 = tt.collectStrategy({ kind: "profile", username: "khaby.lame" });
    const s2 = tt.collectStrategy({ kind: "explore", username: null });
    expect(s1.kind).toBe("scroll");
    expect(s2.kind).toBe("scroll");
    expect(s1.useScrollHeightStall).toBe(true);
    expect(s2.useScrollHeightStall).toBe(true);
  });

  it("IG scroll.advance() calls scrollTo via the injected doc.defaultView", () => {
    const ig = getConfig(PLATFORMS.INSTAGRAM);
    const s = ig.collectStrategy({ kind: "profile", username: "zachking" });
    const { doc, scrollCalls } = makeStubDoc({ scrollHeight: 1234 });
    expect(s.advance({ doc })).toBe(true);
    expect(scrollCalls).toEqual([[0, 1234]]);
  });
});
