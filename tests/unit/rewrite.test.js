// Unit tests for src/analysis/rewrite.js
//
// Mocks the `chat` adapter (same shape as src/lib/llm.js's chat) and an
// in-memory `store` (same shape as window.__fsStore subset we use).

import { describe, it, expect, beforeEach } from "vitest";
import {
  rewritePost,
  buildSystemPrompt,
  buildUserPrompt,
  renderRewriteMarkdown,
  renderBatchMarkdown,
  PLATFORMS,
  PLATFORM_META,
  TIKTOK_SCHEMA,
  YT_SHORTS_SCHEMA,
  X_SCHEMA,
  LINKEDIN_SCHEMA,
} from "../../src/analysis/rewrite.js";

const mkPost = (over = {}) => ({
  id: "p1",
  author: "adriano",
  url: "https://instagram.com/p/p1",
  desc: "Stop seasoning your steaks like a coward. Salt the night before.",
  transcript: "Tonight we are dry-brining a ribeye. Twelve hours minimum.",
  ai: { hookType: "contrarian", hook: "Stop seasoning steaks like a coward", topic: "steak", angle: "myth-busting" },
  _score: 3.2,
  ...over,
});

const sampleVoice = {
  username: "imorgado",
  tone: "wry, confident",
  avgSentenceLen: 14,
  signatureWords: ["literally", "the move"],
  emojiRate: 0.5,
  openerPatterns: ["Stop [VERB]ing your [NOUN]"],
  closerPatterns: ["That's the move."],
  CTAStyle: "soft — asks an open question",
};

// JSON payloads the mock chat returns per platform.
const FAKE_JSON = {
  tiktok: {
    hook: "Stop salting your steak last minute.",
    script: ("Salt the steak the night before. Twelve hours minimum. The salt pulls moisture, then reabsorbs, " +
      "carrying flavor deep into the meat. Pat it dry before searing. High heat, neutral oil. Flip every thirty seconds. " +
      "Rest five minutes. That's how you get a steakhouse crust at home — no fancy gear, just patience and salt. " +
      "Try it once and you'll never go back to last-minute seasoning.").trim(),
    hashtags: ["steak", "cooking"],
    cta: "Save this and try it tonight.",
  },
  yt_shorts: {
    hook: "Your steak is bland because of timing.",
    script: ("The mistake: salting right before the pan. The fix: salt twelve hours ahead. " +
      "Salt pulls moisture out, then the meat reabsorbs the brine. Flavor goes deep, not just on the surface. " +
      "Pat dry. Rip-hot pan. Flip often. Rest five minutes. That's the move.").trim(),
    onScreenText: [
      { tStart: 0, text: "BLAND STEAK?" },
      { tStart: 4, text: "Salt 12 hrs early" },
      { tStart: 9, text: "Pat dry" },
      { tStart: 14, text: "Rip-hot pan" },
      { tStart: 20, text: "Flip often" },
      { tStart: 26, text: "Rest 5 min" },
    ],
    cta: "Subscribe for more steakhouse moves.",
  },
  x: {
    single: "Salt your steak the night before. Pat dry. Rip-hot pan. Flip often. Rest 5. That's a steakhouse crust at home.",
    thread: [
      "Stop salting steaks last minute. Here's the steakhouse trick:",
      "Salt 12 hrs ahead. Salt pulls moisture, meat reabsorbs the brine, flavor goes deep.",
      "Pat dry before searing. Wet meat steams instead of crusts.",
      "Rip-hot pan, neutral oil, flip every 30s. Rest 5 min.",
      "Try it once. You'll never go back.",
    ],
  },
  linkedin: {
    post: ("Most home cooks season their steaks moments before searing. The result? A salty crust on top of " +
      "bland meat. There's a small change that fixes this without buying any new equipment.\n\n" +
      "Salt the steak twelve hours before you cook it. The salt pulls moisture to the surface, dissolves into a brine, " +
      "and that brine slowly reabsorbs into the muscle, carrying seasoning all the way through.\n\n" +
      "When you're ready to cook, pat the surface bone-dry. Wet meat steams; dry meat sears. Use a rip-hot pan, neutral " +
      "oil, and flip every thirty seconds for an even crust. Rest for five minutes before slicing so the juices redistribute.\n\n" +
      "It's a tiny change in process, but the difference at the dinner table is enormous. Restaurants do exactly this — " +
      "they just call it dry-brining.\n\n" +
      "Most of the cooking improvements I've made in the last year have come from rethinking timing rather than buying gear. " +
      "Salt timing, rest timing, oil timing — they cost nothing and they change the food more than any pan ever did.\n\n" +
      "What's a small timing change in your own work that produced an outsized result?").trim(),
    hashtags: ["cooking", "craft"],
  },
};

const mkChat = (calls = [], opts = {}) => async (payload) => {
  calls.push(payload);
  const platform = String(payload.kind || "").replace(/^rewrite:/, "");
  if (opts.failOn && opts.failOn === platform) {
    throw new Error(`forced fail on ${platform}`);
  }
  return { json: FAKE_JSON[platform], text: JSON.stringify(FAKE_JSON[platform]) };
};

const mkStore = () => {
  const rows = new Map();
  return {
    rows,
    putRewrite: async (row) => { rows.set(`${row.postId}::${row.platform}`, row); return row; },
  };
};

describe("rewrite", () => {
  beforeEach(() => { /* nothing — module is stateless */ });

  describe("PLATFORMS / PLATFORM_META", () => {
    it("exports the four target platforms", () => {
      expect(PLATFORMS).toEqual(["tiktok", "yt_shorts", "x", "linkedin"]);
      for (const p of PLATFORMS) {
        expect(PLATFORM_META[p]).toBeTruthy();
        expect(PLATFORM_META[p].schema).toBeTruthy();
        expect(PLATFORM_META[p].constraintSummary.length).toBeGreaterThan(20);
      }
    });

    it("schemas are JSON-Schema shaped with required fields", () => {
      expect(TIKTOK_SCHEMA.required).toContain("hook");
      expect(TIKTOK_SCHEMA.required).toContain("hashtags");
      expect(YT_SHORTS_SCHEMA.required).toContain("onScreenText");
      expect(X_SCHEMA.required).toEqual(["single", "thread"]);
      expect(LINKEDIN_SCHEMA.required).toEqual(["post", "hashtags"]);
    });
  });

  describe("buildSystemPrompt", () => {
    it("falls back to neutral prompt when no voice is provided", () => {
      const s = buildSystemPrompt(null);
      expect(s).toMatch(/senior social-media editor/i);
      expect(s).not.toMatch(/voice of @/i);
    });

    it("uses voice fingerprint when provided", () => {
      const s = buildSystemPrompt(sampleVoice);
      expect(s).toMatch(/@imorgado/);
      expect(s).toMatch(/wry, confident/);
      // Voice + platform precedence rule should be present.
      expect(s).toMatch(/platform wins on length/i);
    });
  });

  describe("buildUserPrompt", () => {
    it("includes constraint summary, caption, transcript, and AI metadata", () => {
      const u = buildUserPrompt(mkPost(), "tiktok");
      expect(u).toContain("TARGET PLATFORM: TikTok");
      expect(u).toContain("PLATFORM CONSTRAINTS");
      expect(u).toContain("first 1.5 seconds");
      expect(u).toContain("Stop seasoning your steaks");
      expect(u).toContain("dry-brining a ribeye");
      expect(u).toContain("SOURCE HOOK TYPE: contrarian");
      expect(u).toContain("SOURCE TOPIC: steak");
    });

    it("includes the platform's specific constraint summary per target", () => {
      expect(buildUserPrompt(mkPost(), "yt_shorts")).toContain("on-screen text");
      expect(buildUserPrompt(mkPost(), "x")).toMatch(/≤280 characters/);
      expect(buildUserPrompt(mkPost(), "linkedin")).toMatch(/200.{1,3}400 words/);
    });

    it("appends the editorial nudge when present", () => {
      const u = buildUserPrompt(mkPost(), "tiktok", { nudge: "more aggressive hook" });
      expect(u).toContain("EDITORIAL NUDGE");
      expect(u).toContain("more aggressive hook");
    });

    it("throws on unknown platform", () => {
      expect(() => buildUserPrompt(mkPost(), "myspace")).toThrow();
    });
  });

  describe("rewritePost", () => {
    it("calls chat() once per platform with the right schema and constraint summary", async () => {
      const calls = [];
      const chat = mkChat(calls);
      const store = mkStore();
      const out = await rewritePost(mkPost(), PLATFORMS, { chat, store, model: "gemma4" });

      // One call per platform, in the requested order, sequential.
      expect(calls).toHaveLength(4);
      expect(calls.map((c) => c.kind)).toEqual([
        "rewrite:tiktok", "rewrite:yt_shorts", "rewrite:x", "rewrite:linkedin",
      ]);

      // Schemas match the per-platform definitions.
      expect(calls[0].schema).toBe(TIKTOK_SCHEMA);
      expect(calls[1].schema).toBe(YT_SHORTS_SCHEMA);
      expect(calls[2].schema).toBe(X_SCHEMA);
      expect(calls[3].schema).toBe(LINKEDIN_SCHEMA);

      // Each call carries the platform's constraint summary in the user msg.
      for (const call of calls) {
        const platform = call.kind.replace(/^rewrite:/, "");
        const userContent = call.messages[1].content;
        expect(userContent).toContain(PLATFORM_META[platform].constraintSummary.split("\n")[1] || PLATFORM_META[platform].label);
        expect(call.options.temperature).toBe(0.7);
      }

      // System message: neutral when no voice supplied.
      expect(calls[0].messages[0].role).toBe("system");
      expect(calls[0].messages[0].content).toMatch(/senior social-media editor/);

      // All four results present, no errors.
      expect(Object.keys(out.results).sort()).toEqual([...PLATFORMS].sort());
      expect(out.errors).toEqual({});
      expect(out.usedVoice).toBe(false);
      expect(out.voiceUsername).toBeNull();
      expect(out.postId).toBe("p1");
      expect(out.model).toBe("gemma4");
    });

    it("uses the user's own voice fingerprint as the system prompt when set", async () => {
      const calls = [];
      const chat = mkChat(calls);
      const out = await rewritePost(mkPost(), ["tiktok"], { chat, voice: sampleVoice });
      expect(calls[0].messages[0].content).toMatch(/voice of @imorgado/);
      expect(out.usedVoice).toBe(true);
      expect(out.voiceUsername).toBe("imorgado");
    });

    it("persists each result to the store under (postId, platform)", async () => {
      const chat = mkChat();
      const store = mkStore();
      await rewritePost(mkPost(), PLATFORMS, { chat, store });
      expect(store.rows.size).toBe(4);
      for (const platform of PLATFORMS) {
        const row = store.rows.get(`p1::${platform}`);
        expect(row).toBeTruthy();
        expect(row.postId).toBe("p1");
        expect(row.platform).toBe(platform);
        expect(row.data).toEqual(FAKE_JSON[platform]);
        expect(row.model).toBe("gemma4");
        expect(typeof row.generatedAt).toBe("number");
      }
    });

    it("attaches per-platform validation warnings", async () => {
      const chat = mkChat();
      const out = await rewritePost(mkPost(), PLATFORMS, { chat });
      // Our fake LinkedIn payload ends with a question, no warnings expected.
      expect(out.results.linkedin.warnings.find((w) => w.code === "no-question-cta")).toBeUndefined();
      // X thread tweets are all under 280 chars.
      expect(out.results.x.warnings.find((w) => w.code === "thread-tweet-too-long")).toBeUndefined();
      // Bad payload → at least one warning.
      const chat2 = async (payload) => {
        const platform = payload.kind.replace(/^rewrite:/, "");
        if (platform === "x") return { json: { single: "x".repeat(400), thread: ["a"] } };
        return { json: FAKE_JSON[platform] };
      };
      const out2 = await rewritePost(mkPost(), ["x"], { chat: chat2 });
      const warnCodes = out2.results.x.warnings.map((w) => w.code);
      expect(warnCodes).toContain("single-too-long");
      expect(warnCodes).toContain("thread-short");
    });

    it("runs platforms sequentially (concurrency 1)", async () => {
      const order = [];
      let live = 0;
      let maxLive = 0;
      const chat = async (payload) => {
        live++;
        maxLive = Math.max(maxLive, live);
        const platform = payload.kind.replace(/^rewrite:/, "");
        order.push(`start:${platform}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`end:${platform}`);
        live--;
        return { json: FAKE_JSON[platform] };
      };
      await rewritePost(mkPost(), PLATFORMS, { chat });
      expect(maxLive).toBe(1);
      expect(order).toEqual([
        "start:tiktok", "end:tiktok",
        "start:yt_shorts", "end:yt_shorts",
        "start:x", "end:x",
        "start:linkedin", "end:linkedin",
      ]);
    });

    it("isolates per-platform failures (one platform fails → others still succeed)", async () => {
      const chat = mkChat([], { failOn: "x" });
      const out = await rewritePost(mkPost(), PLATFORMS, { chat });
      expect(out.errors.x).toMatch(/forced fail/);
      expect(out.results.x).toBeUndefined();
      expect(out.results.tiktok).toBeTruthy();
      expect(out.results.yt_shorts).toBeTruthy();
      expect(out.results.linkedin).toBeTruthy();
    });

    it("invokes onPlatform hook per platform with start/ok lifecycle", async () => {
      const events = [];
      const chat = mkChat();
      await rewritePost(mkPost(), ["tiktok", "x"], {
        chat,
        onPlatform: (e) => events.push(`${e.status}:${e.platform}`),
      });
      expect(events).toEqual([
        "start:tiktok", "ok:tiktok",
        "start:x", "ok:x",
      ]);
    });

    it("forwards the editorial nudge into the user message", async () => {
      const calls = [];
      const chat = mkChat(calls);
      await rewritePost(mkPost(), ["tiktok"], { chat, nudge: "shorter" });
      expect(calls[0].messages[1].content).toContain("EDITORIAL NUDGE");
      expect(calls[0].messages[1].content).toContain("shorter");
    });

    it("throws when no chat function provided", async () => {
      await expect(rewritePost(mkPost(), ["tiktok"], {})).rejects.toThrow(/chat function required/);
    });

    it("throws when no valid platforms supplied", async () => {
      await expect(rewritePost(mkPost(), ["myspace"], { chat: mkChat() })).rejects.toThrow(/valid platform/);
    });

    it("throws when post.id missing", async () => {
      await expect(rewritePost({}, ["tiktok"], { chat: mkChat() })).rejects.toThrow(/post\.id required/);
    });
  });

  describe("renderRewriteMarkdown / renderBatchMarkdown", () => {
    it("renders one section per platform with hook/script/cta", async () => {
      const chat = mkChat();
      const bundle = await rewritePost(mkPost(), PLATFORMS, { chat });
      const md = renderRewriteMarkdown(mkPost(), bundle);
      expect(md).toContain("## @adriano");
      expect(md).toContain("### TikTok");
      expect(md).toContain("### YouTube Shorts");
      expect(md).toContain("### X (Twitter)");
      expect(md).toContain("### LinkedIn");
      expect(md).toContain(FAKE_JSON.tiktok.hook);
      expect(md).toContain("**CTA:**");
      expect(md).toContain("**Single:**");
      expect(md).toContain("- t=0s — BLAND STEAK?");
      expect(md).toContain("#cooking");
    });

    it("renders failed platforms with an error note", async () => {
      const chat = mkChat([], { failOn: "x" });
      const bundle = await rewritePost(mkPost(), PLATFORMS, { chat });
      const md = renderRewriteMarkdown(mkPost(), bundle);
      expect(md).toMatch(/_Failed: forced fail on x_/);
    });

    it("batch markdown joins multiple posts with horizontal rules", async () => {
      const chat = mkChat();
      const items = [];
      for (const id of ["p1", "p2"]) {
        const p = mkPost({ id });
        const bundle = await rewritePost(p, PLATFORMS, { chat });
        items.push({ post: p, bundle });
      }
      const md = renderBatchMarkdown(items, { date: new Date("2026-05-02T00:00:00Z") });
      expect(md).toContain("# Repurpose batch — 2026-05-02");
      expect(md).toContain("2 posts");
      // One horizontal rule between the two post sections.
      expect((md.match(/\n---\n/g) || []).length).toBeGreaterThanOrEqual(1);
    });
  });
});
