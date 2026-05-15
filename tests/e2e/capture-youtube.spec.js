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

test("capture: startCollect on /shorts/<id> advances the snap player and ingests new rows", async () => {
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
  // #navigation-button-down repeatedly; each click triggers a fresh /player
  // fetch with a new videoId, which the YT branch ingests as a new row.
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

  // And that should have produced at least one new yt_ row beyond the initial.
  const finalPosts = await page.evaluate(() => window.fs.posts());
  expect(finalPosts.length).toBeGreaterThan(initialPosts.length);
  expect(finalPosts.every((p) => String(p.id).startsWith("yt_"))).toBe(true);

  // Stop cleanly so afterAll() can shut down without a hung loop.
  await page.evaluate(() => window.fs.stop());
  await page.close();
});
