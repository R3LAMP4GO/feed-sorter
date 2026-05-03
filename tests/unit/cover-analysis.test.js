// Unit tests for src/analysis/cover-analysis.js
//
// Mocks `chat()` (same shape as src/lib/llm.js chat()) and the cover-image
// fetch. Asserts: the chat payload includes the base64 image + the
// structured-output schema, and the result is persisted via the injected
// `persist` adapter. Also checks the cache key incorporates the cover URL.

import { describe, it, expect, vi } from "vitest";
import {
  analyzeCover,
  COVER_SCHEMA,
  COVER_EXPRESSIONS,
  COVER_COMPOSITIONS,
  crossTabCoverFeature,
  coverWinRate,
} from "../../src/analysis/cover-analysis.js";

const COVER_URL = "https://scontent.cdninstagram.com/cover.jpg";
const COVER_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);
const EXPECTED_B64 = Buffer.from(COVER_BYTES).toString("base64");

const mkBlob = () => ({
  arrayBuffer: async () => COVER_BYTES.buffer.slice(
    COVER_BYTES.byteOffset,
    COVER_BYTES.byteOffset + COVER_BYTES.byteLength,
  ),
});

const mkFetch = (overrides = {}) => vi.fn(async () => ({
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
  _score: 4.2,
  isReel: true,
  ...over,
});

const okJson = () => ({
  hasFace: true,
  faceCount: 1,
  expression: "surprised",
  hasTextOverlay: true,
  textContent: "STOP DOING THIS",
  dominantColor: "yellow",
  composition: "closeup",
});

describe("analyzeCover", () => {
  it("attaches base64 cover + schema, passes vision model, persists result", async () => {
    const fetchImpl = mkFetch();
    const chat = vi.fn(async () => ({ json: okJson(), model: "gemma4" }));
    const persisted = [];
    const persist = async (id, ai) => { persisted.push([id, ai]); };

    const r = await analyzeCover(mkPost(), {
      chat, fetchImpl, persist, model: "gemma4",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      COVER_URL,
      expect.objectContaining({ credentials: "omit" }),
    );

    expect(chat).toHaveBeenCalledTimes(1);
    const payload = chat.mock.calls[0][0];
    expect(payload.model).toBe("gemma4");
    expect(payload.kind).toBe("cover");
    expect(payload.postId).toBe("p1");
    expect(payload.schema).toEqual(COVER_SCHEMA);
    expect(Array.isArray(payload.images)).toBe(true);
    expect(payload.images).toHaveLength(1);
    expect(payload.images[0]).toBe(EXPECTED_B64);

    expect(r.hasFace).toBe(true);
    expect(r.faceCount).toBe(1);
    expect(r.expression).toBe("surprised");
    expect(r.hasTextOverlay).toBe(true);
    expect(r.textContent).toBe("STOP DOING THIS");
    expect(r.dominantColor).toBe("yellow");
    expect(r.composition).toBe("closeup");
    expect(r.model).toBe("gemma4");
    expect(typeof r.analyzedAt).toBe("number");

    expect(persisted).toHaveLength(1);
    expect(persisted[0][0]).toBe("p1");
    expect(persisted[0][1]).toEqual(r);
  });

  it("uses configured visionModel when caller passes it", async () => {
    const chat = vi.fn(async () => ({ json: okJson() }));
    await analyzeCover(mkPost(), {
      chat, fetchImpl: mkFetch(), model: "gemma3:12b",
    });
    expect(chat.mock.calls[0][0].model).toBe("gemma3:12b");
  });

  it("normalizes invalid expression / composition to defaults", async () => {
    const chat = vi.fn(async () => ({
      json: { ...okJson(), expression: "smug", composition: "MEME" },
    }));
    const r = await analyzeCover(mkPost(), { chat, fetchImpl: mkFetch() });
    // Has face → falls back to neutral, not 'none'.
    expect(r.expression).toBe("neutral");
    expect(r.composition).toBe("other");
  });

  it("forces expression=none + faceCount=0 when hasFace=false", async () => {
    const chat = vi.fn(async () => ({
      json: { ...okJson(), hasFace: false, faceCount: 3, expression: "happy" },
    }));
    const r = await analyzeCover(mkPost(), { chat, fetchImpl: mkFetch() });
    expect(r.hasFace).toBe(false);
    expect(r.faceCount).toBe(0);
    expect(r.expression).toBe("none");
  });

  it("nulls textContent when hasTextOverlay=false even if model returns text", async () => {
    const chat = vi.fn(async () => ({
      json: { ...okJson(), hasTextOverlay: false, textContent: "leftover" },
    }));
    const r = await analyzeCover(mkPost(), { chat, fetchImpl: mkFetch() });
    expect(r.hasTextOverlay).toBe(false);
    expect(r.textContent).toBeNull();
  });

  it("throws CoverSchemaError when model returns no JSON", async () => {
    const chat = vi.fn(async () => ({ json: null }));
    await expect(
      analyzeCover(mkPost(), { chat, fetchImpl: mkFetch() }),
    ).rejects.toThrow(/multimodal variant/);
  });

  it("throws CoverFetchError on CORS / network failure (no silent fallback)", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    const chat = vi.fn();
    await expect(
      analyzeCover(mkPost(), { chat, fetchImpl }),
    ).rejects.toThrow(/cover fetch failed/);
    expect(chat).not.toHaveBeenCalled();
  });

  it("throws when post has no cover", async () => {
    const chat = vi.fn();
    await expect(
      analyzeCover(mkPost({ cover: "" }), { chat, fetchImpl: mkFetch() }),
    ).rejects.toThrow(/cover required/);
  });

  it("hits cache on repeat call with same (model, cover URL); skips fetch + chat", async () => {
    const cache = new Map();
    const fetchImpl = mkFetch();
    const chat = vi.fn(async () => ({ json: okJson(), model: "gemma4" }));

    const first = await analyzeCover(mkPost(), { chat, fetchImpl, cache });
    expect(first.cached).toBe(false);
    expect(chat).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const second = await analyzeCover(mkPost(), { chat, fetchImpl, cache });
    expect(second.cached).toBe(true);
    expect(chat).toHaveBeenCalledTimes(1);   // no second call
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no second fetch either

    // A different cover URL must miss the cache.
    await analyzeCover(mkPost({ cover: COVER_URL + "?v=2" }), { chat, fetchImpl, cache });
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("schema lists the documented enums", () => {
    expect(COVER_SCHEMA.required).toContain("hasFace");
    expect(COVER_SCHEMA.required).toContain("composition");
    expect(COVER_EXPRESSIONS).toContain("happy");
    expect(COVER_EXPRESSIONS).toContain("none");
    expect(COVER_COMPOSITIONS).toContain("closeup");
    expect(COVER_COMPOSITIONS).toContain("text-heavy");
  });
});

describe("crossTabCoverFeature", () => {
  it("groups posts by feature value and reports median/mean _score", () => {
    const posts = [
      { _score: 3, cover_ai: { hasFace: true } },
      { _score: 2, cover_ai: { hasFace: true } },
      { _score: 5, cover_ai: { hasFace: true } },
      { _score: 1, cover_ai: { hasFace: false } },
      { _score: 1.2, cover_ai: { hasFace: false } },
      { _score: 9, /* no cover_ai */ },
    ];
    const r = crossTabCoverFeature(posts, (ai) => ai.hasFace, "hasFace");
    expect(r.n).toBe(5);
    const t = r.buckets.find((b) => b.label === "true");
    const f = r.buckets.find((b) => b.label === "false");
    expect(t.n).toBe(3);
    expect(t.median).toBe(3);
    expect(f.n).toBe(2);
    expect(f.median).toBeCloseTo(1.1, 5);
  });
});

describe("coverWinRate", () => {
  it("returns 0 when post has no cover_ai", () => {
    expect(coverWinRate({ _score: 5 }, [{ cover_ai: { hasFace: true }, _score: 1 }])).toBe(0);
  });
  it("rewards posts whose cover-feature buckets beat the overall mean", () => {
    const cohort = [
      { _score: 5, cover_ai: { hasFace: true,  hasTextOverlay: true,  composition: "closeup", expression: "surprised" } },
      { _score: 4, cover_ai: { hasFace: true,  hasTextOverlay: true,  composition: "closeup", expression: "surprised" } },
      { _score: 1, cover_ai: { hasFace: false, hasTextOverlay: false, composition: "wide",    expression: "none" } },
      { _score: 1, cover_ai: { hasFace: false, hasTextOverlay: false, composition: "wide",    expression: "none" } },
    ];
    const winner = coverWinRate(cohort[0], cohort);
    const loser  = coverWinRate(cohort[2], cohort);
    expect(winner).toBeGreaterThan(1);
    expect(loser).toBeLessThan(1);
  });
});
