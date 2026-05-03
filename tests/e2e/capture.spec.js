import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-server.mjs";
import { launchWithExtension } from "./helpers.js";

let server, ext;

test.beforeAll(async () => {
  server = await startStubServer();
  ext = await launchWithExtension({ stubOrigin: server.origin });
});

test.afterAll(async () => {
  if (ext) await ext.close();
  if (server) await server.stop();
});

test("capture: feed + clips fixtures populate window.fs.posts()", async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/zachking/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  // The stub page fires /api/v1/feed/user/ + /api/v1/clips/user/ on a 500ms delay,
  // after the content script has booted. The injected XHR/fetch hook forwards
  // those responses to the content script for harvesting.
  // feed-user.json has 2 items + clips-user.json has 2 items = 4 unique posts.
  await expect
    .poll(
      async () => {
        const posts = await page.evaluate(() => window.fs.posts());
        return posts.length;
      },
      { timeout: 8_000, intervals: [200, 400, 800] }
    )
    .toBeGreaterThanOrEqual(4);

  const posts = await page.evaluate(() => window.fs.posts());
  // All should be attributed to zachking (either explicitly or via pageScope fallback).
  expect(posts.every((p) => p.author === "zachking")).toBe(true);
  // v0.2: post ids are namespaced as `ig_<pk>` so multi-platform IDB
  // (IG + TT) doesn't collide.
  expect(posts.every((p) => String(p.id).startsWith("ig_"))).toBe(true);

  // ---- Log assertions for the platform-aware breadcrumbs ----
  // The structured log buffer (window.fs.logs) is the authoritative
  // log surface; the console.log breadcrumbs are best-effort visual.
  const fsLogs = await page.evaluate(() => window.fs.logs());
  const boot = fsLogs.find((e) => e.event === "boot");
  expect(boot).toBeTruthy();
  expect(boot.platform).toBe("instagram");
  expect(boot.idPrefix).toBe("ig_");
  expect(boot.downloadFolder).toBe("feed-sorter-ig");
  const captures = fsLogs.filter((e) => e.event === "capture");
  expect(captures.length).toBeGreaterThan(0);
  expect(captures.every((c) => c.platform === "instagram")).toBe(true);
  // We loaded /api/v1/feed/user (profile) AND /api/v1/clips/user (reels);
  // both surfaces should have logged a capture.
  const surfaces = new Set(captures.map((c) => c.surface));
  expect(surfaces.has("profile")).toBe(true);
  expect(surfaces.has("reels")).toBe(true);

  await page.close();
});
