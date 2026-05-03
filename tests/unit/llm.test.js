// Tests for the local-only LLM client (Ollama).
//
// We mock fetch end-to-end. The chat() helper consumes Ollama's NDJSON
// stream, so the mock returns a Response whose `body.getReader()` emits
// pre-canned chunks.

import { describe, it, expect, beforeEach } from "vitest";
import { chat, healthCheck, promptHash, DEFAULT_ENDPOINT } from "../../src/lib/llm.js";

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
  let lastUrl, lastInit;
  const mkFetch = (responder) => async (url, init) => {
    lastUrl = url;
    lastInit = init;
    return responder(url, init);
  };

  beforeEach(() => { lastUrl = lastInit = null; });

  it("posts to /api/chat with messages and stream=true; joins NDJSON content", async () => {
    const fetchImpl = mkFetch(() => okStream([
      JSON.stringify({ model: "gemma4", message: { role: "assistant", content: "Hello " } }) + "\n",
      JSON.stringify({ model: "gemma4", message: { role: "assistant", content: "world" } }) + "\n",
      JSON.stringify({ model: "gemma4", done: true, prompt_eval_count: 12, eval_count: 7 }) + "\n",
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
      JSON.stringify({ done: true }) + "\n",
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
      JSON.stringify({ message: { content: "ok" } }) + "\n",
      JSON.stringify({ done: true }) + "\n",
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
      JSON.stringify({ message: { content: '{"name":' } }) + "\n",
      JSON.stringify({ message: { content: '"Adriano"}' } }) + "\n",
      JSON.stringify({ done: true, prompt_eval_count: 4, eval_count: 5 }) + "\n",
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
      JSON.stringify({ message: { content: '```json\n{"a":1}\n```' } }) + "\n",
      JSON.stringify({ done: true }) + "\n",
    ]));
    const r = await chat({ schema, messages: [{ role: "user", content: "x" }], fetchImpl });
    expect(r.json).toEqual({ a: 1 });
  });

  it("throws when schema is set but model returns invalid JSON", async () => {
    const fetchImpl = mkFetch(() => okStream([
      JSON.stringify({ message: { content: "not-json at all" } }) + "\n",
      JSON.stringify({ done: true }) + "\n",
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
      expect(url).toBe(DEFAULT_ENDPOINT + "/api/tags");
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
