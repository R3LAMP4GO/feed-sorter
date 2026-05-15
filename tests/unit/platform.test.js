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
const loadRuntime = ({ host = "www.instagram.com", pathname = "/" } = {}) => {
  const sandbox = { window: {}, console };
  sandbox.window.location = { host, pathname };
  // YT runtimes need to register their `globalThis` namespaces before
  // platform-runtime.js binds to them.
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);
  for (const f of [
    "src/lib/scope-youtube-runtime.js",
    "src/lib/parser-youtube-runtime.js",
    "src/lib/platform-runtime.js",
  ]) {
    vm.runInContext(readFileSync(join(REPO_ROOT, f), "utf8"), sandbox);
  }
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
  it("maps youtube hosts", () => {
    expect(detectPlatform("www.youtube.com")).toBe(PLATFORMS.YOUTUBE);
    expect(detectPlatform("m.youtube.com")).toBe(PLATFORMS.YOUTUBE);
    expect(detectPlatform("youtube.com")).toBe(PLATFORMS.YOUTUBE);
  });
  it("returns null for other hosts", () => {
    expect(detectPlatform("facebook.com")).toBe(null);
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

  it("returns the YT bundle", () => {
    const c = getConfig(PLATFORMS.YOUTUBE);
    expect(c.platform).toBe("youtube");
    expect(c.postIdPrefix).toBe("yt_");
    expect(c.csvPrefix).toBe("yt");
    expect(c.downloadFolder).toBe("feed-sorter-yt");
    expect(typeof c.parser.playerToPost).toBe("function");
    expect(typeof c.scope.deriveScope).toBe("function");
    expect(typeof c.collectStrategy).toBe("function");
    expect(c.profileUrl("fitwithmaya")).toBe("https://www.youtube.com/@fitwithmaya");
    expect(c.postUrl({ nativeId: "abc123XYZ_-" })).toBe(
      "https://www.youtube.com/shorts/abc123XYZ_-"
    );
  });

  it("YT collectStrategy is snap on shorts-feed, scroll elsewhere", () => {
    const c = getConfig(PLATFORMS.YOUTUBE);
    expect(c.collectStrategy({ kind: "shorts-feed", username: null }).kind).toBe("snap");
    expect(c.collectStrategy({ kind: "profile", username: "x" }).kind).toBe("scroll");
    expect(c.collectStrategy({ kind: "other", username: null }).kind).toBe("scroll");
  });

  it("IG + TT collectStrategy is always scroll", () => {
    expect(getConfig(PLATFORMS.INSTAGRAM).collectStrategy({ kind: "profile" }).kind).toBe("scroll");
    expect(getConfig(PLATFORMS.TIKTOK).collectStrategy({ kind: "profile" }).kind).toBe("scroll");
  });

  it("returns null for unknown", () => {
    expect(getConfig("nope")).toBe(null);
  });
});

describe("platform-runtime IIFE detects YouTube hosts", () => {
  it("www.youtube.com → YOUTUBE active platform", () => {
    const rt = loadRuntime({ host: "www.youtube.com", pathname: "/shorts/abc123XYZ_-" });
    expect(rt.activePlatform).toBe("youtube");
    const cfg = rt.getActiveConfig();
    expect(cfg.platform).toBe("youtube");
    expect(cfg.postIdPrefix).toBe("yt_");
    expect(typeof cfg.collectStrategy).toBe("function");
  });

  it("m.youtube.com → YOUTUBE", () => {
    const rt = loadRuntime({ host: "m.youtube.com", pathname: "/" });
    expect(rt.activePlatform).toBe("youtube");
  });

  it("localhost stub with /shorts/<id> path falls back to YOUTUBE", () => {
    const rt = loadRuntime({ host: "127.0.0.1", pathname: "/shorts/abc123XYZ_-" });
    expect(rt.activePlatform).toBe("youtube");
  });

  it("YT scope is wired through to scope-youtube-runtime", () => {
    const rt = loadRuntime({ host: "www.youtube.com", pathname: "/" });
    const cfg = rt.getConfig(rt.PLATFORMS.YOUTUBE);
    expect(cfg.scope.deriveScope("/shorts/abc123XYZ_-")).toMatchObject({
      kind: "shorts-feed",
      videoId: "abc123XYZ_-",
    });
    expect(cfg.scope.deriveScope("/@fitwithmaya/shorts")).toMatchObject({
      kind: "profile",
      username: "fitwithmaya",
    });
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

describe("platform-runtime IG durationSec", () => {
  const mkMedia = (over = {}) => ({
    pk: "d1",
    code: "R-d1",
    media_type: 2,
    product_type: "clips",
    like_count: 1,
    play_count: 1,
    user: { username: "creator" },
    caption: { text: "hi" },
    ...over,
  });

  it("populates from m.video_duration (seconds, float)", () => {
    const rt = loadRuntime();
    const cfg = rt.getConfig(rt.PLATFORMS.INSTAGRAM);
    const out = cfg.parser.harvest({ items: [{ media: mkMedia({ video_duration: 42.7 }) }] }, "reels");
    expect(out[0].durationSec).toBe(42.7);
  });

  it("falls back to clips_metadata.original_sound_info.duration_in_ms", () => {
    const rt = loadRuntime();
    const cfg = rt.getConfig(rt.PLATFORMS.INSTAGRAM);
    const out = cfg.parser.harvest({
      items: [{ media: mkMedia({
        clips_metadata: { original_sound_info: { audio_asset_id: "a1", duration_in_ms: 38500 } },
      }) }],
    }, "reels");
    expect(out[0].durationSec).toBe(38.5);
  });

  it("falls back to clips_metadata.audio_metadata.duration_in_ms", () => {
    const rt = loadRuntime();
    const cfg = rt.getConfig(rt.PLATFORMS.INSTAGRAM);
    const out = cfg.parser.harvest({
      items: [{ media: mkMedia({
        clips_metadata: { audio_metadata: { duration_in_ms: 12000 } },
      }) }],
    }, "reels");
    expect(out[0].durationSec).toBe(12);
  });

  it("is null when no duration signal is available", () => {
    const rt = loadRuntime();
    const cfg = rt.getConfig(rt.PLATFORMS.INSTAGRAM);
    const out = cfg.parser.harvest({ items: [{ media: mkMedia() }] }, "reels");
    expect(out[0].durationSec).toBeNull();
  });
});

describe("configForHost", () => {
  it("dispatches IG", () => {
    expect(configForHost("www.instagram.com").platform).toBe("instagram");
  });
  it("dispatches TT", () => {
    expect(configForHost("www.tiktok.com").platform).toBe("tiktok");
  });
  it("dispatches YT", () => {
    expect(configForHost("www.youtube.com").platform).toBe("youtube");
  });
  it("returns null otherwise", () => {
    expect(configForHost("example.com")).toBe(null);
  });
});
