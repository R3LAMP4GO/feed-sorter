import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-tiktok-server.mjs";
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
