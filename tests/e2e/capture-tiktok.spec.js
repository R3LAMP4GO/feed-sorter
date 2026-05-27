import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-tiktok-server.mjs";
import { launchWithExtension } from "./helpers.js";

let server;
let ext;
let sw;

test.beforeAll(async () => {
  server = await startStubServer();
  ext = await launchWithExtension({ stubOrigin: server.origin });
  const existing = ext.context.serviceWorkers();
  sw = existing[0] || (await ext.context.waitForEvent("serviceworker"));
});

const setTier = (tier) =>
  sw.evaluate(
    (value) =>
      new Promise((resolve) =>
        chrome.storage.local.set({ "fs.api.tier": value }, () => resolve(true)),
      ),
    tier,
  );

const resetOriginSession = async (page) => {
  await page.goto(`${server.origin}/__fs-reset`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => sessionStorage.clear());
};

test.afterAll(async () => {
  if (ext) await ext.close();
  if (server) await server.stop();
});

test("capture: tiktok profile fixture populates window.fs.posts() with tt_-prefixed ids", async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/@khaby.lame`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  // tiktok-profile.json has 2 items.
  await expect
    .poll(
      async () => {
        const posts = await page.evaluate(() => window.fs.posts());
        return posts.length;
      },
      { timeout: 8_000, intervals: [200, 400, 800] }
    )
    .toBeGreaterThanOrEqual(2);

  const posts = await page.evaluate(() => window.fs.posts());
  expect(posts.every((p) => p.author === "khaby.lame")).toBe(true);
  expect(posts.every((p) => p.platform === "tiktok")).toBe(true);
  expect(posts.every((p) => String(p.id).startsWith("tt_"))).toBe(true);

  // ---- Log assertions for the new platform-aware breadcrumbs ----
  // The structured log buffer (window.fs.logs) should contain the boot +
  // capture entries with platform="tiktok" stamped on each.
  const fsLogs = await page.evaluate(() => window.fs.logs());
  const boot = fsLogs.find((e) => e.event === "boot");
  expect(boot).toBeTruthy();
  expect(boot.platform).toBe("tiktok");
  expect(boot.idPrefix).toBe("tt_");
  expect(boot.downloadFolder).toBe("feed-sorter-tt");
  const capture = fsLogs.find((e) => e.event === "capture");
  expect(capture).toBeTruthy();
  expect(capture.platform).toBe("tiktok");
  expect(capture.surface).toBe("profile");
  expect(capture.added).toBeGreaterThan(0);

  await page.close();
});

test("capture: tiktok video permalink only keeps the current video", async () => {
  const page = await ext.context.newPage();
  const currentId = "7301000000000000002";
  await page.goto(`${server.origin}/@khaby.lame/video/${currentId}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  await expect
    .poll(
      async () => page.evaluate(() => window.fs.posts().then((posts) => posts.length)),
      { timeout: 8_000, intervals: [200, 400, 800] }
    )
    .toBe(1);

  const posts = await page.evaluate(() => window.fs.posts());
  expect(posts).toHaveLength(1);
  expect(posts[0].nativeId).toBe(currentId);
  expect(posts[0].author).toBe("khaby.lame");
  expect(posts[0].platform).toBe("tiktok");

  await page.close();
});

test("gate: tiktok For You root shows upgrade card on free tier", async () => {
  await setTier("free");
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/?platform=tiktok`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  await expect(page.locator(".fs-upgrade-card-title")).toContainText("Explore-page research is a Pro feature");

  await page.close();
});

test("collect all: tiktok For You root auto-advances and captures subsequent pages", async () => {
  await setTier("pro");
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/?platform=tiktok`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  await expect
    .poll(
      async () => page.evaluate(() => window.fs.posts().then((posts) => posts.length)),
      { timeout: 8_000, intervals: [200, 400, 800] }
    )
    .toBeGreaterThanOrEqual(2);

  await page.evaluate(() => window.fs.collect());

  await expect
    .poll(
      async () => page.evaluate(() => window.__forYouFetches || 0),
      { timeout: 8_000, intervals: [200, 400, 800] }
    )
    .toBeGreaterThanOrEqual(2);

  await expect
    .poll(
      async () => page.evaluate(() => window.fs.posts().then((posts) => posts.length)),
      { timeout: 8_000, intervals: [200, 400, 800] }
    )
    .toBeGreaterThanOrEqual(4);

  const logs = await page.evaluate(() => window.fs.logs());
  const start = logs.find((e) => e.event === "collect.start");
  expect(start).toBeTruthy();
  expect(start.platform).toBe("tiktok");
  expect(start.strategy).toBe("snap");
  expect(logs.some((e) => e.event === "capture" && e.surface === "foryou")).toBe(true);

  await page.close();
});

test("collect limit: tiktok For You stops at preset 25 after collecting across pages", async () => {
  await setTier("pro");
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/?platform=tiktok&pages=20`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  await expect
    .poll(
      async () => page.evaluate(() => window.fs.posts().then((posts) => posts.length)),
      { timeout: 8_000, intervals: [200, 400, 800] }
    )
    .toBeGreaterThanOrEqual(2);

  await page.evaluate(() => window.fs.setFilter("limit", 25));
  await page.evaluate(() => window.fs.collect());

  await expect
    .poll(
      async () => page.evaluate(() => window.fs.logs().find((e) => e.event === "collect.end")?.reason || ""),
      { timeout: 25_000, intervals: [500, 1_000] }
    )
    .toBe("limit-reached");

  const posts = await page.evaluate(() => window.fs.posts());
  const logs = await page.evaluate(() => window.fs.logs());
  const end = logs.find((e) => e.event === "collect.end");
  expect(posts.length).toBeGreaterThanOrEqual(25);
  expect(posts.length).toBeLessThan(40);
  expect(end.inScope).toBeGreaterThanOrEqual(25);
  expect(await page.evaluate(() => window.__forYouFetches || 0)).toBeGreaterThanOrEqual(13);

  await page.close();
});

test("collect limit: tiktok For You honors a custom 7 item limit", async () => {
  await setTier("pro");
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/?platform=tiktok&pages=10`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  await expect
    .poll(
      async () => page.evaluate(() => window.fs.posts().then((posts) => posts.length)),
      { timeout: 8_000, intervals: [200, 400, 800] }
    )
    .toBeGreaterThanOrEqual(2);

  await page.evaluate(() => window.fs.setFilter("limit", 7));
  await page.evaluate(() => window.fs.collect());

  await expect
    .poll(
      async () => page.evaluate(() => window.fs.logs().find((e) => e.event === "collect.end")?.reason || ""),
      { timeout: 15_000, intervals: [500, 1_000] }
    )
    .toBe("limit-reached");

  const logs = await page.evaluate(() => window.fs.logs());
  const end = logs.find((e) => e.event === "collect.end");
  expect(end.inScope).toBeGreaterThanOrEqual(7);
  expect(await page.evaluate(() => window.__forYouFetches || 0)).toBeGreaterThanOrEqual(4);

  await page.close();
});

test("collect all: tiktok Explore auto-advances and captures subsequent pages", async () => {
  await setTier("pro");
  const page = await ext.context.newPage();
  await resetOriginSession(page);
  await page.goto(`${server.origin}/explore?platform=tiktok`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  await expect
    .poll(
      async () => page.evaluate(() => window.fs.posts().then((posts) => posts.length)),
      { timeout: 8_000, intervals: [200, 400, 800] }
    )
    .toBeGreaterThanOrEqual(2);

  await page.evaluate(() => window.fs.setFilter("limit", 4));
  await page.evaluate(() => window.fs.collect());

  await expect
    .poll(
      async () => page.evaluate(() => window.__exploreFetches || 0),
      { timeout: 8_000, intervals: [200, 400, 800] }
    )
    .toBeGreaterThanOrEqual(2);

  await expect
    .poll(
      async () => page.evaluate(() => window.fs.posts().then((posts) => posts.length)),
      { timeout: 8_000, intervals: [200, 400, 800] }
    )
    .toBeGreaterThanOrEqual(4);

  const logs = await page.evaluate(() => window.fs.logs());
  expect(logs.find((e) => e.event === "collect.start")?.strategy).toBe("snap");
  expect(logs.some((e) => e.event === "capture" && e.surface === "explore")).toBe(true);

  await page.close();
});

test("collect all: tiktok Explore refreshes and resumes after its feed bottoms out", async () => {
  await setTier("pro");
  const page = await ext.context.newPage();
  await resetOriginSession(page);
  await page.goto(`${server.origin}/explore?platform=tiktok&pages=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  await expect
    .poll(
      async () => page.evaluate(() => window.fs.posts().then((posts) => posts.length)),
      { timeout: 8_000, intervals: [200, 400, 800] }
    )
    .toBeGreaterThanOrEqual(2);

  await page.evaluate(() => window.fs.setFilter("limit", 4));
  await page.evaluate(() => window.fs.collect());

  await expect
    .poll(
      async () => page.evaluate(() => window.__exploreBatch || 0),
      { timeout: 20_000, intervals: [500, 1_000] }
    )
    .toBeGreaterThanOrEqual(1);

  await expect
    .poll(
      async () => page.evaluate(() => window.fs.posts().then((posts) => posts.length)),
      { timeout: 20_000, intervals: [500, 1_000] }
    )
    .toBeGreaterThanOrEqual(4);

  await expect
    .poll(
      async () => page.evaluate(() => window.fs.logs().find((e) => e.event === "collect.end" && e.reason === "limit-reached")?.reason || ""),
      { timeout: 12_000, intervals: [500, 1_000] }
    )
    .toBe("limit-reached");

  const logs = await page.evaluate(() => window.fs.logs());
  expect(logs.some((e) => e.event === "collect.resume" && e.platform === "tiktok")).toBe(true);

  await page.close();
});
