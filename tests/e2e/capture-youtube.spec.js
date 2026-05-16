import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-youtube-server.mjs";
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

test("capture: youtube channel /@handle/shorts grid populates posts with yt_-prefixed ids", async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/@fitwithmaya/shorts`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  // youtube-browse.json has 2 shorts items.
  await expect
    .poll(
      async () => (await page.evaluate(() => window.fs.posts())).length,
      { timeout: 8_000, intervals: [200, 400, 800] }
    )
    .toBeGreaterThanOrEqual(2);

  const posts = await page.evaluate(() => window.fs.posts());
  expect(posts.every((p) => String(p.id).startsWith("yt_"))).toBe(true);
  expect(posts.every((p) => p.platform === "youtube")).toBe(true);
  expect(posts.every((p) => p.surface === "shorts-feed")).toBe(true);

  const fsLogs = await page.evaluate(() => window.fs.logs());
  const boot = fsLogs.find((e) => e.event === "boot");
  expect(boot).toBeTruthy();
  expect(boot.platform).toBe("youtube");
  expect(boot.idPrefix).toBe("yt_");
  expect(boot.downloadFolder).toBe("feed-sorter-yt");
  const capture = fsLogs.find((e) => e.event === "capture" && e.platform === "youtube");
  expect(capture).toBeTruthy();
  expect(capture.added).toBeGreaterThan(0);

  await page.close();
});

test("capture: youtube shorts permalink only keeps the current short", async () => {
  const page = await ext.context.newPage();
  const currentId = "abc123XYZ_-";
  await page.goto(`${server.origin}/shorts/${currentId}?prefetch=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  await expect
    .poll(
      async () => (await page.evaluate(() => window.fs.posts())).length,
      { timeout: 8_000, intervals: [200, 400, 800] }
    )
    .toBe(1);

  await expect
    .poll(
      async () => {
        const [post] = await page.evaluate(() => window.fs.posts());
        return { likes: post?.likes || 0, comments: post?.comments || 0 };
      },
      { timeout: 8_000, intervals: [200, 400, 800] }
    )
    .toEqual({ likes: 344, comments: 10 });

  const posts = await page.evaluate(() => window.fs.posts());
  expect(posts[0].nativeId).toBe(currentId);
  expect(posts[0].platform).toBe("youtube");
  expect(posts[0].surface).toBe("shorts-feed");
  expect(posts[0].views).toBeGreaterThanOrEqual(13900);

  await expect(page.locator(".fs-row").first()).toContainText("short");
  await expect(page.locator(".fs-row").first()).not.toContainText("reel");

  await page.close();
});

test("capture: startCollect on /shorts/<id> accumulates shorts visited by collector", async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/shorts/abc123XYZ_-`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  // Wait for the initial /player + /next responses to land so the first row
  // is in window.fs.posts() before we start the collector.
  await expect
    .poll(
      async () => (await page.evaluate(() => window.fs.posts())).length,
      { timeout: 8_000, intervals: [200, 400, 800] }
    )
    .toBeGreaterThanOrEqual(1);

  const initialPosts = await page.evaluate(() => window.fs.posts());
  expect(initialPosts.every((p) => p.platform === "youtube")).toBe(true);
  expect(initialPosts.every((p) => p.surface === "shorts-feed")).toBe(true);

  // Kick off the collector. The snap strategy should click
  // #navigation-button-down repeatedly and accumulate videos after the visible
  // URL changes to each one.
  // Cap the run by setting a low limit via the page-world API.
  await page.evaluate(() => {
    window.fs.setFilter("limit", 4);
    window.fs.collect();
  });

  // The collector should advance the next-button at least a few times.
  await expect
    .poll(
      async () => page.evaluate(() => window.__nextClicks || 0),
      { timeout: 15_000, intervals: [400, 800, 1600] }
    )
    .toBeGreaterThanOrEqual(2);

  const finalPosts = await page.evaluate(() => window.fs.posts());
  expect(finalPosts.length).toBeGreaterThan(initialPosts.length);
  expect(finalPosts.every((p) => String(p.id).startsWith("yt_"))).toBe(true);
  expect(finalPosts.every((p) => p.platform === "youtube")).toBe(true);
  expect(new Set(finalPosts.map((p) => p.nativeId)).size).toBe(finalPosts.length);
  expect(finalPosts.some((p) => p.likes >= 345 && p.comments >= 11)).toBe(true);

  const rowText = await page.locator(".fs-row").first().textContent();
  expect(rowText).toContain("short");
  expect(rowText).not.toContain("reel");

  // Stop cleanly so afterAll() can shut down without a hung loop.
  await page.evaluate(() => window.fs.stop());
  await page.close();
});
