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

test("boot: page-world API exists, overlay rendered, scope=profile", async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/zachking/`, { waitUntil: "domcontentloaded" });

  // The injected page-world API (window.fs) signals the extension is alive.
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  // Overlay div present (DOM is shared between isolated/page worlds).
  await expect(page.locator(".fs-root")).toBeVisible();

  // Scope is reflected in the overlay's CSS class.
  const cls = await page.locator(".fs-root").getAttribute("class");
  expect(cls).toMatch(/fs-scope-profile/);

  // Title contains the username.
  const title = await page.locator(".fs-root [data-title]").textContent();
  expect(title).toContain("zachking");

  await page.close();
});
