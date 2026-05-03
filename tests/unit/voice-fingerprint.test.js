// Unit tests for src/analysis/voice-fingerprint.js
//
// Mocks the `chat` adapter (same shape as src/lib/llm.js's chat) and an
// in-memory `store` (same shape as window.__fsStore subset we use).

import { describe, it, expect } from "vitest";
import {
  regenerateVoice,
  buildSystemPrompt,
  buildVoicePrompt,
  selectTopPosts,
  VOICE_SCHEMA,
} from "../../src/analysis/voice-fingerprint.js";

const mkPost = (over = {}) => ({
  id: over.id || `p${Math.random().toString(36).slice(2, 8)}`,
  author: "adriano",
  desc: over.desc || "Default caption text.",
  transcript: over.transcript || "",
  likes: 1000,
  views: 5000,
  _score: 2.0,
  lastSeenAt: Date.now(),
  ...over,
});

const mkStore = (postsByAuthor = {}) => {
  const voices = new Map();
  return {
    voices,
    getByAuthor: async (u) => (postsByAuthor[u] || []).slice(),
    putVoice: async (row) => { voices.set(row.username, row); return row; },
    getVoice: async (u) => voices.get(u) || null,
  };
};

const mkChat = (json = null, calls = []) => async (payload) => {
  calls.push(payload);
  return {
    json: json || {
      tone: "WRY, didactic",
      avgSentenceLen: 14,
      signatureWords: ["literally", "literally", "the move", "no joke", "the move"],
      emojiRate: 0.5,
      openerPatterns: ["[NUMBER] reasons …", "Stop [VERB]ing your [NOUN]"],
      closerPatterns: ["Save this for later.", "That's the move."],
      CTAStyle: "soft — asks an open question at the end",
    },
  };
};

describe("voice-fingerprint", () => {
  describe("selectTopPosts", () => {
    it("filters by minScore and caps to topN, sorted desc", () => {
      const posts = [
        { id: "a", _score: 3.0 },
        { id: "b", _score: 1.0 }, // below floor
        { id: "c", _score: 5.0 },
        { id: "d", _score: 1.5 }, // exactly floor → kept
        { id: "e", _score: 2.0 },
      ];
      const top = selectTopPosts(posts, { topN: 3, minScore: 1.5 });
      expect(top.map((p) => p.id)).toEqual(["c", "a", "e"]);
    });
  });

  describe("buildVoicePrompt", () => {
    it("includes one block per post with truncated caption + transcript", () => {
      const long = "x".repeat(800);
      const posts = [
        mkPost({ id: "p1", desc: long, transcript: "short transcript", _score: 2.5 }),
        mkPost({ id: "p2", desc: "short cap", transcript: long, _score: 1.7 }),
      ];
      const out = buildVoicePrompt(posts, { truncateChars: 100 });
      expect(out).toContain("--- POST 1");
      expect(out).toContain("--- POST 2");
      expect(out).toContain("score=2.50");
      expect(out).toContain("score=1.70");
      expect(out).toContain("CAPTION: ");
      expect(out).toContain("TRANSCRIPT: short transcript");
      // Truncation works on both fields.
      expect(out).not.toContain("x".repeat(101));
      // Ellipsis appended.
      expect(out).toContain("…");
    });

    it("omits transcript line when transcript is empty", () => {
      const out = buildVoicePrompt([mkPost({ desc: "hi", transcript: "" })]);
      expect(out).toContain("CAPTION: hi");
      expect(out).not.toContain("TRANSCRIPT");
    });
  });

  describe("regenerateVoice", () => {
    it("calls chat() with VOICE_SCHEMA, top-20 captions, and persists result", async () => {
      const calls = [];
      const chat = mkChat(null, calls);
      // 25 posts with varying scores; 5 should be filtered by minScore floor.
      const all = [];
      for (let i = 0; i < 25; i++) {
        all.push(mkPost({
          id: `p${i}`,
          desc: `Caption number ${i}`,
          _score: i < 5 ? 1.0 : 2.0 + (i / 100), // first 5 below 1.5 floor
        }));
      }
      const store = mkStore({ adriano: all });

      const row = await regenerateVoice({
        username: "adriano", chat, store, model: "gemma4",
      });

      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(call.model).toBe("gemma4");
      expect(call.schema).toEqual(VOICE_SCHEMA);
      expect(call.kind).toBe("voice-fingerprint");
      expect(call.messages[0].role).toBe("system");
      expect(call.messages[1].role).toBe("user");
      // Top-20 in prompt — should include the highest-scoring caption and
      // exclude the below-floor ones (p0..p4).
      const userContent = call.messages[1].content;
      expect(userContent).toContain("Caption number 24"); // highest _score
      expect(userContent).not.toContain("Caption number 0\n"); // filtered out
      // Exactly 20 blocks.
      const blocks = userContent.split(/--- POST /).length - 1;
      expect(blocks).toBe(20);

      // Persisted to voice store with normalized fields.
      expect(store.voices.get("adriano")).toBeDefined();
      expect(row.username).toBe("adriano");
      expect(row.model).toBe("gemma4");
      expect(row.sourcePostCount).toBe(20);
      expect(row.tone).toBe("wry, didactic"); // lowercased
      expect(row.avgSentenceLen).toBe(14);
      // Deduped (case-insensitive).
      expect(row.signatureWords).toEqual(["literally", "the move", "no joke"]);
      expect(typeof row.generatedAt).toBe("number");
    });

    it("throws no-source-posts when nothing meets minScore", async () => {
      const store = mkStore({
        adriano: [mkPost({ _score: 0.5 }), mkPost({ _score: 1.0 })],
      });
      await expect(
        regenerateVoice({ username: "adriano", chat: mkChat(), store }),
      ).rejects.toMatchObject({ code: "no-source-posts" });
    });

    it("throws if chat returns no JSON", async () => {
      const store = mkStore({ adriano: [mkPost({ _score: 2.0 })] });
      const chat = async () => ({ json: null });
      await expect(
        regenerateVoice({ username: "adriano", chat, store }),
      ).rejects.toThrow(/no JSON/);
    });

    it("normalizes/clamps wonky LLM output", async () => {
      const store = mkStore({ adriano: [mkPost({ _score: 2.0 })] });
      const chat = async () => ({
        json: {
          tone: "  Snarky  ",
          avgSentenceLen: 999,             // → clamped to 80
          signatureWords: ["a", "A", "b"], // → deduped case-insensitive
          emojiRate: -3,                   // → clamped to 0
          openerPatterns: ["[X] tips"],
          closerPatterns: [],
          CTAStyle: "x".repeat(300),       // → trimmed to 200
        },
      });
      const row = await regenerateVoice({ username: "adriano", chat, store });
      expect(row.tone).toBe("snarky");
      expect(row.avgSentenceLen).toBe(80);
      expect(row.signatureWords).toEqual(["a", "b"]);
      expect(row.emojiRate).toBe(0);
      expect(row.CTAStyle).toHaveLength(200);
    });
  });

  describe("buildSystemPrompt", () => {
    const sampleVoice = {
      username: "adriano",
      tone: "wry, didactic",
      avgSentenceLen: 14,
      signatureWords: ["literally", "the move", "no joke"],
      emojiRate: 0.5,
      openerPatterns: ["[NUMBER] reasons …", "Stop [VERB]ing your [NOUN]"],
      closerPatterns: ["Save this for later.", "That's the move."],
      CTAStyle: "soft — asks an open question at the end",
    };

    it("matches the snapshot", () => {
      expect(buildSystemPrompt(sampleVoice)).toMatchInlineSnapshot(`
"You are writing in the voice of @adriano.
Match their voice EXACTLY. Do not invent your own style.

TONE: wry, didactic
AVERAGE SENTENCE LENGTH: ~14 words.
EMOJI RATE: 0.5 per 100 words.
CTA STYLE: soft — asks an open question at the end

SIGNATURE WORDS / PHRASES (reuse these naturally; do not force every one):
  - literally
  - the move
  - no joke

OPENER PATTERNS (pick one and instantiate the [BRACKETS]):
  - [NUMBER] reasons …
  - Stop [VERB]ing your [NOUN]

CLOSER PATTERNS (pick one):
  - Save this for later.
  - That's the move.

Rules:
- Stay within ~2× the average sentence length.
- Do not break character to explain that you're an AI.
- Do not output markdown fences or commentary — only the rewritten post."
`);
    });

    it("handles empty arrays gracefully", () => {
      const out = buildSystemPrompt({
        username: "nobody",
        tone: "",
        avgSentenceLen: 0,
        signatureWords: [],
        emojiRate: 0,
        openerPatterns: [],
        closerPatterns: [],
        CTAStyle: "",
      });
      expect(out).toContain("@nobody");
      expect(out).toContain("(none)");
    });

    it("throws on missing voice", () => {
      expect(() => buildSystemPrompt(null)).toThrow();
    });
  });
});
