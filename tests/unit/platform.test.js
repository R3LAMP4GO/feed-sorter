import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import {
  PLATFORMS,
  detectPlatform,
  getConfig,
  configForHost,
} from "../../src/lib/platform.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

// Load the IIFE platform-runtime in a sandbox so we can exercise the IG
// parser (richer than the ESM `parser.js` — includes audio/usertags/etc).
const loadRuntime = () => {
  const code = readFileSync(
    join(REPO_ROOT, "src", "lib", "platform-runtime.js"),
    "utf8"
  );
  const sandbox = { window: {}, console };
  sandbox.window.location = { host: "www.instagram.com", pathname: "/" };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.__fsPlatform;
};

describe("detectPlatform", () => {
  it("maps instagram hosts", () => {
    expect(detectPlatform("www.instagram.com")).toBe(PLATFORMS.INSTAGRAM);
    expect(detectPlatform("instagram.com")).toBe(PLATFORMS.INSTAGRAM);
    expect(detectPlatform("i.instagram.com")).toBe(PLATFORMS.INSTAGRAM);
  });
  it("maps tiktok hosts", () => {
    expect(detectPlatform("www.tiktok.com")).toBe(PLATFORMS.TIKTOK);
    expect(detectPlatform("tiktok.com")).toBe(PLATFORMS.TIKTOK);
    expect(detectPlatform("m.tiktok.com")).toBe(PLATFORMS.TIKTOK);
  });
  it("returns null for other hosts", () => {
    expect(detectPlatform("youtube.com")).toBe(null);
    expect(detectPlatform("")).toBe(null);
  });
});

describe("getConfig", () => {
  it("returns the IG bundle", () => {
    const c = getConfig(PLATFORMS.INSTAGRAM);
    expect(c.platform).toBe("instagram");
    expect(c.postIdPrefix).toBe("ig_");
    expect(c.csvPrefix).toBe("ig");
    expect(c.downloadFolder).toBe("feed-sorter-ig");
    expect(typeof c.parser.harvest).toBe("function");
    expect(typeof c.scope.deriveScope).toBe("function");
    expect(c.profileUrl("zachking")).toBe(
      "https://www.instagram.com/zachking/"
    );
    expect(
      c.postUrl({ shortcode: "abc", isReel: true })
    ).toBe("https://www.instagram.com/reel/abc/");
  });

  it("returns the TT bundle", () => {
    const c = getConfig(PLATFORMS.TIKTOK);
    expect(c.platform).toBe("tiktok");
    expect(c.postIdPrefix).toBe("tt_");
    expect(c.csvPrefix).toBe("tt");
    expect(c.downloadFolder).toBe("feed-sorter-tt");
    expect(typeof c.parser.harvest).toBe("function");
    expect(typeof c.scope.deriveScope).toBe("function");
    expect(c.profileUrl("khaby")).toBe("https://www.tiktok.com/@khaby");
    expect(
      c.postUrl({ author: "k", nativeId: "1234" })
    ).toBe("https://www.tiktok.com/@k/video/1234");
  });

  it("returns null for unknown", () => {
    expect(getConfig("nope")).toBe(null);
  });
});

describe("platform-runtime IG audio.downloadUrl", () => {
  it("populates from clips_metadata.original_sound_info.progressive_download_url", () => {
    const rt = loadRuntime();
    const cfg = rt.getConfig(rt.PLATFORMS.INSTAGRAM);
    const media = {
      pk: "9001",
      id: "9001_1",
      code: "Rabc999",
      media_type: 2,
      product_type: "clips",
      taken_at: 1700000000,
      like_count: 1,
      play_count: 1,
      user: { username: "zachking" },
      caption: { text: "hi" },
      clips_metadata: {
        original_sound_info: {
          audio_asset_id: "a1",
          original_audio_title: "my sound",
          ig_artist: { username: "zachking" },
          progressive_download_url: "https://cdn.example/audio/a1.m4a",
        },
      },
    };
    const out = cfg.parser.harvest({ items: [{ media }] }, "reels");
    expect(out).toHaveLength(1);
    expect(out[0].audio.downloadUrl).toBe("https://cdn.example/audio/a1.m4a");
  });
  it("defaults audio.downloadUrl to empty string when absent", () => {
    const rt = loadRuntime();
    const cfg = rt.getConfig(rt.PLATFORMS.INSTAGRAM);
    const media = {
      pk: "9002",
      code: "Rabc998",
      media_type: 2,
      product_type: "clips",
      like_count: 1,
      play_count: 1,
      user: { username: "zk" },
      clips_metadata: {
        music_info: { music_asset_info: { audio_cluster_id: "c1", title: "song" } },
      },
    };
    const out = cfg.parser.harvest({ items: [{ media }] }, "reels");
    expect(out[0].audio.downloadUrl).toBe("");
  });
});

describe("configForHost", () => {
  it("dispatches IG", () => {
    expect(configForHost("www.instagram.com").platform).toBe("instagram");
  });
  it("dispatches TT", () => {
    expect(configForHost("www.tiktok.com").platform).toBe("tiktok");
  });
  it("returns null otherwise", () => {
    expect(configForHost("example.com")).toBe(null);
  });
});
