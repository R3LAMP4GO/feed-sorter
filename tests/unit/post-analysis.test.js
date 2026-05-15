// Unit tests for src/analysis/post-analysis.js
//
// We mock the `chat` adapter (the same shape as src/lib/llm.js's chat()),
// then assert it's called twice in parallel with correct schemas, that the
// merged Post.ai shape is right, and that a cache hit short-circuits the
// network call.

import { describe, it, expect, beforeEach } from "vitest";
import {
  analyzePost,
  HOOK_SCHEMA,
  TOPIC_SCHEMA,
  HOOK_TYPES,
  buildUserContent,
  descHashOf,
  _resetCache,
  detectFormat,
  FORMATS,
} from "../../src/analysis/post-analysis.js";

const mkPost = (over = {}) => ({
  id: "p1",
  desc: "5 macros myths that are wrecking your gains",
  transcriptSegments: [
    { text: "Most people think protein is the whole game." },
    { text: "It is not." },
    { text: "Here is what actually moves the needle." },
    { text: "Segment four — should NOT be included." },
  ],
  ...over,
});

const mkChat = () => {
  const calls = [];
  let resolveAll;
  const allStarted = new Promise((res) => { resolveAll = res; });
  let started = 0;
  const chat = async (payload) => {
    calls.push(payload);
    started++;
    if (started === 2) resolveAll();
    // Wait until BOTH have started before either resolves — this proves
    // analyzePost fired them in parallel (Promise.all), not sequentially.
    await allStarted;
    if (payload.kind === "hook") {
      return { json: { hook: "5 macro myths wrecking your gains", hookType: "listicle" } };
    }
    return { json: { json: undefined, topic: "Macros", angle: "Myth-Busting" }, };
  };
  return { chat, calls };
};

describe("analyzePost", () => {
  beforeEach(() => _resetCache());

  it("calls chat() twice in parallel with the right schemas", async () => {
    const { chat, calls } = mkChat();
    const post = mkPost();
    const ai = await analyzePost(post, { chat, model: "gemma4" });

    expect(calls).toHaveLength(2);
    const byKind = Object.fromEntries(calls.map((c) => [c.kind, c]));
    expect(byKind.hook).toBeDefined();
    expect(byKind.topic).toBeDefined();
    expect(byKind.hook.schema).toEqual(HOOK_SCHEMA);
    expect(byKind.topic.schema).toEqual(TOPIC_SCHEMA);
    expect(byKind.hook.model).toBe("gemma4");
    expect(byKind.topic.model).toBe("gemma4");
    expect(byKind.hook.postId).toBe("p1");

    // Both messages share the SAME user content (caption + first 3 segments).
    expect(byKind.hook.messages[1].content).toBe(byKind.topic.messages[1].content);
    expect(byKind.hook.messages[1].content).toContain("CAPTION:");
    expect(byKind.hook.messages[1].content).toContain("TRANSCRIPT (first 3 segments)");
    expect(byKind.hook.messages[1].content).not.toContain("Segment four");

    // Merged onto Post.ai.
    expect(ai.hook).toBe("5 macro myths wrecking your gains");
    expect(ai.hookType).toBe("listicle");
    expect(ai.topic).toBe("macros");        // lowercased
    expect(ai.angle).toBe("myth-busting");  // lowercased
    expect(ai.model).toBe("gemma4");
    expect(typeof ai.analyzedAt).toBe("number");
    expect(ai.descHash).toBe(descHashOf(post));
    expect(ai.cached).toBe(false);
  });

  it("caps hook to 12 words and falls back hookType to 'other' on bad enum", async () => {
    const calls = [];
    const chat = async (payload) => {
      calls.push(payload);
      if (payload.kind === "hook") {
        return {
          json: {
            hook: "one two three four five six seven eight nine ten eleven twelve THIRTEEN FOURTEEN",
            hookType: "not-a-real-type",
          },
        };
      }
      return { json: { topic: "x", angle: "y" } };
    };
    const ai = await analyzePost(mkPost(), { chat });
    expect(ai.hook.split(/\s+/)).toHaveLength(12);
    expect(ai.hook.endsWith("twelve")).toBe(true);
    expect(HOOK_TYPES).toContain(ai.hookType);
    expect(ai.hookType).toBe("other");
  });

  it("cache hit on (model, promptHash) skips the chat() call", async () => {
    const cache = new Map();
    let n = 0;
    const chat = async (payload) => {
      n++;
      return payload.kind === "hook"
        ? { json: { hook: "hi", hookType: "question" } }
        : { json: { topic: "t", angle: "a" } };
    };
    const post = mkPost();

    const ai1 = await analyzePost(post, { chat, cache });
    expect(n).toBe(2);
    expect(ai1.cached).toBe(false);

    // Second call with the SAME post + cache → no network calls.
    const ai2 = await analyzePost(post, { chat, cache });
    expect(n).toBe(2); // unchanged
    expect(ai2.cached).toBe(true);
    expect(ai2.hook).toBe(ai1.hook);
    expect(ai2.topic).toBe(ai1.topic);
  });

  it("cache key includes the model — different model bypasses cache", async () => {
    const cache = new Map();
    let n = 0;
    const chat = async (p) => {
      n++;
      return p.kind === "hook"
        ? { json: { hook: "h", hookType: "story-open" } }
        : { json: { topic: "t", angle: "a" } };
    };
    await analyzePost(mkPost(), { chat, cache, model: "gemma4" });
    expect(n).toBe(2);
    await analyzePost(mkPost(), { chat, cache, model: "llama3" });
    expect(n).toBe(4);
  });

  it("descHash invalidates when the caption changes", async () => {
    const a = mkPost({ desc: "first" });
    const b = mkPost({ desc: "second" });
    expect(descHashOf(a)).not.toBe(descHashOf(b));
  });

  it("buildUserContent omits the transcript section when no segments present", () => {
    const c = buildUserContent({ desc: "hello", transcriptSegments: null });
    expect(c).toContain("CAPTION:");
    expect(c).not.toContain("TRANSCRIPT");
  });

  it("throws if chat returns no JSON", async () => {
    const chat = async () => ({ json: null });
    await expect(analyzePost(mkPost(), { chat })).rejects.toThrow(/no JSON/);
  });
});

describe("detectFormat", () => {
  it("exposes FORMATS as a stable enum array", () => {
    expect(FORMATS).toEqual([
      "list", "story", "tip", "tutorial", "hottake",
      "reaction", "dayinlife", "beforeafter", "other",
    ]);
  });

  it("detects list from a digit-led caption", () => {
    expect(detectFormat({ desc: "5 things you didn't know about sleep" })).toBe("list");
    expect(detectFormat({ desc: "3. Drink water before coffee" })).toBe("list");
  });

  it("detects list from 3+ bullet/numbered lines", () => {
    const desc = "Here we go:\n- one\n- two\n• three";
    expect(detectFormat({ desc })).toBe("list");
    const numbered = "Recap:\n1. alpha\n2. beta\n3. gamma";
    expect(detectFormat({ desc: numbered })).toBe("list");
  });

  it("detects tutorial from caption keywords or numbered transcript steps", () => {
    expect(detectFormat({ desc: "How to fix your sleep in 7 days" })).toBe("tutorial");
    expect(detectFormat({ desc: "A complete guide to macros" })).toBe("tutorial");
    expect(detectFormat({
      desc: "watch this",
      transcriptSegments: [{ text: "Step 1, mix the eggs." }],
    })).toBe("tutorial");
  });

  it("detects beforeafter from before+after or transformation/results", () => {
    expect(detectFormat({ desc: "before vs after — 12 weeks of training" })).toBe("beforeafter");
    expect(detectFormat({ desc: "my transformation took two years" })).toBe("beforeafter");
    expect(detectFormat({ desc: "results from my 30-day cut" })).toBe("beforeafter");
  });

  it("detects dayinlife from routine phrases", () => {
    expect(detectFormat({ desc: "day in my life as a dev" })).toBe("dayinlife");
    expect(detectFormat({ desc: "my morning routine that changed everything" })).toBe("dayinlife");
    expect(detectFormat({ desc: "daily routine of a CEO" })).toBe("dayinlife");
  });

  it("detects reaction from react/watching/my thoughts on", () => {
    expect(detectFormat({ desc: "reacting to the worst diet advice on tiktok" })).toBe("reaction");
    expect(detectFormat({ desc: "my thoughts on the new iphone" })).toBe("reaction");
    expect(detectFormat({ desc: "watching this go viral was wild" })).toBe("reaction");
  });

  it("detects hottake from unpopular opinion / hot take / controversial", () => {
    expect(detectFormat({ desc: "unpopular opinion: cardio is overrated" })).toBe("hottake");
    expect(detectFormat({ desc: "hot take incoming" })).toBe("hottake");
    expect(detectFormat({ desc: "controversial but true" })).toBe("hottake");
  });

  it("detects tip from tip:/pro tip/quick tip or 'if you' opener", () => {
    expect(detectFormat({ desc: "pro tip for new lifters" })).toBe("tip");
    expect(detectFormat({ desc: "tip: drink water first thing" })).toBe("tip");
    expect(detectFormat({ desc: "quick tip for editors" })).toBe("tip");
    expect(detectFormat({ desc: "if you struggle to focus, try this" })).toBe("tip");
  });

  it("detects story from heavy first-person + ≥30 words", () => {
    const desc = "I was broke and burnt out when I started my company. "
      + "My partner believed in me and we kept going through every closed door. "
      + "This is the part nobody tells you about ambition.";
    expect(detectFormat({ desc })).toBe("story");
  });

  it("falls back to other when nothing matches", () => {
    expect(detectFormat({ desc: "hello world" })).toBe("other");
    expect(detectFormat({ desc: "" })).toBe("other");
    expect(detectFormat({})).toBe("other");
  });
});
