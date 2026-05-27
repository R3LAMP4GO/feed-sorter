// Unit tests for src/analysis/diagnose.js
//
// Mocks `chat()` (same shape as src/lib/llm.js chat()) and the cover-image
// fetch. Asserts: the chat payload includes the base64 image + the
// structured-output schema, and the result is persisted via the injected
// `persist` adapter.

import { describe, it, expect, vi } from "vitest";
import {
  diagnoseOutlier,
  DIAGNOSIS_SCHEMA,
  cohortMedianForFormat,
  buildUserContent,
  formatOf,
} from "../../src/analysis/diagnose.js";

const COVER_URL = "https://scontent.cdninstagram.com/cover.jpg";
const COVER_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]); // jpeg-ish
const EXPECTED_B64 = Buffer.from(COVER_BYTES).toString("base64");

const mkBlob = () => ({
  arrayBuffer: async () => COVER_BYTES.buffer.slice(
    COVER_BYTES.byteOffset,
    COVER_BYTES.byteOffset + COVER_BYTES.byteLength,
  ),
});

const mkFetch = (overrides = {}) => vi.fn(async (_url) => ({
  ok: true,
  status: 200,
  blob: async () => mkBlob(),
  ...overrides,
}));

const mkPost = (over = {}) => ({
  id: "p1",
  author: "adriano",
  cover: COVER_URL,
  desc: "this one trick changed everything",
  transcript: "Most people get macros wrong. Here is what actually works.",
  surface: "profile",
  isReel: true,
  likes: 134_000,
  views: 2_300_000,
  comments: 182,
  _score: 17.24,
  _scoreBasis: "author",
  ...over,
});

const mkCohort = () => ([
  { author: "adriano", isReel: true, likes: 8_000 },
  { author: "adriano", isReel: true, likes: 12_000 },
  { author: "adriano", isReel: true, likes: 9_000 },
  { author: "adriano", isReel: false, likes: 100_000 }, // wrong format → ignored
  { author: "other",   isReel: true,  likes: 999_999 }, // wrong author → ignored
]);

const okJson = () => ({
  hookStrength: 9,
  visualHookStrength: 8,
  topicNovelty: 7,
  emotionalDriver: "vindication",
  structuralPattern: "before/after reveal",
  hypothesis: "Direct eye contact and the bold yellow text overlay 'STOP DOING THIS' stop the scroll, while the contrarian caption pays off the curiosity gap.",
});

describe("diagnoseOutlier", () => {
  it("attaches base64 cover + schema, passes vision model, persists result", async () => {
    const fetchImpl = mkFetch();
    const chat = vi.fn(async () => ({ json: okJson(), model: "gemma4" }));
    const persisted = [];
    const persist = async (id, d) => { persisted.push([id, d]); };

    const post = mkPost();
    const r = await diagnoseOutlier(post, {
      chat, fetchImpl, persist, model: "gemma4", cohort: mkCohort(),
    });

    // Cover was fetched cross-origin without credentials.
    expect(fetchImpl).toHaveBeenCalledWith(
      COVER_URL,
      expect.objectContaining({ credentials: "omit" }),
    );

    // Chat was called once with the right schema, model, kind, and image.
    expect(chat).toHaveBeenCalledTimes(1);
    const payload = chat.mock.calls[0][0];
    expect(payload.model).toBe("gemma4");
    expect(payload.kind).toBe("diagnose");
    expect(payload.postId).toBe("p1");
    expect(payload.schema).toEqual(DIAGNOSIS_SCHEMA);
    expect(Array.isArray(payload.images)).toBe(true);
    expect(payload.images).toHaveLength(1);
    expect(payload.images[0]).toBe(EXPECTED_B64);

    // User content carries the cohort-median signal computed inline.
    const userMsg = payload.messages.find((m) => m.role === "user");
    expect(userMsg.content).toContain("CREATOR'S MEDIAN LIKES FOR REEL");
    expect(userMsg.content).toContain("9000"); // median of 8k/12k/9k
    expect(userMsg.content).toContain("OUTLIER SCORE: 17.24x");
    expect(userMsg.content).toContain("basis=author");

    // Result is normalized + persisted.
    expect(r.hookStrength).toBe(9);
    expect(r.visualHookStrength).toBe(8);
    expect(r.topicNovelty).toBe(7);
    expect(r.emotionalDriver).toBe("vindication");
    expect(r.hypothesis).toMatch(/yellow text overlay/);
    expect(r.model).toBe("gemma4");
    expect(typeof r.analyzedAt).toBe("number");

    expect(persisted).toHaveLength(1);
    expect(persisted[0][0]).toBe("p1");
    expect(persisted[0][1]).toEqual(r);
  });

  it("uses configured visionModel (not default) when caller passes it", async () => {
    const chat = vi.fn(async () => ({ json: okJson() }));
    await diagnoseOutlier(mkPost(), {
      chat, fetchImpl: mkFetch(), model: "gemma3:12b",
    });
    expect(chat.mock.calls[0][0].model).toBe("gemma3:12b");
  });

  it("clamps numeric scores to 1–10 and caps hypothesis at 80 words", async () => {
    const chat = vi.fn(async () => ({
      json: {
        hookStrength: 99,
        visualHookStrength: -3,
        topicNovelty: 5.7,
        emotionalDriver: "awe",
        structuralPattern: "reveal",
        hypothesis: Array.from({ length: 120 }, (_, i) => `w${i}`).join(" "),
      },
    }));
    const r = await diagnoseOutlier(mkPost(), { chat, fetchImpl: mkFetch() });
    expect(r.hookStrength).toBe(10);
    expect(r.visualHookStrength).toBe(1);
    expect(r.topicNovelty).toBe(6);
    expect(r.hypothesis.split(/\s+/)).toHaveLength(80);
  });

  it("throws DiagnosisSchemaError when model returns no JSON (non-vision Gemma)", async () => {
    const chat = vi.fn(async () => ({ json: null, text: "I cannot see images." }));
    await expect(
      diagnoseOutlier(mkPost(), { chat, fetchImpl: mkFetch() }),
    ).rejects.toThrow(/multimodal variant/);
  });

  it("throws DiagnosisSchemaError when required string field is empty", async () => {
    const chat = vi.fn(async () => ({
      json: { ...okJson(), hypothesis: "" },
    }));
    await expect(
      diagnoseOutlier(mkPost(), { chat, fetchImpl: mkFetch() }),
    ).rejects.toThrow(/hypothesis/);
  });

  it("throws CoverFetchError on CORS / network failure (no silent fallback)", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const chat = vi.fn();
    await expect(
      diagnoseOutlier(mkPost(), { chat, fetchImpl }),
    ).rejects.toThrow(/cover fetch failed/);
    expect(chat).not.toHaveBeenCalled();
  });

  it("throws when post has no cover", async () => {
    const chat = vi.fn();
    await expect(
      diagnoseOutlier(mkPost({ cover: "" }), { chat, fetchImpl: mkFetch() }),
    ).rejects.toThrow(/cover required/);
  });

  it("cohortMedianForFormat scopes to author + format", () => {
    const post = { author: "a", isReel: true };
    const cohort = [
      { author: "a", isReel: true, likes: 10 },
      { author: "a", isReel: true, likes: 30 },
      { author: "a", isReel: true, likes: 20 },
      { author: "a", isReel: false, likes: 9999 },
      { author: "b", isReel: true, likes: 9999 },
    ];
    expect(cohortMedianForFormat(cohort, post, "likes")).toBe(20);
    expect(formatOf(post)).toBe("reel");
  });

  it("buildUserContent omits median line when cohort empty", () => {
    const c = buildUserContent(mkPost(), { creatorMedian: 0 });
    expect(c).not.toContain("CREATOR'S MEDIAN");
    expect(c).toContain("CAPTION:");
    expect(c).toContain("TRANSCRIPT:");
  });
});
