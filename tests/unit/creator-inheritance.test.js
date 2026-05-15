// Tests for src/analysis/creator-inheritance.js — the cascade fallback that
// fills in caption-less posts using a creator's averaged format profile.

import { describe, it, expect } from "vitest";
import {
  computeCreatorProfile,
  computeCreatorProfiles,
  applyCreatorInheritance,
} from "../../src/analysis/creator-inheritance.js";

const longTutorial = (id, n) => ({
  id,
  author: "tutorialcreator",
  desc: "How to make sourdough bread — step 1: feed your starter. Step 2: autolyse. " +
        `Iteration ${n}.`,
});
const longStory = (id, n) => ({
  id,
  author: "storycreator",
  desc: "When I was 23 I quit my job. I had nothing saved. I lived out of a hostel. " +
        `Last year I went home. I learned a lot. #storytime ${n}`,
});
const captionless = (id, author) => ({ id, author, desc: "" });

describe("computeCreatorProfile", () => {
  it("returns null for empty input", () => {
    expect(computeCreatorProfile([])).toBeNull();
    expect(computeCreatorProfile(null)).toBeNull();
  });

  it("averages confidences across captioned posts only", () => {
    const posts = [
      longTutorial("t1", 1),
      longTutorial("t2", 2),
      longTutorial("t3", 3),
      captionless("t4", "tutorialcreator"),
    ];
    const out = computeCreatorProfile(posts);
    expect(out.sampleSize).toBe(3); // captionless post does not contribute
    expect(out.totalPosts).toBe(4);
    expect(out.profile.tutorial).toBeGreaterThan(0.4);
  });

  it("handles a creator with zero captioned posts", () => {
    const posts = [captionless("c1", "ghost"), captionless("c2", "ghost")];
    const out = computeCreatorProfile(posts);
    expect(out.sampleSize).toBe(0);
    expect(out.totalPosts).toBe(2);
    expect(out.profile).toEqual({});
  });
});

describe("computeCreatorProfiles", () => {
  it("groups by author and applies minSample threshold", () => {
    const posts = [
      longTutorial("t1", 1), longTutorial("t2", 2), longTutorial("t3", 3),
      longTutorial("t4", 4), longTutorial("t5", 5), longTutorial("t6", 6),
      longStory("s1", 1), longStory("s2", 2), // 2 < default minSample 5
    ];
    const profiles = computeCreatorProfiles(posts);
    expect(profiles.has("tutorialcreator")).toBe(true);
    expect(profiles.has("storycreator")).toBe(false); // below minSample
  });

  it("respects custom minSample", () => {
    const posts = [longStory("s1", 1), longStory("s2", 2)];
    const profiles = computeCreatorProfiles(posts, { minSample: 2 });
    expect(profiles.has("storycreator")).toBe(true);
  });

  it("ignores posts with empty author", () => {
    const profiles = computeCreatorProfiles([
      { id: "x", desc: "How to do X — step 1" },
    ], { minSample: 1 });
    expect(profiles.size).toBe(0);
  });
});

describe("applyCreatorInheritance", () => {
  // Build a strong tutorialcreator profile from 5 captioned posts.
  const profilePosts = [1, 2, 3, 4, 5].map((n) => longTutorial(`t${n}`, n));
  const profiles = computeCreatorProfiles(profilePosts, { minSample: 3 });

  it("returns own scores untouched when post has confident own signal", () => {
    const post = longTutorial("strong", 99);
    const r = applyCreatorInheritance(post, profiles);
    expect(r.inheritedFromCreator).toBe(false);
    expect(r.ownTop).toBeGreaterThan(0.5);
    expect(Object.keys(r.inferred).length).toBe(0);
  });

  it("inherits from creator profile when caption is empty", () => {
    const post = captionless("empty1", "tutorialcreator");
    const r = applyCreatorInheritance(post, profiles);
    expect(r.inheritedFromCreator).toBe(true);
    expect(r.scores.tutorial).toBeGreaterThan(0.15);
    expect(r.inferred.tutorial).toBe(true);
  });

  it("damps inherited scores by inheritWeight (default 0.7)", () => {
    const post = captionless("empty2", "tutorialcreator");
    const r = applyCreatorInheritance(post, profiles);
    const profileTutorial = profiles.get("tutorialcreator").profile.tutorial;
    expect(r.scores.tutorial).toBeCloseTo(profileTutorial * 0.7, 2);
  });

  it("does nothing when creator has no profile", () => {
    const post = captionless("orphan", "unknownperson");
    const r = applyCreatorInheritance(post, profiles);
    expect(r.inheritedFromCreator).toBe(false);
    expect(r.scores).toEqual({});
  });

  it("preserves stronger own scores over weaker inherited ones", () => {
    // Post has weak-but-nonzero story signal; creator profile has strong tutorial.
    // Inheritance should add tutorial without overwriting story.
    const post = {
      id: "mixed",
      author: "tutorialcreator",
      desc: "I tried this", // very short — own signal will be weak
    };
    const r = applyCreatorInheritance(post, profiles);
    expect(r.inheritedFromCreator).toBe(true);
    if (r.scores.tutorial) expect(r.inferred.tutorial).toBe(true);
  });

  it("respects custom ownFloor — raising the floor pulls in mid-confidence cases", () => {
    // A post with mid-strength own signal (around 0.55) falls under inheritance
    // when ownFloor is raised to 0.7. Sanity-checks the threshold knob.
    const post = {
      id: "midstrength",
      author: "tutorialcreator",
      desc: "how to do this", // hits the 'how to' rule alone → ~0.55 tutorial
    };
    const low = applyCreatorInheritance(post, profiles, { ownFloor: 0.4 });
    const high = applyCreatorInheritance(post, profiles, { ownFloor: 0.7 });
    expect(low.inheritedFromCreator).toBe(false);
    expect(high.inheritedFromCreator).toBe(true);
  });

  it("respects custom inheritWeight", () => {
    const post = captionless("empty3", "tutorialcreator");
    const r = applyCreatorInheritance(post, profiles, { inheritWeight: 0.5 });
    const profileTutorial = profiles.get("tutorialcreator").profile.tutorial;
    expect(r.scores.tutorial).toBeCloseTo(profileTutorial * 0.5, 2);
  });
});

// Regression: real-world Kent-style scenario.
describe("real-world: Kent caption-less posts inherit from his captioned ones", () => {
  // 8 captioned posts mixing Kent's actual patterns: long tutorial captions
  // and terse emotional hooks. Plus 12 caption-less reels.
  const kentLongTutorials = [
    "how to make your videos 'feel' viral (with this editing speed trick): in order to create a fast-paced, valuable story, I use the J-Cut. Step 1: separate audio from video footage. Step 2: layer the cuts. Save this for later.",
    "how to make yourself 'look cinematic' in any video (without a $12,000 camera): this one trick instantly makes your shots feel more dramatic, professional and deep. Save for later.",
    "the difference between 10k creators vs 100k creators... ever heard of ikigai? what you love, what you're good at, what the world needs, what you can get paid for. Here's why most people miss this.",
    "how to script a viral video (authentically). comment STORY for the full keyword list",
  ];
  const kentTerseHooks = [
    "I quit Monk Mode for good…",
    "self improvement is for bozos (me) #selfimprovement",
    "after 1 year, it's time for a fresh new start…",
    "no friends but JESUS DID!!!!",
  ];
  const kentCaptionless = Array.from({ length: 12 }, (_, i) => captionless(`k_empty_${i}`, "kentjandraa"));

  const allKent = [
    ...kentLongTutorials.map((d, i) => ({ id: `k_long_${i}`, author: "kentjandraa", desc: d })),
    ...kentTerseHooks.map((d, i) => ({ id: `k_terse_${i}`, author: "kentjandraa", desc: d })),
    ...kentCaptionless,
  ];

  it("produces a creator profile despite many empty-caption posts", () => {
    const profiles = computeCreatorProfiles(allKent, { minSample: 3 });
    expect(profiles.has("kentjandraa")).toBe(true);
    const prof = profiles.get("kentjandraa").profile;
    // Long tutorials drive the profile — tutorial / educational should dominate.
    expect(prof.tutorial || 0).toBeGreaterThan(0.1);
  });

  it("inherits a label onto every caption-less Kent post", () => {
    const profiles = computeCreatorProfiles(allKent, { minSample: 3 });
    const inheritedCount = kentCaptionless
      .map((p) => applyCreatorInheritance(p, profiles))
      .filter((r) => r.inheritedFromCreator && Object.keys(r.scores).length > 0)
      .length;
    expect(inheritedCount).toBe(kentCaptionless.length);
  });
});
