// Edge-case simulation suite for scoreFormats — synthesized posts mirroring
// real-world ambiguity. Each case asserts which labels MUST appear above a
// threshold and which MUST NOT. Failures dump scoreFormats output + the
// FORMAT_SIGNALS introspection so we see exactly why the heuristic fired.

import { describe, it, expect } from "vitest";
import { scoreFormats, FORMAT_SIGNALS } from "../../src/analysis/post-analysis.js";

const dump = (post) => {
  const scores = scoreFormats(post);
  const signals = FORMAT_SIGNALS(post);
  return JSON.stringify({ scores, signals }, null, 2);
};

const expectAtLeast = (post, label, min) => {
  const s = scoreFormats(post);
  const v = s[label] || 0;
  if (v < min) throw new Error(`expected ${label} >= ${min}, got ${v}\n${dump(post)}`);
};

const expectAtMost = (post, label, max) => {
  const s = scoreFormats(post);
  const v = s[label] || 0;
  if (v > max) throw new Error(`expected ${label} <= ${max}, got ${v}\n${dump(post)}`);
};

const expectInRange = (post, label, min, max) => {
  const s = scoreFormats(post);
  const v = s[label] || 0;
  if (v < min || v > max) throw new Error(`expected ${label} in [${min}, ${max}], got ${v}\n${dump(post)}`);
};

// ---------------------------------------------------------------------------
// 1. Pure storytelling — long first-person past-tense, ~60s.
//    Kent baseline analog.
// ---------------------------------------------------------------------------
describe("case 1: pure storytelling (Kent analog)", () => {
  const post = {
    id: "sim1",
    desc: "When I was 23 I quit my job with no plan. I had $4k saved and a one-way ticket. " +
          "The first month I lived out of a hostel. I told my parents I was fine even though I " +
          "wasn't. Last year I finally went back home and realized how much I had changed. " +
          "Here's what I learned. #storytime",
    durationSec: 62,
    audioIsOriginal: true,
  };

  it("story is dominant (>= 0.7)", () => expectAtLeast(post, "story", 0.7));
  it("listicle near zero (<= 0.15)", () => expectAtMost(post, "listicle", 0.15));
  it("talking_head present but not dominant (<= 0.6)", () => expectAtMost(post, "talking_head", 0.6));
});

// ---------------------------------------------------------------------------
// 2. Talking-head educational — no story.
// ---------------------------------------------------------------------------
describe("case 2: talking-head educational", () => {
  const post = {
    id: "sim2",
    desc: "Here's why most people fail at building muscle. The real reason is protein timing. " +
          "Save this for later — most people don't realize how simple it is.",
    durationSec: 45,
    audioIsOriginal: true,
  };

  it("talking_head >= 0.6", () => expectAtLeast(post, "talking_head", 0.6));
  it("educational >= 0.6", () => expectAtLeast(post, "educational", 0.6));
  it("story <= 0.3", () => expectAtMost(post, "story", 0.3));
});

// ---------------------------------------------------------------------------
// 3. Hybrid skit + educational (Jeff Nippard analog).
// ---------------------------------------------------------------------------
describe("case 3: hybrid skit + educational", () => {
  const post = {
    id: "sim3",
    desc: "Client: I'm doing 6 days of cardio for fat loss. " +
          "Coach: Here's why that's destroying your hypertrophy. The real reason most people " +
          "fail at body recomp is protein. Plot twist — it's not what you think.",
    durationSec: 72,
    audioIsOriginal: true,
  };

  it("educational >= 0.5", () => expectAtLeast(post, "educational", 0.5));
  it("skit >= 0.4", () => expectAtLeast(post, "skit", 0.4));
  it("talking_head in [0.3, 0.85]", () => expectInRange(post, "talking_head", 0.3, 0.85));

  it("multi-label: at least 3 labels above 0.4", () => {
    const s = scoreFormats(post);
    const above = Object.values(s).filter((v) => v >= 0.4).length;
    expect(above).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// 4. Listicle.
// ---------------------------------------------------------------------------
describe("case 4: listicle", () => {
  const post = {
    id: "sim4",
    desc: "5 things you didn't know about coffee 👇\n" +
          "1. It's a fruit\n" +
          "2. Decaf still has caffeine\n" +
          "3. Light roast has more caffeine\n" +
          "4. Espresso has less than drip\n" +
          "5. Coffee can go bad",
    durationSec: 35,
  };

  it("listicle >= 0.8", () => expectAtLeast(post, "listicle", 0.8));
  it("tutorial <= 0.4", () => expectAtMost(post, "tutorial", 0.4));
});

// ---------------------------------------------------------------------------
// 5. Tutorial.
// ---------------------------------------------------------------------------
describe("case 5: tutorial", () => {
  const post = {
    id: "sim5",
    desc: "How to make sourdough bread — step 1: feed your starter. Step 2: autolyse the " +
          "flour. Step 3: bulk ferment overnight. Full guide below.",
    durationSec: 90,
  };

  it("tutorial >= 0.7", () => expectAtLeast(post, "tutorial", 0.7));
  it("listicle <= 0.4", () => expectAtMost(post, "listicle", 0.4));
});

// ---------------------------------------------------------------------------
// 6. POV.
// ---------------------------------------------------------------------------
describe("case 6: POV", () => {
  const post = {
    id: "sim6",
    desc: "POV: you just got dumped and your friend says 'there's plenty of fish in the sea'",
    durationSec: 18,
    audioIsTrending: true,
  };

  it("pov >= 0.8", () => expectAtLeast(post, "pov", 0.8));
});

// ---------------------------------------------------------------------------
// 7. Reaction.
// ---------------------------------------------------------------------------
describe("case 7: reaction", () => {
  const post = {
    id: "sim7",
    desc: "not me reacting to this 😭 my thoughts on the new iphone",
    durationSec: 30,
    isDuet: true,
  };

  it("reaction >= 0.7", () => expectAtLeast(post, "reaction", 0.7));
});

// ---------------------------------------------------------------------------
// 8. Day-in-life.
// ---------------------------------------------------------------------------
describe("case 8: day-in-life", () => {
  const post = {
    id: "sim8",
    desc: "5am morning routine of a software engineer working remote",
    durationSec: 55,
  };

  it("dayinlife >= 0.7", () => expectAtLeast(post, "dayinlife", 0.7));
});

// ---------------------------------------------------------------------------
// 9. Before/after.
// ---------------------------------------------------------------------------
describe("case 9: before/after", () => {
  const post = {
    id: "sim9",
    desc: "12 week transformation — before and after photos. The results speak for themselves.",
    durationSec: 25,
  };

  it("beforeafter >= 0.7", () => expectAtLeast(post, "beforeafter", 0.7));
});

// ---------------------------------------------------------------------------
// 10. Hot take.
// ---------------------------------------------------------------------------
describe("case 10: hot take", () => {
  const post = {
    id: "sim10",
    desc: "Unpopular opinion: the gym is overrated for fat loss. Hot take incoming.",
    durationSec: 40,
  };

  it("hottake >= 0.7", () => expectAtLeast(post, "hottake", 0.7));
});

// ---------------------------------------------------------------------------
// 11. Ambiguous storytelling-vs-talking-head — both must fire moderately.
// ---------------------------------------------------------------------------
describe("case 11: ambiguous story+talking_head", () => {
  const post = {
    id: "sim11",
    desc: "I tried this for 30 days and here's what happened. I was skeptical. I kept a log. " +
          "I learned a lot. Here's the real reason it works.",
    durationSec: 50,
    audioIsOriginal: true,
  };

  it("story in [0.4, 0.7]", () => expectInRange(post, "story", 0.4, 0.7));
  it("talking_head in [0.4, 0.85]", () => expectInRange(post, "talking_head", 0.4, 0.85));
});

// ---------------------------------------------------------------------------
// 12. Adversarial: #storytime hashtag but actually a listicle.
// ---------------------------------------------------------------------------
describe("case 12: adversarial — #storytime but listicle", () => {
  const post = {
    id: "sim12",
    desc: "5 things 👇 #storytime\n1. one\n2. two\n3. three\n4. four\n5. five",
    durationSec: 30,
  };

  it("listicle dominates (>= 0.8)", () => expectAtLeast(post, "listicle", 0.8));
  it("story can fire weakly (<= 0.55)", () => expectAtMost(post, "story", 0.55));
  it("listicle > story", () => {
    const s = scoreFormats(post);
    expect((s.listicle || 0)).toBeGreaterThan((s.story || 0));
  });
});

// ---------------------------------------------------------------------------
// 13. Adversarial: short first-person caption that's actually a hot take.
// ---------------------------------------------------------------------------
describe("case 13: adversarial — first-person hot take", () => {
  const post = {
    id: "sim13",
    desc: "I'll say it: pineapple on pizza is fine and I will die on this hill. My final answer.",
    durationSec: 22,
  };

  it("hottake wins (>= 0.7)", () => expectAtLeast(post, "hottake", 0.7));
  it("hottake > story", () => {
    const s = scoreFormats(post);
    expect((s.hottake || 0)).toBeGreaterThan((s.story || 0));
  });
});

// ---------------------------------------------------------------------------
// 14. Adversarial: trending audio + 12s + zero caption.
//     With no textual signal, nothing should be > 0.7.
// ---------------------------------------------------------------------------
describe("case 14: adversarial — short trending-audio, no caption", () => {
  const post = {
    id: "sim14",
    desc: "",
    durationSec: 12,
    audioIsTrending: true,
  };

  it("nothing above 0.7", () => {
    const s = scoreFormats(post);
    for (const [k, v] of Object.entries(s)) {
      if (v > 0.7) throw new Error(`label ${k} = ${v} exceeds 0.7\n${dump(post)}`);
    }
  });
  it("skit may fire weakly (<= 0.55)", () => expectAtMost(post, "skit", 0.55));
});

// ---------------------------------------------------------------------------
// 15. Empty / emoji-only caption.
// ---------------------------------------------------------------------------
describe("case 15: emoji-only caption", () => {
  const post = {
    id: "sim15",
    desc: "🔥🔥🔥",
    durationSec: 30,
  };

  it("no label > 0.4", () => {
    const s = scoreFormats(post);
    for (const [k, v] of Object.entries(s)) {
      if (v > 0.4) throw new Error(`label ${k} = ${v} exceeds 0.4\n${dump(post)}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 16. Real-world: terse emotional hook (Kent-style IG reel).
//     The story is in the video, NOT the caption. The cheap text-only
//     classifier MUST be honest about not knowing. This case pins the gap so
//     future heuristic edits don't accidentally over-fire.
//     See tmp/classify-findings.md for the dataset analysis that produced it.
// ---------------------------------------------------------------------------
describe("case 16: terse emotional hook (Kent-style, caption-only available)", () => {
  const samples = [
    "I quit Monk Mode for good\u2026",
    "after 1 year, it\u2019s time for a fresh new start\u2026",
    "self improvement is for bozos (me) #selfimprovement",
    "no friends but JESUS DID!!!!",
    "FOMO at university\u2026",
  ];

  for (const desc of samples) {
    it(`stays humble on "${desc.slice(0, 40)}\u2026" (no label > 0.7)`, () => {
      const post = { id: "sim16", desc };
      const s = scoreFormats(post);
      for (const [k, v] of Object.entries(s)) {
        if (v > 0.7) throw new Error(`label ${k} = ${v} > 0.7 on terse hook caption \u2014 the classifier should not be confident here\n${dump(post)}`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Coverage report — proves the multi-label path is exercised across the suite.
// ---------------------------------------------------------------------------
describe("coverage report", () => {
  const corpus = [
    { id: "c1", desc: "When I was 23 I quit my job. I had nothing saved. I learned a lot. #storytime so I started over and here's what I found out", durationSec: 60, audioIsOriginal: true },
    { id: "c2", desc: "Client: I do cardio every day. Coach: Here's why that's wrong. The real reason most people fail.", durationSec: 65, audioIsOriginal: true },
    { id: "c3", desc: "I tried this for 30 days and here's what happened. I learned the real reason most people fail.", durationSec: 50, audioIsOriginal: true },
    { id: "c4", desc: "How to make sourdough — step 1: feed your starter. Save this for later.", durationSec: 80 },
  ];

  it(">= 3 corpus posts produce multi-label output", () => {
    const multi = corpus.filter((p) => Object.values(scoreFormats(p)).filter((v) => v >= 0.4).length >= 2);
    expect(multi.length).toBeGreaterThanOrEqual(3);
  });
});
