// Navigate /profile/a → /profile/b and verify scope detection updates,
// the overlay header reflects the new username, and the in-memory post
// set is filtered to the active scope. (IDB rehydration of A's posts
// when revisiting A is covered by rehydrate.spec.js.)
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

test("scope-change: navigating profile A → profile B updates scope", async () => {
  const page = await ext.context.newPage();

  // Profile A.
  await page.goto(`${server.origin}/zachking/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  await expect
    .poll(async () => (await page.evaluate(() => window.fs.posts())).length, {
      timeout: 8_000,
    })
    .toBeGreaterThanOrEqual(4);

  let cls = await page.locator(".fs-root").getAttribute("class");
  expect(cls).toMatch(/fs-scope-profile/);
  let title = await page.locator(".fs-root [data-title]").textContent();
  expect(title).toContain("zachking");

  // All current posts are zachking.
  let posts = await page.evaluate(() => window.fs.posts());
  expect(posts.every((p) => p.author === "zachking")).toBe(true);

  // Navigate to Profile B.
  await page.goto(`${server.origin}/nasa/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  // Header should now show @nasa.
  await expect
    .poll(
      async () =>
        (await page.locator(".fs-root [data-title]").textContent()) || "",
      { timeout: 5_000 }
    )
    .toContain("nasa");

  cls = await page.locator(".fs-root").getAttribute("class");
  expect(cls).toMatch(/fs-scope-profile/);

  // After scope change the in-memory posts must not contain any zachking
  // post — either empty (cleared on scope change before fetch) or filled
  // with nasa-attributed posts (since the stub serves the same fixtures
  // for any /api/v1/feed/user/<x>/, the `pageScope` filter rewrites
  // missing/foreign authors via the documented profile fallback).
  // Wait for the page to settle past the fixture's 500ms fetch delay.
  await page.waitForTimeout(900);
  posts = await page.evaluate(() => window.fs.posts());
  expect(posts.every((p) => p.author !== "zachking")).toBe(true);

  // Navigate to home (other scope) — overlay should mark scope=other.
  await page.goto(`${server.origin}/`, { waitUntil: "domcontentloaded" }).catch(() => {});
  // Home isn't served by the stub; the in-page overlay still re-derives
  // scope on the next pushState. To keep the test deterministic, drive a
  // history pushState directly to "/" inside the existing page world.
  await page.evaluate(() => history.pushState({}, "", "/"));
  await page.waitForTimeout(300);
  cls = await page.locator(".fs-root").getAttribute("class");
  expect(cls).toMatch(/fs-scope-other/);

  await page.close();
});
