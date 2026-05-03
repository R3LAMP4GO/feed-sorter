// Verifies that sort=outlier ranks the row with the highest _score on top.
// Fixtures (zachking) have like_counts [1234, 5678, 5000, 12000]. With
// metric=likes the per-author median is (5000+5678)/2 = 5339 → the row
// with likes=12000 (id 4002_1) must end up first.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-ig-server.mjs";
import { launchWithExtension } from "./helpers.js";

let server, ext;

test.beforeAll(async () => {
  server = await startStubServer();
  ext = await launchWithExtension({ host: server.origin });
});

test.afterAll(async () => {
  if (ext) await ext.close();
  if (server) await server.stop();
});

test("outlier: top row matches the highest-_score post", async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/zachking/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  await expect
    .poll(async () => (await page.evaluate(() => window.fs.posts())).length, {
      timeout: 8_000,
    })
    .toBeGreaterThanOrEqual(4);

  // Force outlier sort with likes as the metric.
  await page.evaluate(() => {
    window.fs.setFilter("sort", "outlier");
    window.fs.setFilter("metric", "likes");
  });

  // Wait until rows render with the sort applied.
  await page.waitForFunction(
    () => document.querySelectorAll(".fs-root .fs-row").length >= 4,
    null,
    { timeout: 5_000 }
  );

  // Read each row's download button data-id + the rendered _score text.
  const rendered = await page.evaluate(() =>
    [...document.querySelectorAll(".fs-root .fs-row")].map((r) => ({
      id: r.querySelector(".fs-dl")?.getAttribute("data-id") || null,
      scoreText: (r.querySelector(".fs-score")?.textContent || "").trim(),
      score: parseFloat(
        (r.querySelector(".fs-score")?.textContent || "0").replace("x", "")
      ),
    }))
  );

  // Top row must be the highest score.
  const sortedDesc = [...rendered].sort((a, b) => b.score - a.score);
  expect(rendered[0].id).toBe(sortedDesc[0].id);

  // And specifically the fixture with likes=12000 (pk 4002) wins.
  // Post ids are namespaced as `ig_<pk>` since v0.2 (multi-platform).
  expect(rendered[0].id).toBe("ig_4002");

  // Score is rendered with the "x" suffix in outlier mode.
  expect(rendered[0].scoreText.endsWith("x")).toBe(true);

  await page.close();
});
