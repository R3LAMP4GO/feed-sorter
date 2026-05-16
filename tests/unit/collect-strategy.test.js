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
const makeStubDoc = ({ buttons = {}, scrollHeight = 1000, disabledNext = false, containers = [] } = {}) => {
  const scrollCalls = [];
  const scrollByCalls = [];
  const containerScrollCalls = [];
  const clickCalls = [];
  const keyCalls = [];
  const wheelCalls = [];

  function StubKeyboardEvent(type, opts) {
    this.type = type;
    this.opts = opts;
  }

  function StubWheelEvent(type, opts) {
    this.type = type;
    this.opts = opts;
  }

  const makeButton = (sel) => ({
    click: () => clickCalls.push(sel),
    disabled: disabledNext,
    getAttribute(name) {
      if (name === "aria-disabled") return disabledNext ? "true" : "false";
      if (name === "disabled") return disabledNext ? "" : null;
      return null;
    },
  });

  const matched = new Map();
  for (const sel of Object.keys(buttons)) {
    matched.set(sel, buttons[sel] === true ? makeButton(sel) : buttons[sel]);
  }
  const containerNodes = containers.map((name) => ({
    name,
    scrollHeight: 2000,
    clientHeight: 700,
    classList: { contains: () => false },
    dispatchEvent: (event) => wheelCalls.push([name, event.type, event.opts?.deltaY]),
    scrollBy: (x, y) => containerScrollCalls.push([name, x, y]),
  }));

  const doc = {
    body: { dispatchEvent: (event) => wheelCalls.push(["body", event.type, event.opts?.deltaY]) },
    documentElement: {
      scrollHeight,
      clientHeight: 700,
      dispatchEvent: (event) => wheelCalls.push(["html", event.type, event.opts?.deltaY]),
    },
    activeElement: null,
    elementFromPoint: () => containerNodes[0] || null,
    querySelector(sel) {
      return matched.get(sel) || null;
    },
    querySelectorAll(sel) {
      if (sel === '[data-e2e="recommend-list-container"]') return containerNodes;
      if (sel === "body, html, div") return containerNodes;
      return [];
    },
    defaultView: {
      innerWidth: 1280,
      innerHeight: 720,
      KeyboardEvent: StubKeyboardEvent,
      WheelEvent: StubWheelEvent,
      dispatchEvent: (event) => {
        if (event.type === "wheel") wheelCalls.push(["window", event.type, event.opts?.deltaY]);
        else keyCalls.push([event.type, event.opts.key]);
      },
      scrollTo: (x, y) => scrollCalls.push([x, y]),
      scrollBy: (x, y) => scrollByCalls.push([x, y]),
    },
  };
  return { doc, scrollCalls, scrollByCalls, containerScrollCalls, clickCalls, keyCalls, wheelCalls };
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

  it("advance() falls back to keyboard/wheel/scroll when no next-button is present", () => {
    const { doc, clickCalls, keyCalls, wheelCalls, scrollByCalls } = makeStubDoc({ buttons: {} });
    expect(strategy.advance({ doc })).toBe(true);
    expect(clickCalls).toEqual([]);
    expect(keyCalls).toEqual([
      ["keydown", "ArrowDown"],
      ["keyup", "ArrowDown"],
    ]);
    expect(wheelCalls.some((call) => call[1] === "wheel" && call[2] === 720)).toBe(true);
    expect(scrollByCalls).toEqual([[0, 720]]);
  });

  it("advance() skips disabled buttons and falls back to synthetic navigation", () => {
    const { doc, clickCalls, scrollByCalls } = makeStubDoc({
      buttons: { "#navigation-button-down button": true },
      disabledNext: true,
    });
    expect(strategy.advance({ doc })).toBe(true);
    expect(clickCalls).toEqual([]);
    expect(scrollByCalls).toEqual([[0, 720]]);
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

  it("TT profile keeps the scroll strategy, while For You/Explore use snap navigation", () => {
    const tt = getConfig(PLATFORMS.TIKTOK);
    const s1 = tt.collectStrategy({ kind: "profile", username: "khaby.lame" });
    const s2 = tt.collectStrategy({ kind: "explore", username: null });
    expect(s1.kind).toBe("scroll");
    expect(s2.kind).toBe("snap");
    expect(s1.useScrollHeightStall).toBe(true);
    expect(s2.useScrollHeightStall).toBe(false);
    expect(s2.useIdleEnd).toBe(false);
  });

  it("TT For You/Explore advance() clicks TikTok's next-video button when present", () => {
    const tt = getConfig(PLATFORMS.TIKTOK);
    const s = tt.collectStrategy({ kind: "explore", username: null });
    const { doc, clickCalls } = makeStubDoc({
      buttons: { 'button[data-e2e="arrow-right"]': true },
    });
    expect(s.advance({ doc })).toBe(true);
    expect(clickCalls).toEqual(['button[data-e2e="arrow-right"]']);
  });

  it("TT For You/Explore advance() returns false when the next-video button is disabled", () => {
    const tt = getConfig(PLATFORMS.TIKTOK);
    const s = tt.collectStrategy({ kind: "explore", username: null });
    const { doc, clickCalls, keyCalls } = makeStubDoc({
      buttons: { 'button[data-e2e="arrow-right"]': true },
      disabledNext: true,
    });
    expect(s.advance({ doc })).toBe(false);
    expect(clickCalls).toEqual([]);
    expect(keyCalls).toEqual([]);
  });

  it("TT For You/Explore advance() falls back to ArrowDown, wheel, and viewport scroll", () => {
    const tt = getConfig(PLATFORMS.TIKTOK);
    const s = tt.collectStrategy({ kind: "explore", username: null });
    const { doc, keyCalls, scrollByCalls, wheelCalls } = makeStubDoc({ buttons: {} });
    expect(s.advance({ doc })).toBe(true);
    expect(keyCalls).toEqual([
      ["keydown", "ArrowDown"],
      ["keyup", "ArrowDown"],
    ]);
    expect(wheelCalls.some((call) => call[1] === "wheel" && call[2] === 720)).toBe(true);
    expect(scrollByCalls).toEqual([[0, 720]]);
  });

  it("TT For You/Explore advance() scrolls TikTok's feed container when available", () => {
    const tt = getConfig(PLATFORMS.TIKTOK);
    const s = tt.collectStrategy({ kind: "explore", username: null });
    const { doc, containerScrollCalls } = makeStubDoc({ buttons: {}, containers: ["recommend"] });
    expect(s.advance({ doc })).toBe(true);
    expect(containerScrollCalls).toEqual([["recommend", 0, 720]]);
  });

  it("IG scroll.advance() calls scrollTo via the injected doc.defaultView", () => {
    const ig = getConfig(PLATFORMS.INSTAGRAM);
    const s = ig.collectStrategy({ kind: "profile", username: "zachking" });
    const { doc, scrollCalls } = makeStubDoc({ scrollHeight: 1234 });
    expect(s.advance({ doc })).toBe(true);
    expect(scrollCalls).toEqual([[0, 1234]]);
  });
});
