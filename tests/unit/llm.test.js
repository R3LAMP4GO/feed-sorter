// Tests for the local-only LLM client (Ollama).
//
// We mock fetch end-to-end. The chat() helper consumes Ollama's NDJSON
// stream, so the mock returns a Response whose `body.getReader()` emits
// pre-canned chunks.

import { describe, it, expect, beforeEach } from "vitest";
import {
  chat,
  healthCheck,
  promptHash,
  listGroqModels,
  pickProvider,
  isFastKind,
  DEFAULT_ENDPOINT,
  DEFAULT_GROQ_MODEL,
  DEFAULT_GROQ_FAST_MODEL,
  GROQ_ENDPOINT,
  GROQ_MODELS_ENDPOINT,
} from "../../src/lib/llm.js";

const enc = new TextEncoder();

// Build a Response-like object whose body streams the supplied chunks.
const ndjsonResponse = (chunks, { ok = true, status = 200 } = {}) => {
  let i = 0;
  return {
    ok,
    status,
    body: {
      getReader: () => ({
        read: async () => {
          if (i >= chunks.length) return { value: undefined, done: true };
          const v = enc.encode(chunks[i++]);
          return { value: v, done: false };
        },
      }),
    },
    text: async () => chunks.join(""),
    json: async () => JSON.parse(chunks.join("")),
  };
};

const okStream = (parts) => ndjsonResponse(parts);

describe("chat", () => {
  let lastUrl;
  let lastInit;
  const mkFetch = (responder) => async (url, init) => {
    lastUrl = url;
    lastInit = init;
    return responder(url, init);
  };

  beforeEach(() => { lastUrl = lastInit = null; });

  it("posts to /api/chat with messages and stream=true; joins NDJSON content", async () => {
    const fetchImpl = mkFetch(() => okStream([
      `${JSON.stringify({ model: "gemma4", message: { role: "assistant", content: "Hello " } })}\n`,
      `${JSON.stringify({ model: "gemma4", message: { role: "assistant", content: "world" } })}\n`,
      `${JSON.stringify({ model: "gemma4", done: true, prompt_eval_count: 12, eval_count: 7 })}\n`,
    ]));

    const r = await chat({
      model: "gemma4",
      messages: [{ role: "user", content: "Hi" }],
      fetchImpl,
    });

    expect(lastUrl).toBe("http://localhost:11434/api/chat");
    const body = JSON.parse(lastInit.body);
    expect(body.model).toBe("gemma4");
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([{ role: "user", content: "Hi" }]);
    expect(body.format).toBeUndefined();
    expect(r.text).toBe("Hello world");
    expect(r.tokensIn).toBe(12);
    expect(r.tokensOut).toBe(7);
    expect(r.cached).toBe(false);
  });

  it("respects a custom endpoint", async () => {
    const fetchImpl = mkFetch(() => okStream([
      `${JSON.stringify({ done: true })}\n`,
    ]));
    await chat({
      endpoint: "http://192.168.1.50:11434/",
      messages: [{ role: "user", content: "Hi" }],
      fetchImpl,
    });
    expect(lastUrl).toBe("http://192.168.1.50:11434/api/chat");
  });

  it("attaches base64 images to the LAST user message", async () => {
    const fetchImpl = mkFetch(() => okStream([
      `${JSON.stringify({ message: { content: "ok" } })}\n`,
      `${JSON.stringify({ done: true })}\n`,
    ]));
    await chat({
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "first?" },
        { role: "assistant", content: "yes" },
        { role: "user", content: "describe" },
      ],
      images: ["BASE64DATA"],
      fetchImpl,
    });
    const body = JSON.parse(lastInit.body);
    expect(body.messages[3].images).toEqual(["BASE64DATA"]);
    expect(body.messages[1].images).toBeUndefined();
  });

  it("forwards `format: schema` for structured output and parses JSON", async () => {
    const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
    const fetchImpl = mkFetch(() => okStream([
      `${JSON.stringify({ message: { content: '{"name":' } })}\n`,
      `${JSON.stringify({ message: { content: '"Adriano"}' } })}\n`,
      `${JSON.stringify({ done: true, prompt_eval_count: 4, eval_count: 5 })}\n`,
    ]));
    const r = await chat({
      schema,
      messages: [{ role: "user", content: "extract" }],
      fetchImpl,
    });
    const body = JSON.parse(lastInit.body);
    expect(body.format).toEqual(schema);
    expect(r.text).toBe('{"name":"Adriano"}');
    expect(r.json).toEqual({ name: "Adriano" });
  });

  it("recovers JSON wrapped in ```json fences", async () => {
    const schema = { type: "object" };
    const fetchImpl = mkFetch(() => okStream([
      `${JSON.stringify({ message: { content: '```json\n{"a":1}\n```' } })}\n`,
      `${JSON.stringify({ done: true })}\n`,
    ]));
    const r = await chat({ schema, messages: [{ role: "user", content: "x" }], fetchImpl });
    expect(r.json).toEqual({ a: 1 });
  });

  it("throws when schema is set but model returns invalid JSON", async () => {
    const fetchImpl = mkFetch(() => okStream([
      `${JSON.stringify({ message: { content: "not-json at all" } })}\n`,
      `${JSON.stringify({ done: true })}\n`,
    ]));
    await expect(
      chat({ schema: { type: "object" }, messages: [{ role: "user", content: "x" }], fetchImpl })
    ).rejects.toThrow(/JSON parse failed/);
  });

  it("throws on non-2xx response with status attached", async () => {
    const fetchImpl = mkFetch(() => ({
      ok: false, status: 500, body: null,
      text: async () => "boom",
    }));
    await expect(
      chat({ messages: [{ role: "user", content: "x" }], fetchImpl })
    ).rejects.toMatchObject({ status: 500 });
  });

  it("rejects when the caller's AbortSignal fires", async () => {
    const ctrl = new AbortController();
    const fetchImpl = (_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
    const p = chat({
      messages: [{ role: "user", content: "x" }],
      fetchImpl,
      signal: ctrl.signal,
      timeoutMs: 0,
    });
    setTimeout(() => ctrl.abort(), 10);
    await expect(p).rejects.toThrow(/aborted/);
  });

  it("rejects when the timeout elapses before a response", async () => {
    const fetchImpl = (_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => {
        const e = new Error(init.signal.reason?.message || "aborted");
        e.name = "AbortError";
        reject(e);
      });
    });
    await expect(
      chat({ messages: [{ role: "user", content: "x" }], fetchImpl, timeoutMs: 20 })
    ).rejects.toThrow(/timeout/);
  });

  it("requires messages[]", async () => {
    await expect(chat({ messages: [], fetchImpl: async () => okStream([]) }))
      .rejects.toThrow(/messages/);
  });
});

describe("healthCheck", () => {
  it("returns the model list from /api/tags on 200", async () => {
    const fetchImpl = async (url) => {
      expect(url).toBe(`${DEFAULT_ENDPOINT}/api/tags`);
      return {
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: "gemma4:latest" }, { name: "llama3:8b" }] }),
        text: async () => "",
      };
    };
    const r = await healthCheck(undefined, { fetchImpl });
    expect(r.ok).toBe(true);
    expect(r.models).toEqual(["gemma4:latest", "llama3:8b"]);
  });

  it("throws on 5xx with status attached", async () => {
    const fetchImpl = async () => ({ ok: false, status: 503, text: async () => "", json: async () => ({}) });
    await expect(healthCheck("http://localhost:11434", { fetchImpl }))
      .rejects.toMatchObject({ status: 503 });
  });

  it("trims trailing slashes from the endpoint", async () => {
    let seen;
    const fetchImpl = async (url) => {
      seen = url;
      return { ok: true, status: 200, json: async () => ({ models: [] }), text: async () => "" };
    };
    await healthCheck("http://localhost:11434///", { fetchImpl });
    expect(seen).toBe("http://localhost:11434/api/tags");
  });
});

// ----- Groq adapter ---------------------------------------------------------

const groqJsonResponse = (payload, { ok = true, status = 200, headers = null } = {}) => ({
  ok,
  status,
  headers: {
    get: (k) => (headers?.[String(k).toLowerCase()]) || null,
  },
  json: async () => payload,
  text: async () => JSON.stringify(payload),
});

const groqChoice = (content, model = DEFAULT_GROQ_MODEL) => groqJsonResponse({
  id: "chatcmpl-1",
  model,
  choices: [{ index: 0, message: { role: "assistant", content } }],
  usage: { prompt_tokens: 11, completion_tokens: 22 },
});

describe("chat (groq provider)", () => {
  let lastUrl;
  let lastInit;
  const mkFetch = (responder) => async (url, init) => {
    lastUrl = url;
    lastInit = init;
    return responder(url, init);
  };
  beforeEach(() => { lastUrl = lastInit = null; });

  it("posts to the Groq URL with bearer auth and OpenAI-shaped body", async () => {
    const fetchImpl = mkFetch(() => groqChoice("hello from groq"));
    const r = await chat({
      provider: "groq",
      apiKey: "gsk_test_123",
      messages: [{ role: "user", content: "hi" }],
      kind: "diagnose",
      fetchImpl,
    });
    expect(lastUrl).toBe(GROQ_ENDPOINT);
    expect(lastInit.method).toBe("POST");
    expect(lastInit.headers["Authorization"]).toBe("Bearer gsk_test_123");
    expect(lastInit.headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(lastInit.body);
    expect(body.model).toBe(DEFAULT_GROQ_MODEL);
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.stream).toBe(false);
    expect(body.response_format).toBeUndefined();
    expect(r.text).toBe("hello from groq");
    expect(r.tokensIn).toBe(11);
    expect(r.tokensOut).toBe(22);
    expect(r.cached).toBe(false);
  });

  it("per-post-analysis kind routes to the fast model", async () => {
    const fetchImpl = mkFetch(() => groqChoice("ok", DEFAULT_GROQ_FAST_MODEL));
    await chat({
      provider: "groq",
      apiKey: "gsk_x",
      kind: "per-post-analysis",
      messages: [{ role: "user", content: "x" }],
      fetchImpl,
    });
    const body = JSON.parse(lastInit.body);
    expect(body.model).toBe(DEFAULT_GROQ_FAST_MODEL);
  });

  it("hookType + hook + topic kinds also pick the fast model", async () => {
    for (const kind of ["hookType", "hook", "topic", "niche-label"]) {
      const fetchImpl = mkFetch(() => groqChoice("ok"));
      await chat({
        provider: "groq", apiKey: "gsk_x", kind,
        messages: [{ role: "user", content: "x" }], fetchImpl,
      });
      const body = JSON.parse(lastInit.body);
      expect(body.model, `kind=${kind}`).toBe(DEFAULT_GROQ_FAST_MODEL);
    }
  });

  it("diagnose / cover / rewrite / voice kinds use the main model", async () => {
    for (const kind of ["diagnose", "cover", "rewrite:ig", "voice-fingerprint", "generic"]) {
      const fetchImpl = mkFetch(() => groqChoice("ok"));
      await chat({
        provider: "groq", apiKey: "gsk_x", kind,
        messages: [{ role: "user", content: "x" }], fetchImpl,
      });
      const body = JSON.parse(lastInit.body);
      expect(body.model, `kind=${kind}`).toBe(DEFAULT_GROQ_MODEL);
    }
  });

  it("respects custom main/fast model overrides", async () => {
    const fetchImpl = mkFetch(() => groqChoice("ok"));
    await chat({
      provider: "groq", apiKey: "gsk_x",
      model: "mixtral-8x7b", fastModel: "llama-fast-custom",
      kind: "hook",
      messages: [{ role: "user", content: "x" }], fetchImpl,
    });
    expect(JSON.parse(lastInit.body).model).toBe("llama-fast-custom");
    await chat({
      provider: "groq", apiKey: "gsk_x",
      model: "mixtral-8x7b", fastModel: "llama-fast-custom",
      kind: "diagnose",
      messages: [{ role: "user", content: "x" }], fetchImpl,
    });
    expect(JSON.parse(lastInit.body).model).toBe("mixtral-8x7b");
  });

  it("enables JSON mode (response_format) when a schema is provided", async () => {
    const fetchImpl = mkFetch(() => groqChoice('{"name":"Adriano"}'));
    const r = await chat({
      provider: "groq", apiKey: "gsk_x",
      schema: { type: "object", properties: { name: { type: "string" } } },
      messages: [{ role: "user", content: "extract" }],
      fetchImpl,
    });
    const body = JSON.parse(lastInit.body);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(r.json).toEqual({ name: "Adriano" });
  });

  it("surfaces 429 as a structured rate-limit error", async () => {
    const fetchImpl = mkFetch(() => ({
      ok: false,
      status: 429,
      headers: { get: (k) => (String(k).toLowerCase() === "retry-after" ? "7" : null) },
      text: async () => "rate limit exceeded",
      json: async () => ({}),
    }));
    let caught;
    try {
      await chat({
        provider: "groq", apiKey: "gsk_x",
        messages: [{ role: "user", content: "x" }], fetchImpl,
      });
    } catch (e) { caught = e; }
    expect(caught).toBeTruthy();
    expect(caught.status).toBe(429);
    expect(caught.kind).toBe("rate-limit");
    expect(caught.provider).toBe("groq");
    expect(caught.retryAfter).toBe("7");
  });

  it("surfaces 401 as a structured auth error", async () => {
    const fetchImpl = mkFetch(() => ({
      ok: false, status: 401,
      headers: { get: () => null },
      text: async () => "invalid_api_key",
      json: async () => ({}),
    }));
    await expect(chat({
      provider: "groq", apiKey: "gsk_bad",
      messages: [{ role: "user", content: "x" }], fetchImpl,
    })).rejects.toMatchObject({ status: 401, kind: "auth" });
  });

  it("throws when apiKey is missing", async () => {
    await expect(chat({
      provider: "groq",
      messages: [{ role: "user", content: "x" }],
      fetchImpl: async () => groqChoice("x"),
    })).rejects.toThrow(/apiKey/);
  });

  it("forwards temperature/top_p/max_tokens through `options`", async () => {
    const fetchImpl = mkFetch(() => groqChoice("ok"));
    await chat({
      provider: "groq", apiKey: "gsk_x",
      options: { temperature: 0.2, top_p: 0.9, max_tokens: 256 },
      messages: [{ role: "user", content: "x" }], fetchImpl,
    });
    const body = JSON.parse(lastInit.body);
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.9);
    expect(body.max_tokens).toBe(256);
  });
});

describe("chat (provider auto-detect)", () => {
  it("auto-selects groq when apiKey is set and no provider is forced", async () => {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        json: async () => ({
          model: DEFAULT_GROQ_MODEL,
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        text: async () => "",
      };
    };
    await chat({
      apiKey: "gsk_auto",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl,
    });
    expect(seen.url).toBe(GROQ_ENDPOINT);
    expect(seen.init.headers["Authorization"]).toBe("Bearer gsk_auto");
  });

  it("auto-selects ollama when only an endpoint is configured", async () => {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return ndjsonResponse([`${JSON.stringify({ done: true })}\n`]);
    };
    await chat({
      endpoint: "http://localhost:11434",
      messages: [{ role: "user", content: "hi" }],
      fetchImpl,
    });
    expect(seen.url).toBe("http://localhost:11434/api/chat");
    expect(seen.init.headers["Authorization"]).toBeUndefined();
  });
});

describe("pickProvider / isFastKind", () => {
  it("explicit provider wins over heuristics", () => {
    expect(pickProvider({ provider: "groq", endpoint: "x" })).toBe("groq");
    expect(pickProvider({ provider: "ollama", apiKey: "x" })).toBe("ollama");
  });
  it("apiKey implies groq, endpoint implies ollama, neither defaults to ollama", () => {
    expect(pickProvider({ apiKey: "gsk_x" })).toBe("groq");
    expect(pickProvider({ endpoint: "http://localhost:11434" })).toBe("ollama");
    expect(pickProvider({})).toBe("ollama");
  });
  it("flags batch / per-post kinds as fast", () => {
    expect(isFastKind("hook")).toBe(true);
    expect(isFastKind("per-post-analysis")).toBe(true);
    expect(isFastKind("hookType")).toBe(true);
    expect(isFastKind("diagnose")).toBe(false);
    expect(isFastKind("rewrite:ig")).toBe(false);
  });
});

describe("healthCheck (groq)", () => {
  it("GETs /openai/v1/models with bearer auth and returns the id list", async () => {
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return {
        ok: true, status: 200,
        json: async () => ({ data: [
          { id: "llama-3.3-70b-versatile" },
          { id: "llama-3.1-8b-instant" },
          { id: "whisper-large-v3" },
        ]}),
        text: async () => "",
      };
    };
    const r = await healthCheck({ provider: "groq", apiKey: "gsk_h", fetchImpl });
    expect(seen.url).toBe(GROQ_MODELS_ENDPOINT);
    expect(seen.init.method).toBe("GET");
    expect(seen.init.headers["Authorization"]).toBe("Bearer gsk_h");
    expect(r.ok).toBe(true);
    expect(r.provider).toBe("groq");
    expect(r.models).toContain("llama-3.3-70b-versatile");
  });

  it("throws auth-tagged error on 401", async () => {
    const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => "" });
    await expect(healthCheck({ provider: "groq", apiKey: "bad", fetchImpl }))
      .rejects.toMatchObject({ status: 401, kind: "auth" });
  });
});

describe("listGroqModels", () => {
  it("returns the parsed id list", async () => {
    const fetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => ({ data: [{ id: "a" }, { id: "b" }, { not_id: 1 }] }),
      text: async () => "",
    });
    const r = await listGroqModels({ apiKey: "gsk_x", fetchImpl });
    expect(r.models).toEqual(["a", "b"]);
  });
  it("requires apiKey", async () => {
    await expect(listGroqModels({ fetchImpl: async () => ({}) }))
      .rejects.toThrow(/apiKey/);
  });
});

describe("promptHash", () => {
  it("is stable across key order", () => {
    const a = promptHash({ x: 1, y: [1, 2], z: { a: 1, b: 2 } });
    const b = promptHash({ z: { b: 2, a: 1 }, y: [1, 2], x: 1 });
    expect(a).toBe(b);
  });
  it("changes when content changes", () => {
    expect(promptHash({ x: 1 })).not.toBe(promptHash({ x: 2 }));
  });
});
