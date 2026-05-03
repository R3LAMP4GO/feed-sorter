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

test("csv: download filename matches new ig_{scope}_..._{stamp}.csv pattern", async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/zachking/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  // Wait for at least one post so the CSV row count is non-zero.
  await expect
    .poll(async () => (await page.evaluate(() => window.fs.posts())).length, {
      timeout: 8_000,
    })
    .toBeGreaterThanOrEqual(1);

  // Trigger CSV export via the overlay button and capture the download.
  const downloadPromise = page.waitForEvent("download", { timeout: 5_000 });
  await page.locator('[data-act="csv"]').click();
  const download = await downloadPromise;

  const name = download.suggestedFilename();
  // Expected pattern: ig_{scope}[_surface]_{sortPart}[_range]_{rows}_{YYYY-MM-DD_HHMM}.csv
  expect(name).toMatch(
    /^ig_zachking(?:_[a-z]+)?_[a-z-]+(?:_[a-z0-9]+)?_\d+_\d{4}-\d{2}-\d{2}_\d{4}\.csv$/
  );

  await page.close();
});
