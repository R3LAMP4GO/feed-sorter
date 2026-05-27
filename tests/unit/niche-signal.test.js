// Unit tests for src/lib/niche-signal.js — the cascade that picks which
// text source clusterNiches embeds for each creator.
//
// The key user-facing assertion is the talking-head-sales case: when the
// creator's CAPTIONS sound generic ("hey guys, today I want to talk about
// mindset…") but the BIO is specific ("Real Estate Agent in SF"), we must
// pick bio. That's the whole reason this module exists.

import { describe, it, expect, beforeAll } from "vitest";
import {
  pickNicheSignal,
  profileToNicheText,
  wordCountAlnum,
  __defaults,
} from "../../src/lib/niche-signal.js";

const mkPost = (over = {}) => ({
  id: `p${Math.random().toString(36).slice(2)}`,
  author: "sarah.realtor",
  desc: "",
  likes: 100,
  ...over,
});

const mkCreator = (over = {}) => ({
  username: "sarah.realtor",
  niche: "",
  nichePinned: false,
  bio: "",
  category: "",
  fullName: "",
  externalUrl: "",
  ...over,
});

describe("pickNicheSignal cascade", () => {
  it("picks 'bio' when bio is rich enough — even with generic-sounding captions", () => {
    const creator = mkCreator({
      bio: "Helping families find their dream home in SF & Peninsula",
      category: "Real Estate Agent",
      fullName: "Sarah Chen",
      externalUrl: "https://www.sarahchenhomes.com/",
    });
    const posts = [
      mkPost({ desc: "hey guys, today I want to talk about mindset and growth, listen up", likes: 5000 }),
      mkPost({ desc: "the one thing nobody tells you about success", likes: 8000 }),
      mkPost({ desc: "swipe to see why this matters so much", likes: 3000 }),
    ];
    const out = pickNicheSignal(creator, posts);
    expect(out.source).toBe("bio");
    expect(out.text).toContain("Real Estate Agent");
    expect(out.text).toContain("sarahchenhomes.com");
    expect(out.debug.bioPresent).toBe(true);
    expect(out.debug.bioWords).toBeGreaterThanOrEqual(__defaults.minBioWords);
  });

  it("falls through to 'captions' when bio is too short", () => {
    const creator = mkCreator({ bio: "vibes" }); // 1 word
    const posts = Array.from({ length: 5 }, (_, i) => mkPost({
      desc: "crushing my squat PR this week, hit 405 for 3 reps macros are key #fitness",
      likes: 500 * (i + 1),
    }));
    const out = pickNicheSignal(creator, posts);
    expect(out.source).toBe("captions");
    expect(out.text).toContain("squat");
    expect(out.debug.bioWords).toBeLessThan(__defaults.minBioWords);
  });

  it("falls through to 'tags' when bio is empty and captions are empty (tags come from hashtags[] field)", () => {
    const creator = mkCreator({});
    // Empty captions → caption blob is "", captionWords is 0. Hashtags
    // arrive on the post.hashtags field (some platform parsers populate
    // this directly instead of leaving them inline in desc).
    const posts = [
      mkPost({ desc: "", hashtags: ["fitness", "protein"], likes: 100 }),
      mkPost({ desc: "", hashtags: ["macros"], likes: 200 }),
    ];
    const out = pickNicheSignal(creator, posts);
    expect(out.source).toBe("tags");
    expect(out.text).toContain("#fitness");
    expect(out.text).toContain("#protein");
    expect(out.debug.tagCount).toBeGreaterThanOrEqual(__defaults.minHashtags);
    expect(out.debug.captionWords).toBe(0);
  });

  it("returns 'none' when nothing is usable", () => {
    const creator = mkCreator({});
    const posts = [mkPost({ desc: "" })];
    const out = pickNicheSignal(creator, posts);
    expect(out.source).toBe("none");
    expect(out.text).toBe("");
    expect(out.wordCount).toBe(0);
  });

  it("respects custom thresholds (tiny minBioWords pushes everything to 'bio')", () => {
    const creator = mkCreator({ bio: "vibes" });
    const posts = [mkPost({ desc: "real estate squat squat squat", likes: 1 })];
    const out = pickNicheSignal(creator, posts, { minBioWords: 1 });
    expect(out.source).toBe("bio");
  });

  it("hashtags can be passed via post.hashtags array OR parsed from desc", () => {
    const fromArray = pickNicheSignal(
      mkCreator(),
      [mkPost({ desc: "no tags here", hashtags: ["realestate", "broker"] })],
    );
    expect(fromArray.source).toBe("tags");
    expect(fromArray.text).toContain("#realestate");

    const fromDesc = pickNicheSignal(
      mkCreator(),
      [mkPost({ desc: "hi #realestate #broker" })],
    );
    expect(fromDesc.source).toBe("tags");
    expect(fromDesc.text).toContain("#realestate");
  });

  it("debug payload always carries username + the three signal sizes (for logging)", () => {
    const creator = mkCreator({ bio: "x" });
    const posts = [mkPost({ desc: "hi #fit" })];
    const out = pickNicheSignal(creator, posts);
    expect(out.debug.username).toBe("sarah.realtor");
    expect(out.debug).toHaveProperty("bioWords");
    expect(out.debug).toHaveProperty("captionWords");
    expect(out.debug).toHaveProperty("tagCount");
    expect(out.debug).toHaveProperty("pinned");
  });

  it("surfaces pinned label so the cascade caller knows to skip relabeling", () => {
    const creator = mkCreator({
      niche: "Real Estate",
      nichePinned: true,
      bio: "Realtor in SF",
      category: "Real Estate Agent",
    });
    const out = pickNicheSignal(creator, []);
    expect(out.debug.pinned).toBe(true);
    expect(out.debug.pinnedLabel).toBe("Real Estate");
    // It still returns the bio signal — caller decides whether to honor the pin.
    expect(out.source).toBe("bio");
  });

  it("top-N outlier ordering: captions text leads with the highest-outlier post", () => {
    const creator = mkCreator({});
    const posts = [
      mkPost({ desc: "low banger talk talk talk talk talk talk", likes: 100 }),
      mkPost({ desc: "huge winner viral viral viral viral viral viral", likes: 50000 }),
    ];
    const out = pickNicheSignal(creator, posts, { minCaptionWords: 1 });
    expect(out.source).toBe("captions");
    // 'huge winner' (likes=50000) outliers higher than 'low banger' (likes=100).
    const huge = out.text.indexOf("huge winner");
    const low = out.text.indexOf("low banger");
    expect(huge).toBeGreaterThanOrEqual(0);
    expect(low).toBeGreaterThan(huge);
  });

  it("handles missing/null inputs without throwing", () => {
    expect(() => pickNicheSignal(null, null)).not.toThrow();
    const out = pickNicheSignal(null, null);
    expect(out.source).toBe("none");
  });
});

describe("profileToNicheText", () => {
  it("includes hostname when external URL parses, drops when it doesn't", () => {
    expect(profileToNicheText({ category: "x", externalUrl: "https://acme.fit/path" }))
      .toBe("x • acme.fit");
    expect(profileToNicheText({ category: "x", externalUrl: "no" })).toBe("x");
  });
});

describe("wordCountAlnum", () => {
  it("counts only alnum tokens of length ≥3", () => {
    expect(wordCountAlnum("a bb ccc dddd")).toBe(2);
    // 'Real','Estate','Agent','NYC' qualify; 'in' is <3 chars.
    expect(wordCountAlnum("Real Estate Agent in NYC")).toBe(4);
  });
});

describe("IIFE runtime mirror parity", () => {
  let R;
  beforeAll(async () => {
    await import("../../src/lib/niche-signal-runtime.js");
    R = globalThis.__fsNicheSignal;
  });

  it("DEFAULTS thresholds match the ESM module", () => {
    expect(R.DEFAULTS).toEqual(__defaults);
  });

  it("pickNicheSignal returns the same source + text for canonical inputs", () => {
    const cases = [
      [mkCreator({ bio: "Real Estate Agent in SF helping buyers", category: "Real Estate Agent" }),
       [mkPost({ desc: "hi", likes: 1 })]],
      [mkCreator({}), [mkPost({ desc: "squat deadlift bench macros protein fitness", likes: 100 })]],
      [mkCreator({}), [mkPost({ desc: "hi #fit #abs" })]],
      [mkCreator({}), [mkPost({ desc: "" })]],
    ];
    for (const [c, p] of cases) {
      const a = pickNicheSignal(c, p);
      const b = R.pickNicheSignal(c, p);
      expect(b.source).toBe(a.source);
      expect(b.text).toBe(a.text);
      expect(b.wordCount).toBe(a.wordCount);
    }
  });
});
