// Click the per-row ⬇ button, intercept the resulting blob download,
// and assert filename matches `{author}-{shortcode}.mp4`.
//
// The fixture's videoUrl points at https://cdn.example/<file>.mp4 which
// won't resolve naturally — we use page.route() to fulfil it with a
// small fake mp4 byte stream.
import { test, expect } from "@playwright/test";
import { startStubServer } from "./stub-ig-server.mjs";
import { launchWithExtension } from "./helpers.js";

let server;
let ext;

test.beforeAll(async () => {
  server = await startStubServer();
  ext = await launchWithExtension({ host: server.origin });
});

test.afterAll(async () => {
  if (ext) await ext.close();
  if (server) await server.stop();
});

test("download: ⬇ produces blob download named {author}-{shortcode}.mp4", async () => {
  const page = await ext.context.newPage();

  // Fake video bytes for any cdn.example mp4 the content script tries to fetch.
  await page.route("**/cdn.example/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "video/mp4",
      body: Buffer.from("\x00\x00\x00\x18ftypmp42fakebytes-for-test-only"),
    })
  );

  await page.goto(`${server.origin}/zachking/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  // Wait for the reels rows that have a videoUrl.
  await page.evaluate(() => window.fs.setFilter("surface", "reels"));
  await page.waitForFunction(
    () => document.querySelectorAll(".fs-root .fs-row .fs-dl:not([disabled])").length >= 1,
    null,
    { timeout: 8_000 }
  );

  // Read the row id we're about to click so we can predict the filename.
  const target = await page.evaluate(() => {
    const btn = document.querySelector(".fs-root .fs-row .fs-dl:not([disabled])");
    return btn ? { id: btn.getAttribute("data-id") } : null;
  });
  expect(target).toBeTruthy();

  const expected = await page.evaluate(async (id) => {
    const posts = await window.fs.posts();
    const p = posts.find((x) => x.id === id);
    return p ? `${p.author || "ig"}-${p.shortcode || p.id}.mp4` : null;
  }, target.id);
  expect(expected).toBeTruthy();

  // Click the button and intercept the resulting download.
  const downloadPromise = page.waitForEvent("download", { timeout: 8_000 });
  await page.click(".fs-root .fs-row .fs-dl:not([disabled])");
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe(expected);

  // Sanity-check: the saved file is non-empty.
  const path = await download.path();
  expect(path).toBeTruthy();

  await page.close();
});
