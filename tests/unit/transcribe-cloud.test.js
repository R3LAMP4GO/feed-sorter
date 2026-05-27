import { describe, it, expect } from "vitest";
import {
  transcribeWithGroq,
  testGroqKey,
  GROQ_MAX_BYTES,
  transcribeWithHuggingFace,
  testHuggingFaceKey,
  HF_BASE,
  HF_DEFAULT_MODEL,
} from "../../src/lib/transcribe-cloud.js";

// --- helpers ---------------------------------------------------------------

const videoBytes = (n = 1024) => new Uint8Array(n).fill(7).buffer;

function makeFetchImpl(handlers) {
  // handlers: array of { match: (url, opts) => bool, respond: (url, opts) => Response-like }
  // Calls are recorded for assertions.
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    for (const h of handlers) {
      if (h.match(url, opts)) return h.respond(url, opts);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

const videoOk = (buf = videoBytes()) => ({
  match: (url) => /\.mp4($|\?)/.test(url) || url.startsWith("https://video.example/"),
  respond: () => ({ ok: true, status: 200, async arrayBuffer() { return buf; } }),
});

const post = { id: "ig_1", videoUrl: "https://video.example/clip.mp4" };

// --- tests -----------------------------------------------------------------

describe("transcribeWithGroq", () => {
  it("returns null when groqApiKey is empty (caller falls through to sidecar)", async () => {
    const fetchImpl = makeFetchImpl([]);
    const r = await transcribeWithGroq(post, { apiKey: "", fetchImpl });
    expect(r).toBeNull();
    expect(fetchImpl.calls).toHaveLength(0); // never even fetches the video
  });

  it("returns null when post has no videoUrl", async () => {
    const fetchImpl = makeFetchImpl([]);
    const r = await transcribeWithGroq({ id: "x" }, { apiKey: "k", fetchImpl });
    expect(r).toBeNull();
  });

  it("builds a multipart form with file/model/response_format/language and Bearer auth", async () => {
    let capturedBody = null;
    let capturedHeaders = null;
    let capturedUrl = null;
    const fetchImpl = makeFetchImpl([
      videoOk(),
      {
        match: (url) => url.includes("/audio/transcriptions"),
        respond: (url, opts) => {
          capturedUrl = url;
          capturedBody = opts.body;
          capturedHeaders = opts.headers;
          return { ok: true, status: 200, async json() { return { text: "hello world" }; } };
        },
      },
    ]);
    const r = await transcribeWithGroq(post, {
      apiKey: "test-key-123",
      fetchImpl,
      language: "en",
    });
    expect(r).toEqual({ ok: true, text: "hello world", source: "groq-whisper" });
    expect(capturedUrl).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(capturedHeaders).toMatchObject({ Authorization: "Bearer test-key-123" });
    expect(capturedBody).toBeInstanceOf(FormData);
    expect(capturedBody.get("model")).toBe("whisper-large-v3-turbo");
    expect(capturedBody.get("response_format")).toBe("json");
    expect(capturedBody.get("language")).toBe("en");
    const file = capturedBody.get("file");
    expect(file).toBeTruthy();
    // FormData.get("file") returns a File/Blob — both expose .size.
    expect(typeof file.size).toBe("number");
    expect(file.size).toBe(1024);
  });

  it("returns the transcript text from a successful 200 response", async () => {
    const fetchImpl = makeFetchImpl([
      videoOk(),
      {
        match: (url) => url.includes("/audio/transcriptions"),
        respond: () => ({ ok: true, status: 200, async json() { return { text: "the quick brown fox" }; } }),
      },
    ]);
    const r = await transcribeWithGroq(post, { apiKey: "k", fetchImpl });
    expect(r).toEqual({ ok: true, text: "the quick brown fox", source: "groq-whisper" });
  });

  it("returns groq-rate-limit (with retryAfter) on 429 — caller must NOT fall through", async () => {
    const fetchImpl = makeFetchImpl([
      videoOk(),
      {
        match: (url) => url.includes("/audio/transcriptions"),
        respond: () => ({
          ok: false,
          status: 429,
          headers: { get: (k) => (k.toLowerCase() === "retry-after" ? "30" : null) },
          async json() { return {}; },
        }),
      },
    ]);
    const r = await transcribeWithGroq(post, { apiKey: "k", fetchImpl });
    expect(r).toEqual({ ok: false, err: "groq-rate-limit", retryAfter: 30 });
  });

  it("returns null on 5xx so caller falls through to the local sidecar", async () => {
    const fetchImpl = makeFetchImpl([
      videoOk(),
      {
        match: (url) => url.includes("/audio/transcriptions"),
        respond: () => ({ ok: false, status: 503, async json() { return {}; } }),
      },
    ]);
    const r = await transcribeWithGroq(post, { apiKey: "k", fetchImpl });
    expect(r).toBeNull();
  });

  it("bails with 'video too large' when the video buffer exceeds 25 MB", async () => {
    const big = new Uint8Array(GROQ_MAX_BYTES + 1).buffer;
    const fetchImpl = makeFetchImpl([
      {
        match: () => true,
        respond: () => ({ ok: true, status: 200, async arrayBuffer() { return big; } }),
      },
    ]);
    const r = await transcribeWithGroq(post, { apiKey: "k", fetchImpl });
    expect(r).toMatchObject({ ok: false, err: "video too large" });
    // Only the video fetch should have been issued — no upload attempt.
    expect(fetchImpl.calls).toHaveLength(1);
  });

  it("returns null when the video fetch itself fails (network or 404)", async () => {
    const fetchImpl = makeFetchImpl([
      { match: () => true, respond: () => ({ ok: false, status: 404 }) },
    ]);
    const r = await transcribeWithGroq(post, { apiKey: "k", fetchImpl });
    expect(r).toBeNull();
  });
});

describe("transcribeWithHuggingFace", () => {
  const HF_URL = `${HF_BASE}/models/${HF_DEFAULT_MODEL}`;
  const hfPost = { id: "ig_2", videoUrl: "https://video.example/clip2.mp4" };

  it("is skipped when hfApiKey is empty (returns null, no fetch)", async () => {
    const fetchImpl = makeFetchImpl([]);
    const r = await transcribeWithHuggingFace(hfPost, { apiKey: "", fetchImpl });
    expect(r).toBeNull();
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("returns text from a successful 200 response", async () => {
    let capturedHeaders = null;
    let capturedUrl = null;
    const fetchImpl = makeFetchImpl([
      videoOk(),
      {
        match: (url) => url === HF_URL,
        respond: (url, opts) => {
          capturedUrl = url;
          capturedHeaders = opts.headers;
          return { ok: true, status: 200, async json() { return { text: "hello from hf" }; } };
        },
      },
    ]);
    const r = await transcribeWithHuggingFace(hfPost, { apiKey: "hf_abc", fetchImpl });
    expect(r).toEqual({ ok: true, text: "hello from hf", source: "hf-whisper" });
    expect(capturedUrl).toBe(HF_URL);
    expect(capturedHeaders).toMatchObject({
      Authorization: "Bearer hf_abc",
      "Content-Type": "audio/mpeg",
    });
  });

  it("retries once after a 503 with estimated_time, then succeeds", async () => {
    let post503Calls = 0;
    const fetchImpl = makeFetchImpl([
      videoOk(),
      {
        match: (url) => url === HF_URL,
        respond: () => {
          post503Calls++;
          if (post503Calls === 1) {
            return {
              ok: false,
              status: 503,
              async json() { return { error: "loading", estimated_time: 0.01 }; },
            };
          }
          return { ok: true, status: 200, async json() { return { text: "after retry" }; } };
        },
      },
    ]);
    const r = await transcribeWithHuggingFace(hfPost, { apiKey: "k", fetchImpl });
    expect(r).toEqual({ ok: true, text: "after retry", source: "hf-whisper" });
    expect(post503Calls).toBe(2); // exactly one retry
  });

  it("returns null after a second 503 (caller falls through to sidecar)", async () => {
    let post503Calls = 0;
    const fetchImpl = makeFetchImpl([
      videoOk(),
      {
        match: (url) => url === HF_URL,
        respond: () => {
          post503Calls++;
          return {
            ok: false,
            status: 503,
            async json() { return { error: "still loading", estimated_time: 0.01 }; },
          };
        },
      },
    ]);
    const r = await transcribeWithHuggingFace(hfPost, { apiKey: "k", fetchImpl });
    expect(r).toBeNull();
    expect(post503Calls).toBe(2); // initial + one retry, then give up
  });

  it("is NOT invoked when Groq returned 429 and fallbackOnRateLimit is false", async () => {
    const fetchImpl = makeFetchImpl([
      // If HF were invoked, the video fetch would land here.
      videoOk(),
      { match: () => true, respond: () => ({ ok: true, status: 200, async json() { return { text: "should not happen" }; } }) },
    ]);
    const r = await transcribeWithHuggingFace(hfPost, {
      apiKey: "k",
      fetchImpl,
      groqRateLimited: true,
      fallbackOnRateLimit: false,
    });
    expect(r).toBeNull();
    // Nothing fetched at all — the gate short-circuits before the video fetch.
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("IS invoked when Groq returned 429 and fallbackOnRateLimit is true", async () => {
    const fetchImpl = makeFetchImpl([
      videoOk(),
      {
        match: (url) => url === HF_URL,
        respond: () => ({ ok: true, status: 200, async json() { return { text: "hf rescued the run" }; } }),
      },
    ]);
    const r = await transcribeWithHuggingFace(hfPost, {
      apiKey: "k",
      fetchImpl,
      groqRateLimited: true,
      fallbackOnRateLimit: true,
    });
    expect(r).toEqual({ ok: true, text: "hf rescued the run", source: "hf-whisper" });
  });
});

describe("testHuggingFaceKey", () => {
  it("returns ok on a 200 from /api/whoami-v2", async () => {
    let capturedHeaders = null;
    const fetchImpl = async (url, opts) => {
      expect(url).toBe("https://huggingface.co/api/whoami-v2");
      capturedHeaders = opts.headers;
      return { ok: true, status: 200 };
    };
    const r = await testHuggingFaceKey("hf_xyz", { fetchImpl });
    expect(r).toEqual({ ok: true, status: 200 });
    expect(capturedHeaders).toMatchObject({ Authorization: "Bearer hf_xyz" });
  });

  it("returns ok:false with no key", async () => {
    const r = await testHuggingFaceKey("", { fetchImpl: async () => ({ ok: true, status: 200 }) });
    expect(r.ok).toBe(false);
  });

  it("returns ok:false on non-2xx", async () => {
    const fetchImpl = async () => ({ ok: false, status: 401 });
    const r = await testHuggingFaceKey("bad", { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });
});

describe("testGroqKey", () => {
  it("returns ok on a 200 from /openai/v1/models", async () => {
    let capturedHeaders = null;
    const fetchImpl = async (url, opts) => {
      expect(url).toBe("https://api.groq.com/openai/v1/models");
      capturedHeaders = opts.headers;
      return { ok: true, status: 200 };
    };
    const r = await testGroqKey("my-key", { fetchImpl });
    expect(r).toEqual({ ok: true, status: 200 });
    expect(capturedHeaders).toMatchObject({ Authorization: "Bearer my-key" });
  });

  it("returns ok:false with no key", async () => {
    const r = await testGroqKey("", { fetchImpl: async () => ({ ok: true, status: 200 }) });
    expect(r.ok).toBe(false);
  });

  it("returns ok:false on non-2xx", async () => {
    const fetchImpl = async () => ({ ok: false, status: 401 });
    const r = await testGroqKey("bad", { fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });
});
