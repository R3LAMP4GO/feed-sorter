// Unit tests for src/pipeline.js
//
// Mocks every adapter and asserts:
//   - step ORDER per post: download → transcribe → diagnose → rewrite → readme
//   - posts run sequentially (concurrency=1)
//   - cached sentinels in store SKIP the matching step on resume
//   - AbortSignal halts mid-batch (subsequent posts not started)
//   - health gate failure aborts BEFORE any post is touched
//   - candidate selection respects minScore and count
//   - artifact writers receive the right paths

import { describe, it, expect, vi } from "vitest";
import {
  runRepurposePipeline,
  selectCandidates,
  folderForPost,
  sanitizeSeg,
  ymd,
  STEPS,
  PLATFORMS,
  checkHealth,
  PipelineHealthError,
  renderPlatformMarkdown,
  renderDiagnosisMarkdown,
  renderTranscriptText,
  renderTranscriptJson,
} from "../../src/pipeline.js";

const mkPost = (over = {}) => ({
  id: over.id || "p1",
  author: over.author || "adriano",
  shortcode: over.shortcode || "ABC123",
  videoUrl: "https://cdn/v.mp4",
  cover: "https://cdn/c.jpg",
  desc: "caption",
  _score: 5,
  _scoreBasis: "median-author",
  likes: 1000,
  views: 10000,
  comments: 50,
  createTime: 1700000000000,
  url: "https://instagram.com/reel/ABC123",
  ...over,
});

// In-memory store implementing { getStep, putStep }.
const mkStore = (seed = {}) => {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getStep: vi.fn(async (id, step) => map.get(`${id}::${step}`) || null),
    putStep: vi.fn(async (id, step, payload) => { map.set(`${id}::${step}`, payload); }),
  };
};

// Build a default suite of adapters that record their call ORDER into a
// shared array. Each adapter returns the minimum payload pipeline needs.
const mkAdapters = (overrides = {}) => {
  const calls = [];
  const writes = [];
  const health = vi.fn(async () => ({ ollama: { ok: true, models: ["gemma4"] }, whisper: { ok: true, model: "base.en" } }));
  const download = vi.fn(async ({ post, folder, filename }) => {
    calls.push(`download:${post.id}`);
    return { filename, bytes: 1234 };
  });
  const writeFile = vi.fn(async ({ path, content }) => {
    writes.push({ path, content });
  });
  const transcribe = vi.fn(async ({ post }) => {
    calls.push(`transcribe:${post.id}`);
    return { text: `hello ${post.id}`, segments: [{ start: 0, end: 1, text: "hello" }], language: "en", model: "base.en" };
  });
  const diagnose = vi.fn(async ({ post }) => {
    calls.push(`diagnose:${post.id}`);
    return {
      hookStrength: 8, visualHookStrength: 7, topicNovelty: 6,
      emotionalDriver: "envy", structuralPattern: "before/after",
      hypothesis: "stop-the-scroll cover", model: "gemma4",
    };
  });
  const rewrite = vi.fn(async ({ post, platforms, onPlatform }) => {
    calls.push(`rewrite:${post.id}`);
    const results = {};
    for (const p of platforms) {
      onPlatform?.({ platform: p, status: "ok", result: { data: { hook: "h" } } });
      results[p] = { postId: post.id, platform: p, data: { hook: "h", script: "s", cta: "c", hashtags: ["a"], single: "x", thread: ["1", "2"], post: "long?", onScreenText: [] }, warnings: [] };
    }
    return { postId: post.id, model: "gemma4", results, errors: {}, usedVoice: false };
  });
  return {
    calls, writes,
    adapters: { health, download, writeFile, transcribe, diagnose, rewrite, ...overrides },
  };
};

describe("selectCandidates", () => {
  it("filters by minScore and caps at count, score-desc", () => {
    const posts = [
      mkPost({ id: "a", _score: 1.5 }),
      mkPost({ id: "b", _score: 4 }),
      mkPost({ id: "c", _score: 9 }),
      mkPost({ id: "d", _score: 2.0 }),
    ];
    const picked = selectCandidates(posts, { minScore: 2, count: 2 });
    expect(picked.map((p) => p.id)).toEqual(["c", "b"]);
  });
  it("drops invalid posts", () => {
    const picked = selectCandidates([null, { _score: 5 }, mkPost({ id: "ok", _score: 5 })], { minScore: 1, count: 5 });
    expect(picked.map((p) => p.id)).toEqual(["ok"]);
  });
});

describe("folderForPost / sanitizeSeg / ymd", () => {
  it("builds a safe folder path", () => {
    const f = folderForPost(mkPost({ author: "ad/ria no!", shortcode: "ABC/xyz" }), { date: new Date(2025, 7, 13) });
    expect(f).toBe("feed-sorter-ig/repurpose-2025-08-13/ad_ria_no-ABC_xyz");
  });
  it("sanitizeSeg strips path separators", () => {
    expect(sanitizeSeg("a/b\\c..d")).toBe("a_b_c..d");
  });
  it("ymd zero-pads", () => {
    expect(ymd(new Date("2025-01-02T05:00:00Z"))).toMatch(/^2025-01-0[12]$/);
  });
});

describe("renderers", () => {
  it("renderTranscriptJson is valid JSON", () => {
    const j = JSON.parse(renderTranscriptJson({ text: "hi", segments: [{ start: 0, end: 1, text: "hi" }], language: "en", model: "base" }));
    expect(j.text).toBe("hi");
    expect(j.segments).toHaveLength(1);
  });
  it("renderDiagnosisMarkdown includes hypothesis", () => {
    const md = renderDiagnosisMarkdown(mkPost(), { hookStrength: 8, visualHookStrength: 7, topicNovelty: 6, emotionalDriver: "envy", structuralPattern: "POV", hypothesis: "Bold red text overlay drove stops.", model: "gemma4" });
    expect(md).toContain("Bold red text overlay");
    expect(md).toContain("8/10");
  });
  it("renderPlatformMarkdown handles all platforms", () => {
    expect(renderPlatformMarkdown("tiktok", { data: { hook: "H", script: "S", cta: "C", hashtags: ["x"] } })).toContain("# TikTok");
    expect(renderPlatformMarkdown("yt_shorts", { data: { hook: "H", script: "S", cta: "C", onScreenText: [{ tStart: 1, text: "BOOM" }] } })).toContain("BOOM");
    expect(renderPlatformMarkdown("x", { data: { single: "tweet", thread: ["a", "b"] } })).toContain("## Thread");
    expect(renderPlatformMarkdown("linkedin", { data: { post: "para", hashtags: ["ai"] } })).toContain("# LinkedIn");
  });
  it("renderPlatformMarkdown emits a clear failure stub on null row", () => {
    expect(renderPlatformMarkdown("tiktok", null)).toContain("No tiktok rewrite");
  });
  it("renderTranscriptText trims+newline", () => {
    expect(renderTranscriptText({ text: "  hi  " })).toBe("hi\n");
  });
});

describe("checkHealth", () => {
  it("throws PipelineHealthError when Ollama is down", async () => {
    const health = vi.fn(async () => ({ ollama: { ok: false, err: "ECONNREFUSED" }, whisper: { ok: true } }));
    await expect(checkHealth({ health })).rejects.toBeInstanceOf(PipelineHealthError);
  });
  it("throws when Whisper is down", async () => {
    const health = vi.fn(async () => ({ ollama: { ok: true }, whisper: { ok: false, err: "ECONNREFUSED" } }));
    await expect(checkHealth({ health })).rejects.toThrow(/Whisper/);
  });
  it("passes when both ok", async () => {
    const health = vi.fn(async () => ({ ollama: { ok: true, models: ["gemma4"] }, whisper: { ok: true, model: "base.en" } }));
    const r = await checkHealth({ health });
    expect(r.ollama.ok).toBe(true);
  });
});

describe("runRepurposePipeline — order & artifacts", () => {
  it("runs steps in fixed order per post: download → transcribe → diagnose → rewrite → readme", async () => {
    const { calls, writes, adapters } = mkAdapters();
    const r = await runRepurposePipeline({
      posts: [mkPost({ id: "p1", _score: 5 })],
      minScore: 2, count: 5, adapters,
    });
    expect(r.completed).toBe(1);
    expect(calls).toEqual(["download:p1", "transcribe:p1", "diagnose:p1", "rewrite:p1"]);
    // Artifacts must include all per-post files.
    const paths = writes.map((w) => w.path);
    expect(paths.some((p) => /transcript\.txt$/.test(p))).toBe(true);
    expect(paths.some((p) => /transcript\.json$/.test(p))).toBe(true);
    expect(paths.some((p) => /diagnosis\.md$/.test(p))).toBe(true);
    expect(paths.some((p) => /tiktok\.md$/.test(p))).toBe(true);
    expect(paths.some((p) => /shorts\.md$/.test(p))).toBe(true);
    expect(paths.some((p) => /x\.md$/.test(p))).toBe(true);
    expect(paths.some((p) => /linkedin\.md$/.test(p))).toBe(true);
    expect(paths.some((p) => /README\.md$/.test(p))).toBe(true);
  });

  it("processes posts SEQUENTIALLY (concurrency=1)", async () => {
    const { calls, adapters } = mkAdapters();
    await runRepurposePipeline({
      posts: [mkPost({ id: "p1", _score: 9 }), mkPost({ id: "p2", _score: 8 }), mkPost({ id: "p3", _score: 7 })],
      minScore: 2, count: 3, adapters,
    });
    // p1 must completely finish before p2 starts, etc.
    expect(calls).toEqual([
      "download:p1", "transcribe:p1", "diagnose:p1", "rewrite:p1",
      "download:p2", "transcribe:p2", "diagnose:p2", "rewrite:p2",
      "download:p3", "transcribe:p3", "diagnose:p3", "rewrite:p3",
    ]);
  });

  it("emits progress events in order", async () => {
    const events = [];
    const { adapters } = mkAdapters();
    await runRepurposePipeline({
      posts: [mkPost({ id: "p1", _score: 5 })],
      minScore: 1, count: 1, adapters,
      onEvent: (e) => events.push(e.type + (e.step ? `:${e.step}` : "")),
    });
    expect(events[0]).toBe("health.check");
    expect(events).toContain("health.ok");
    expect(events).toContain("batch.start");
    expect(events).toContain("post.start");
    // step.start/ok pairs for each step
    for (const s of STEPS) {
      expect(events).toContain(`step.start:${s}`);
      expect(events).toContain(`step.ok:${s}`);
    }
    expect(events).toContain("post.ok");
    expect(events).toContain("batch.end");
  });
});

describe("runRepurposePipeline — resume", () => {
  it("skips already-completed steps when sentinels are present in store", async () => {
    const { calls, adapters } = mkAdapters();
    const store = mkStore({
      "p1::download": { at: 1 },
      "p1::transcribe": { at: 2 },
    });
    await runRepurposePipeline({
      posts: [mkPost({ id: "p1", _score: 5 })],
      minScore: 1, count: 1,
      adapters: { ...adapters, store },
    });
    // download + transcribe were skipped — adapters never invoked
    expect(calls).toEqual(["diagnose:p1", "rewrite:p1"]);
    // sentinels written for the new steps
    expect(store.map.has("p1::diagnose")).toBe(true);
    expect(store.map.has("p1::rewrite")).toBe(true);
    expect(store.map.has("p1::readme")).toBe(true);
  });

  it("resume writes step.skip events for cached steps", async () => {
    const events = [];
    const { adapters } = mkAdapters();
    const store = mkStore({ "p1::download": { at: 1 } });
    await runRepurposePipeline({
      posts: [mkPost({ id: "p1", _score: 5 })],
      minScore: 1, count: 1,
      adapters: { ...adapters, store },
      onEvent: (e) => events.push(e),
    });
    const skips = events.filter((e) => e.type === "step.skip");
    expect(skips).toHaveLength(1);
    expect(skips[0].step).toBe("download");
  });
});

describe("runRepurposePipeline — abort", () => {
  it("AbortSignal halts mid-batch — subsequent posts are not started", async () => {
    const ac = new AbortController();
    const { calls, adapters } = mkAdapters();
    // After p1 finishes its diagnose, abort. The remainder of p1 (rewrite/readme)
    // will throw on the next throwIfAborted, and p2 must NOT be started.
    adapters.diagnose = vi.fn(async ({ post }) => {
      calls.push(`diagnose:${post.id}`);
      ac.abort();
      return { hookStrength: 5, visualHookStrength: 5, topicNovelty: 5, emotionalDriver: "x", structuralPattern: "y", hypothesis: "z", model: "m" };
    });
    const events = [];
    const r = await runRepurposePipeline({
      posts: [mkPost({ id: "p1", _score: 9 }), mkPost({ id: "p2", _score: 8 })],
      minScore: 1, count: 2,
      adapters,
      signal: ac.signal,
      onEvent: (e) => events.push(e),
    });
    // p2 never touched
    expect(calls.some((c) => c.endsWith(":p2"))).toBe(false);
    expect(r.aborted).toBe(true);
    // Either post.aborted or batch.aborted should fire
    expect(events.some((e) => e.type === "post.aborted" || e.type === "batch.aborted")).toBe(true);
  });

  it("pre-aborted signal short-circuits before any download", async () => {
    const ac = new AbortController();
    ac.abort();
    const { calls, adapters } = mkAdapters();
    const r = await runRepurposePipeline({
      posts: [mkPost({ id: "p1", _score: 9 })],
      minScore: 1, count: 1,
      adapters,
      signal: ac.signal,
    });
    expect(calls).toEqual([]);
    expect(r.completed).toBe(0);
  });
});

describe("runRepurposePipeline — health gate", () => {
  it("throws BEFORE downloading anything when Ollama is unreachable", async () => {
    const { calls, adapters } = mkAdapters({
      health: vi.fn(async () => ({ ollama: { ok: false, err: "ECONNREFUSED" }, whisper: { ok: true } })),
    });
    await expect(runRepurposePipeline({
      posts: [mkPost({ id: "p1", _score: 5 })],
      minScore: 1, count: 1, adapters,
    })).rejects.toBeInstanceOf(PipelineHealthError);
    expect(calls).toEqual([]);
  });
});

describe("runRepurposePipeline — empty / failure", () => {
  it("returns ok with completed=0 when no candidates pass minScore", async () => {
    const { adapters } = mkAdapters();
    const r = await runRepurposePipeline({
      posts: [mkPost({ id: "p1", _score: 1 })],
      minScore: 5, count: 5, adapters,
    });
    expect(r.completed).toBe(0);
    expect(r.items).toHaveLength(0);
  });

  it("records per-post failure without halting the batch", async () => {
    const { calls, adapters } = mkAdapters();
    adapters.transcribe = vi.fn(async ({ post }) => {
      calls.push(`transcribe:${post.id}`);
      if (post.id === "p1") throw new Error("sidecar timeout");
      return { text: "ok", segments: [], language: "en", model: "base" };
    });
    const r = await runRepurposePipeline({
      posts: [mkPost({ id: "p1", _score: 9 }), mkPost({ id: "p2", _score: 8 })],
      minScore: 1, count: 2, adapters,
    });
    expect(r.failed).toBe(1);
    expect(r.completed).toBe(1);
    // p2 still ran end-to-end after p1 failed
    expect(calls).toContain("download:p2");
    expect(calls).toContain("transcribe:p2");
    expect(calls).toContain("diagnose:p2");
    expect(calls).toContain("rewrite:p2");
  });
});

describe("PLATFORMS / STEPS exports", () => {
  it("exports the canonical platform list", () => {
    expect(PLATFORMS).toEqual(["tiktok", "yt_shorts", "x", "linkedin"]);
  });
  it("exports the canonical step list ending in readme", () => {
    expect(STEPS[STEPS.length - 1]).toBe("readme");
    expect(STEPS).toContain("download");
    expect(STEPS).toContain("transcribe");
    expect(STEPS).toContain("diagnose");
    expect(STEPS).toContain("rewrite");
  });
});
