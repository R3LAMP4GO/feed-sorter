import { describe, it, expect } from "vitest";
import {
  parseWebVTT,
  parseJSON3,
  extractAltText,
  fetchFreeTranscript,
} from "../../src/lib/transcripts.js";

const stubFetch = (body, { ok = true, status = 200 } = {}) => {
  return async (_url, _opts) => ({
    ok,
    status,
    async text() {
      return body;
    },
  });
};

describe("parseWebVTT", () => {
  it("strips a normal cue down to its text", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:02.500",
      "Hello world",
      "",
    ].join("\n");
    expect(parseWebVTT(vtt)).toBe("Hello world");
  });

  it("collapses multiple cues (with cue ids and sub-second timecodes) to a single string", () => {
    const vtt = [
      "WEBVTT",
      "",
      "1",
      "00:00:00.000 --> 00:00:01.250",
      "First line",
      "",
      "2",
      "00:00:01.250 --> 00:00:02.500",
      "Second line",
      "",
      "3",
      "00:00:02.500 --> 00:00:03.000",
      "Third",
      "line",
      "",
    ].join("\n");
    expect(parseWebVTT(vtt)).toBe("First line Second line Third line");
  });

  it("handles voice tags <v Person>...</v> and inline tags", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:02.000",
      "<v Alice>Hi <c.yellow>there</c></v>",
      "",
      "00:00:02.000 --> 00:00:04.000",
      "<v Bob>How are you?</v>",
      "",
    ].join("\n");
    expect(parseWebVTT(vtt)).toBe("Hi there How are you?");
  });

  it("skips NOTE blocks", () => {
    const vtt = [
      "WEBVTT",
      "",
      "NOTE this is a note",
      "with two lines",
      "",
      "00:00:00.000 --> 00:00:01.000",
      "Real text",
      "",
    ].join("\n");
    expect(parseWebVTT(vtt)).toBe("Real text");
  });

  it("returns empty string for empty/garbage input", () => {
    expect(parseWebVTT("")).toBe("");
    expect(parseWebVTT(null)).toBe("");
  });
});

describe("parseJSON3", () => {
  it("joins segs in order", () => {
    const json = JSON.stringify({
      events: [
        { tStartMs: 0, segs: [{ utf8: "Hello" }, { utf8: "world" }] },
        { tStartMs: 1000, segs: [{ utf8: "again" }] },
      ],
    });
    expect(parseJSON3(json)).toBe("Hello world again");
  });

  it("dedupes consecutive identical segments", () => {
    const json = JSON.stringify({
      events: [
        { tStartMs: 0, segs: [{ utf8: "Repeat" }] },
        { tStartMs: 500, segs: [{ utf8: "Repeat" }] },
        { tStartMs: 1000, segs: [{ utf8: "Repeat" }] },
        { tStartMs: 1500, segs: [{ utf8: "different" }] },
        { tStartMs: 2000, segs: [{ utf8: "different" }] },
      ],
    });
    expect(parseJSON3(json)).toBe("Repeat different");
  });

  it("ignores events with no segs and bad JSON", () => {
    expect(parseJSON3("not json")).toBe("");
    const json = JSON.stringify({
      events: [
        { tStartMs: 0 },
        { tStartMs: 100, segs: [] },
        { tStartMs: 200, segs: [{ utf8: "ok" }] },
      ],
    });
    expect(parseJSON3(json)).toBe("ok");
  });
});

describe("extractAltText", () => {
  it("strips the IG boilerplate prefix", () => {
    const post = {
      altText:
        "Photo by zachking on January 01, 2024. May be an image of: 2 people, sunset and beach.",
    };
    const { text, kind } = extractAltText(post);
    expect(kind).toBe("alt");
    expect(text).toBe("2 people, sunset and beach.");
  });

  it("returns empty when no altText present", () => {
    expect(extractAltText({}).text).toBe("");
    expect(extractAltText(null).text).toBe("");
  });

  it("leaves non-prefixed alt text mostly intact", () => {
    const post = { altText: "  A quiet  forest path  " };
    expect(extractAltText(post).text).toBe("A quiet forest path");
  });
});

describe("fetchFreeTranscript", () => {
  it("returns null when post has neither captionUrl nor altText", async () => {
    const fetchImpl = stubFetch("should not be called");
    const result = await fetchFreeTranscript({ id: "x" }, { fetchImpl });
    expect(result).toBeNull();
  });

  it("round-trips through stub fetchImpl for a TikTok WebVTT caption", async () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:00.000 --> 00:00:01.500",
      "First caption",
      "",
      "00:00:01.500 --> 00:00:03.000",
      "Second caption",
      "",
    ].join("\n");
    let calledUrl = null;
    const fetchImpl = async (url) => {
      calledUrl = url;
      return { ok: true, status: 200, async text() { return vtt; } };
    };
    const result = await fetchFreeTranscript(
      { captionUrl: "https://example.tiktokcdn.com/sub.vtt", captionFormat: "vtt" },
      { fetchImpl },
    );
    expect(calledUrl).toBe("https://example.tiktokcdn.com/sub.vtt");
    expect(result).toEqual({
      text: "First caption Second caption",
      kind: "subtitle",
      source: "tiktok-vtt",
    });
  });

  it("parses JSON3 captionFormat through stub fetchImpl", async () => {
    const json = JSON.stringify({
      events: [
        { tStartMs: 0, segs: [{ utf8: "alpha" }, { utf8: "beta" }] },
        { tStartMs: 1000, segs: [{ utf8: "gamma" }] },
      ],
    });
    const fetchImpl = stubFetch(json);
    const result = await fetchFreeTranscript(
      { captionUrl: "https://x/cap.json3", captionFormat: "json3" },
      { fetchImpl },
    );
    expect(result).toEqual({
      text: "alpha beta gamma",
      kind: "subtitle",
      source: "tiktok-vtt",
    });
  });

  it("falls back to IG alt text when no captionUrl", async () => {
    const post = {
      altText: "Photo by zachking. May be an image of: a dog.",
    };
    const result = await fetchFreeTranscript(post, { fetchImpl: stubFetch("") });
    expect(result).toEqual({
      text: "a dog.",
      kind: "alt",
      source: "ig-alt",
    });
  });

  it("returns null when fetchImpl throws", async () => {
    const fetchImpl = async () => {
      throw new Error("network down");
    };
    const result = await fetchFreeTranscript(
      { captionUrl: "https://x/cap.vtt" },
      { fetchImpl },
    );
    expect(result).toBeNull();
  });

  it("returns null when fetch response is !ok", async () => {
    const fetchImpl = stubFetch("nope", { ok: false, status: 404 });
    const result = await fetchFreeTranscript(
      { captionUrl: "https://x/cap.vtt" },
      { fetchImpl },
    );
    expect(result).toBeNull();
  });
});
