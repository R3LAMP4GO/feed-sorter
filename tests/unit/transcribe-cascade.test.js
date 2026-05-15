// Unit tests for the order-aware transcription cascade.
//
// The cascade is the spec for the `fs-transcribe` handler in background.js
// (mirrored as src/lib/transcribe-cascade-runtime.js for the SW). Tier
// functions are stubbed — no real network calls.

import { describe, it, expect } from "vitest";
import { runCascade, TIERS_FOR_MODE } from "../../src/lib/transcribe-cascade.js";
import { createTokenBucket, runBulkTranscribe } from "../../src/lib/bulk-transcribe.js";

const POST = { id: "ig_123", videoUrl: "https://cdn/foo.mp4" };

// Build a fake clock that advances by `step` ms on every call. Each
// `runCascade` reads the clock twice per tier (start + end), so the per-tier
// latency is exactly one step.
const fakeClock = (step = 5) => {
  let t = 1000;
  return () => { const v = t; t += step; return v; };
};

const makeLog = () => {
  const events = [];
  return {
    log: (event, data) => events.push({ event, data }),
    events,
    tierEvents: () => events.filter((e) => e.event === "transcribe.tier"),
  };
};

const ok = (source, text = "hello") => async () => ({ text, source });
const miss = () => async () => null;
const boom = () => async () => { throw new Error("kaboom"); };

describe("runCascade — auto mode", () => {
  it("tries tiers in order until one succeeds", async () => {
    const calls = [];
    const tag = (name, fn) => async (p) => { calls.push(name); return fn(p); };
    const { log, tierEvents } = makeLog();

    const result = await runCascade({
      post: POST,
      mode: "auto",
      tiers: {
        free: tag("free", miss()),
        groq: tag("groq", miss()),
        hf: tag("hf", ok("hf-whisper", "from hf")),
        sidecar: tag("sidecar", ok("whisper", "should-not-run")),
      },
      log,
      now: fakeClock(),
    });

    expect(calls).toEqual(["free", "groq", "hf"]); // sidecar never invoked
    expect(result).toMatchObject({ ok: true, text: "from hf", source: "hf-whisper" });
    expect(result.latencyMs).toBeGreaterThan(0);

    const tiers = tierEvents().map((e) => e.data);
    expect(tiers).toEqual([
      { tier: "free", ok: false, ms: 5 },
      { tier: "groq", ok: false, ms: 5 },
      { tier: "hf", ok: true, ms: 5 },
    ]);
  });

  it("a thrown tier counts as a miss and the cascade continues", async () => {
    const result = await runCascade({
      post: POST,
      mode: "auto",
      tiers: {
        free: boom(),
        groq: ok("groq-whisper", "from groq"),
        hf: miss(),
        sidecar: miss(),
      },
      log: () => {},
      now: fakeClock(),
    });
    expect(result).toMatchObject({ ok: true, source: "groq-whisper", text: "from groq" });
  });
});

describe("runCascade — non-auto modes", () => {
  it("free-only skips cloud + sidecar even when free returns null", async () => {
    const calls = [];
    const tag = (name, fn) => async (p) => { calls.push(name); return fn(p); };
    const { log, tierEvents } = makeLog();

    const result = await runCascade({
      post: POST,
      mode: "free-only",
      tiers: {
        free: tag("free", miss()),
        groq: tag("groq", ok("groq-whisper")),
        hf: tag("hf", ok("hf-whisper")),
        sidecar: tag("sidecar", ok("whisper")),
      },
      log,
      now: fakeClock(),
    });

    expect(calls).toEqual(["free"]);
    expect(result).toEqual({ ok: false, err: "all-tiers-exhausted" });
    expect(tierEvents().map((e) => e.data.tier)).toEqual(["free"]);
  });

  it("cloud-only skips sidecar even when both clouds fail", async () => {
    const calls = [];
    const tag = (name, fn) => async (p) => { calls.push(name); return fn(p); };
    const { log, tierEvents } = makeLog();

    const result = await runCascade({
      post: POST,
      mode: "cloud-only",
      tiers: {
        free: tag("free", ok("ig-alt", "free-result")),
        groq: tag("groq", miss()),
        hf: tag("hf", miss()),
        sidecar: tag("sidecar", ok("whisper", "sidecar-result")),
      },
      log,
      now: fakeClock(),
    });

    expect(calls).toEqual(["groq", "hf"]); // free skipped, sidecar skipped
    expect(result).toEqual({ ok: false, err: "all-tiers-exhausted" });
    expect(tierEvents().map((e) => e.data.tier)).toEqual(["groq", "hf"]);
  });

  it("sidecar-only runs only the sidecar tier", async () => {
    const calls = [];
    const tag = (name, fn) => async (p) => { calls.push(name); return fn(p); };

    const result = await runCascade({
      post: POST,
      mode: "sidecar-only",
      tiers: {
        free: tag("free", ok("ig-alt")),
        groq: tag("groq", ok("groq-whisper")),
        hf: tag("hf", ok("hf-whisper")),
        sidecar: tag("sidecar", ok("whisper", "from sidecar")),
      },
      log: () => {},
      now: fakeClock(),
    });

    expect(calls).toEqual(["sidecar"]);
    expect(result).toMatchObject({ ok: true, source: "whisper", text: "from sidecar" });
  });
});

describe("runCascade — observability", () => {
  it("logs latency per tier via the `transcribe.tier` event", async () => {
    // Step the clock 7ms per call → each tier reports ms = 7.
    const { log, tierEvents } = makeLog();
    await runCascade({
      post: POST,
      mode: "auto",
      tiers: {
        free: miss(),
        groq: miss(),
        hf: miss(),
        sidecar: ok("whisper", "x"),
      },
      log,
      now: fakeClock(7),
    });
    const events = tierEvents();
    expect(events).toHaveLength(4);
    for (const e of events) {
      expect(e.data).toHaveProperty("ms");
      expect(typeof e.data.ms).toBe("number");
      expect(e.data.ms).toBe(7);
      expect(e.data).toHaveProperty("tier");
      expect(e.data).toHaveProperty("ok");
    }
    expect(events[3].data.ok).toBe(true);
  });
});

describe("runCascade — exhaustion", () => {
  it("returns `all-tiers-exhausted` when every tier yields null", async () => {
    const result = await runCascade({
      post: POST,
      mode: "auto",
      tiers: {
        free: miss(),
        groq: miss(),
        hf: miss(),
        sidecar: miss(),
      },
      log: () => {},
      now: fakeClock(),
    });
    expect(result).toEqual({ ok: false, err: "all-tiers-exhausted" });
  });

  it("treats every-tier-throws the same as every-tier-null", async () => {
    const result = await runCascade({
      post: POST,
      mode: "auto",
      tiers: { free: boom(), groq: boom(), hf: boom(), sidecar: boom() },
      log: () => {},
      now: fakeClock(),
    });
    expect(result).toEqual({ ok: false, err: "all-tiers-exhausted" });
  });
});

describe("TIERS_FOR_MODE", () => {
  it("exposes the four documented modes", () => {
    expect(Object.keys(TIERS_FOR_MODE).sort()).toEqual(
      ["auto", "cloud-only", "free-only", "sidecar-only"],
    );
    expect(TIERS_FOR_MODE.auto).toEqual(["free", "groq", "hf", "sidecar"]);
    expect(TIERS_FOR_MODE["free-only"]).toEqual(["free"]);
    expect(TIERS_FOR_MODE["cloud-only"]).toEqual(["groq", "hf"]);
    expect(TIERS_FOR_MODE["sidecar-only"]).toEqual(["sidecar"]);
  });
});

// ---------------------------------------------------------------------------
// Bulk runner — token bucket pacing, 429 retries, cancellation, breakdown.
// ---------------------------------------------------------------------------

// Fake clock + sleep. `sleep(ms)` advances the virtual clock immediately;
// awaiting it queues a microtask so other workers can interleave.
function bulkClock(start = 0) {
  let t = start;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += Math.max(0, ms);
    },
    advance: (ms) => { t += ms; },
    sleeps,
    get t() { return t; },
  };
}

const post = (id, extra = {}) => ({ id, videoUrl: `https://cdn/${id}.mp4`, ...extra });

describe("createTokenBucket", () => {
  it("30 calls in <60s pass without sleeping; the 31st sleeps until the oldest entry ages out", async () => {
    const clk = bulkClock(1000);
    const bucket = createTokenBucket({ limit: 30, windowMs: 60_000, now: clk.now, sleep: clk.sleep });

    // Advance 1ms between calls so each entry has a distinct timestamp —
    // simulates the tiny gaps a real worker pool would produce.
    for (let i = 0; i < 30; i++) { await bucket.acquire(); clk.advance(1); }
    expect(clk.sleeps).toEqual([]); // no sleeping inside the window
    expect(bucket.size()).toBe(30);

    // 31st acquire — bucket full; oldest entry is at t=1000, window is 60s,
    // current t is 1030 → must sleep until 1000+60_000 = 61_000, i.e. 59_970ms.
    await bucket.acquire();
    expect(clk.sleeps).toHaveLength(1);
    expect(clk.sleeps[0]).toBe(59_970);
    // Exactly one entry aged out, the new one was pushed.
    expect(bucket.size()).toBe(30);
  });
});

describe("runBulkTranscribe", () => {
  it("retries once after a 429 with retry-after, sleeping retryAfter*1000 + jitter", async () => {
    const clk = bulkClock(0);
    let calls = 0;
    const transcribe = async () => {
      calls++;
      if (calls === 1) return { ok: false, status: 429, retryAfter: 5 };
      return { ok: true, source: "groq-whisper", text: "hi" };
    };
    const result = await runBulkTranscribe({
      posts: [post("ig_1")],
      transcribe,
      concurrency: 1,
      now: clk.now,
      sleep: clk.sleep,
      jitter: () => 500,
    });
    expect(calls).toBe(2);
    // Exactly one retry-sleep: 5*1000 + 500 = 5500.
    expect(clk.sleeps).toContain(5500);
    expect(result.done).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.tierBreakdown).toEqual({ "groq-whisper": 1 });
  });

  it("skips a post after two consecutive 429s and logs bulk.transcribe.skip", async () => {
    const clk = bulkClock(0);
    const transcribe = async () => ({ ok: false, status: 429, retryAfter: 1 });
    const events = [];
    const log = (level, event, data) => events.push({ level, event, data });
    const result = await runBulkTranscribe({
      posts: [post("ig_999")],
      transcribe,
      concurrency: 1,
      log,
      now: clk.now,
      sleep: clk.sleep,
      jitter: () => 0,
    });
    expect(result.skipped).toBe(1);
    expect(result.done).toBe(0);
    const skip = events.find((e) => e.event === "bulk.transcribe.skip");
    expect(skip).toBeDefined();
    expect(skip.level).toBe("info");
    expect(skip.data).toEqual({ id: "ig_999", reason: "rate-limit-exhausted" });
  });

  it("cancellation flag stops the queue mid-run", async () => {
    const clk = bulkClock(0);
    let processed = 0;
    let cancel = false;
    const transcribe = async () => {
      processed++;
      // Trigger cancel after the third successful call. Workers (concurrency=2)
      // will both observe the flag on their next loop iteration and bail out.
      if (processed >= 3) cancel = true;
      return { ok: true, source: "free", text: "x" };
    };
    const result = await runBulkTranscribe({
      posts: Array.from({ length: 50 }, (_, i) => post(`ig_${i}`)),
      transcribe,
      concurrency: 2,
      shouldCancel: () => cancel,
      now: clk.now,
      sleep: clk.sleep,
    });
    expect(result.cancelled).toBe(true);
    // Strict upper bound: a couple more may slip through because workers
    // already grabbed an index before cancel was observed, but we should be
    // far below the full 50.
    expect(processed).toBeLessThan(10);
    expect(result.done).toBeLessThan(10);
  });

  it("tier breakdown is accurate after a mixed run", async () => {
    const clk = bulkClock(0);
    // Post id encodes the tier the stub should claim.
    const sources = ["tiktok-vtt", "ig-alt", "groq-whisper", "groq-whisper", "hf-whisper", "whisper"];
    const posts = sources.map((s, i) => post(`p_${i}`, { _src: s }));
    const transcribe = async (p) => ({ ok: true, source: p._src, text: "t" });
    const result = await runBulkTranscribe({
      posts,
      transcribe,
      concurrency: 2,
      now: clk.now,
      sleep: clk.sleep,
    });
    expect(result.done).toBe(6);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.tierBreakdown).toEqual({
      "tiktok-vtt": 1,
      "ig-alt": 1,
      "groq-whisper": 2,
      "hf-whisper": 1,
      "whisper": 1,
    });
  });

  it("skips posts that already have a transcript and posts with no media", async () => {
    const clk = bulkClock(0);
    let calls = 0;
    const transcribe = async () => { calls++; return { ok: true, source: "free", text: "x" }; };
    const result = await runBulkTranscribe({
      posts: [
        { id: "a", videoUrl: "https://v/a.mp4", transcript: "already done" },
        { id: "b" }, // no media
        post("c"),
      ],
      transcribe,
      concurrency: 1,
      now: clk.now,
      sleep: clk.sleep,
    });
    expect(calls).toBe(1); // only "c" hit the cascade
    expect(result.done).toBe(1);
    expect(result.skipped).toBe(2);
  });
});
