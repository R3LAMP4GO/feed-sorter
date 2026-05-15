import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import {
  looksLikeMedia,
  cover,
  captionText,
  captionsOf,
  author,
  videoUrlOf,
  likesOf,
  commentsOf,
  viewsOf,
  sharesOf,
  savesOf,
  surfaceFromUrlTag,
  toPost,
  harvest,
} from "../../src/lib/parser-tiktok.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "fixtures");
const loadJson = (name) =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

describe("parser-tiktok looksLikeMedia", () => {
  it("matches a typical TT item", () => {
    expect(
      looksLikeMedia({
        id: "7301",
        desc: "x",
        createTime: 1,
        author: { uniqueId: "u" },
        stats: { playCount: 1 },
        video: { playAddr: "" },
      })
    ).toBe(true);
  });
  it("rejects objects without an id", () => {
    expect(looksLikeMedia({ desc: "x", stats: { playCount: 1 } })).toBe(false);
  });
  it("rejects null / non-object", () => {
    expect(looksLikeMedia(null)).toBe(false);
    expect(looksLikeMedia(42)).toBe(false);
  });
});

describe("parser-tiktok field accessors", () => {
  const item = {
    id: "1",
    desc: "hello",
    author: { uniqueId: "u" },
    video: { duration: 7, cover: "c.jpg", playAddr: "v.mp4" },
    music: { id: "m1", title: "t", authorName: "a", original: true },
    stats: {
      diggCount: 10,
      commentCount: 2,
      playCount: 1000,
      shareCount: 5,
      collectCount: 3,
    },
  };
  it("reads each stat", () => {
    expect(likesOf(item)).toBe(10);
    expect(commentsOf(item)).toBe(2);
    expect(viewsOf(item)).toBe(1000);
    expect(sharesOf(item)).toBe(5);
    expect(savesOf(item)).toBe(3);
  });
  it("cover/captionText/author/videoUrlOf", () => {
    expect(cover(item)).toBe("c.jpg");
    expect(captionText(item)).toBe("hello");
    expect(author(item)).toBe("u");
    expect(videoUrlOf(item)).toBe("v.mp4");
  });
});

describe("parser-tiktok surfaceFromUrlTag", () => {
  it("classifies by tag", () => {
    expect(surfaceFromUrlTag("", "tt-profile")).toBe("profile");
    expect(surfaceFromUrlTag("", "tt-foryou")).toBe("foryou");
    expect(surfaceFromUrlTag("", "tt-explore")).toBe("explore");
    expect(surfaceFromUrlTag("", "tt-related")).toBe("related");
  });
  it("classifies by URL", () => {
    expect(surfaceFromUrlTag("/api/post/item_list/?x=1", "")).toBe("profile");
    expect(surfaceFromUrlTag("/api/recommend/item_list/", "")).toBe("foryou");
    expect(surfaceFromUrlTag("/api/explore/item_list/", "")).toBe("explore");
    expect(surfaceFromUrlTag("/api/related/item_list/", "")).toBe("related");
  });
  it("returns 'unknown' otherwise", () => {
    expect(surfaceFromUrlTag("/foo", "")).toBe("unknown");
  });
});

describe("parser-tiktok toPost", () => {
  it("prefixes id with tt_ and uses shareUrl when present", () => {
    const m = {
      id: "7301",
      desc: "yo",
      author: { uniqueId: "khaby" },
      video: { duration: 10, cover: "c", playAddr: "v" },
      stats: { diggCount: 1, commentCount: 1, playCount: 1 },
      shareUrl: "https://www.tiktok.com/@khaby/video/7301",
    };
    const p = toPost(m, "profile");
    expect(p.id).toBe("tt_7301");
    expect(p.nativeId).toBe("7301");
    expect(p.author).toBe("khaby");
    expect(p.url).toBe("https://www.tiktok.com/@khaby/video/7301");
    expect(p.platform).toBe("tiktok");
    expect(p.isReel).toBe(true);
  });
  it("falls back to building canonical URL when shareUrl missing", () => {
    const m = {
      id: "9",
      desc: "",
      author: { uniqueId: "alice" },
      video: { duration: 5, cover: "c", playAddr: "v" },
      stats: { playCount: 1 },
    };
    const p = toPost(m, "profile");
    expect(p.url).toBe("https://www.tiktok.com/@alice/video/9");
  });
  it("infers author from pageScope when missing", () => {
    const m = {
      id: "5",
      desc: "",
      author: {},
      video: { playAddr: "v" },
      stats: { playCount: 1 },
    };
    const p = toPost(m, "profile", { kind: "profile", username: "bob" });
    expect(p.author).toBe("bob");
    expect(p.url).toBe("https://www.tiktok.com/@bob/video/5");
  });
});

describe("parser-tiktok captions (subtitleInfos)", () => {
  const baseItem = (subtitleInfos) => ({
    id: "123",
    desc: "",
    author: { uniqueId: "u" },
    video: { duration: 5, cover: "c", playAddr: "v", ...(subtitleInfos ? { subtitleInfos } : {}) },
    stats: { playCount: 1 },
  });

  it("picks the English track when multiple languages are present", () => {
    const subs = [
      { LanguageCodeName: "ita-IT", Url: "u-ita", Format: "WEBVTT", Source: "ASR" },
      { LanguageCodeName: "eng-US", Url: "u-eng", Format: "WEBVTT", Source: "ASR" },
      { LanguageCodeName: "spa-ES", Url: "u-spa", Format: "WEBVTT", Source: "MT" },
    ];
    const caps = captionsOf(baseItem(subs));
    expect(caps.captionUrl).toBe("u-eng");
    expect(caps.captionLang).toBe("eng-US");
    expect(caps.captionFormat).toBe("webvtt");
    expect(caps.captionSource).toBe("ASR");

    const p = toPost(baseItem(subs), "profile");
    expect(p.captionUrl).toBe("u-eng");
    expect(p.captionLang).toBe("eng-US");
    expect(p.captionFormat).toBe("webvtt");
    expect(p.captionSource).toBe("ASR");
  });

  it("falls back to the first track when no English is available", () => {
    const subs = [
      { LanguageCodeName: "fra-FR", Url: "u-fra", Format: "webvtt", Source: "MT" },
      { LanguageCodeName: "deu-DE", Url: "u-deu", Format: "webvtt", Source: "MT" },
    ];
    const p = toPost(baseItem(subs), "profile");
    expect(p.captionUrl).toBe("u-fra");
    expect(p.captionLang).toBe("fra-FR");
    expect(p.captionFormat).toBe("webvtt");
    expect(p.captionSource).toBe("MT");
  });

  it("returns empty strings when subtitleInfos is absent or empty", () => {
    const p1 = toPost(baseItem(undefined), "profile");
    expect(p1.captionUrl).toBe("");
    expect(p1.captionFormat).toBe("");
    expect(p1.captionSource).toBe("");
    expect(p1.captionLang).toBe("");
    const p2 = toPost(baseItem([]), "profile");
    expect(p2.captionUrl).toBe("");
    expect(p2.captionFormat).toBe("");
    expect(p2.captionSource).toBe("");
    expect(p2.captionLang).toBe("");
  });

  it("round-trips through the platform-runtime IIFE mirror", () => {
    const code = readFileSync(
      join(__dirname, "..", "..", "src", "lib", "platform-runtime.js"),
      "utf8"
    );
    const sandbox = { window: {}, console };
    sandbox.window.location = { host: "www.tiktok.com", pathname: "/" };
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    const rt = sandbox.window.__fsPlatform;
    const cfg = rt.getConfig(rt.PLATFORMS.TIKTOK);

    const root = loadJson("tiktok-with-subtitles.json");
    const out = cfg.parser.harvest(root, "profile");
    expect(out).toHaveLength(1);
    const p = out[0];
    expect(p.captionLang).toBe("eng-US");
    expect(p.captionFormat).toBe("webvtt");
    expect(p.captionSource).toBe("ASR");
    expect(p.captionUrl).toContain("sig=ENG");

    // ESM parser must agree.
    const esm = harvest(root, "profile");
    expect(esm[0].captionUrl).toBe(p.captionUrl);
    expect(esm[0].captionLang).toBe(p.captionLang);
    expect(esm[0].captionFormat).toBe(p.captionFormat);
    expect(esm[0].captionSource).toBe(p.captionSource);
  });
});

describe("parser-tiktok harvest (fixtures)", () => {
  it("extracts both items from the profile fixture", () => {
    const root = loadJson("tiktok-profile.json");
    const out = harvest(root, "profile");
    expect(out).toHaveLength(2);
    expect(new Set(out.map((p) => p.id))).toEqual(
      new Set(["tt_7301000000000000001", "tt_7301000000000000002"])
    );
    expect(out.every((p) => p.author === "khaby.lame")).toBe(true);
    expect(out.every((p) => p.platform === "tiktok")).toBe(true);
    expect(out[0].views).toBeGreaterThan(0);
    const byId = Object.fromEntries(out.map((p) => [p.id, p]));
    // First fixture item carries music.playUrl → audio.downloadUrl populated.
    expect(byId["tt_7301000000000000001"].audio.downloadUrl).toBe(
      "https://sf16.tiktokcdn.example/m1.mp3"
    );
    // Second has no playUrl → empty string (never undefined).
    expect(byId["tt_7301000000000000002"].audio.downloadUrl).toBe("");
  });

  it("extracts both items from the foryou fixture with distinct authors", () => {
    const root = loadJson("tiktok-foryou.json");
    const out = harvest(root, "foryou");
    expect(out).toHaveLength(2);
    expect(new Set(out.map((p) => p.author))).toEqual(
      new Set(["creator_a", "creator_b"])
    );
    expect(out.every((p) => p.id.startsWith("tt_"))).toBe(true);
  });
});
