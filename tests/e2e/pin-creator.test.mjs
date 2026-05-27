// Verifies the header pin-creator button:
//   - visible only on profile pages (hidden on /explore)
//   - first click adds the current creator to the watchlist
//   - second click removes them again
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

const getCreators = (page) =>
  page.evaluate(async () => {
    if (!window.__fsStore || !window.__fsStore.getAllCreators) return [];
    return await window.__fsStore.getAllCreators();
  });

test("pin-creator: visible on profile, hidden on explore, toggles watchlist", async () => {
  const page = await ext.context.newPage();

  // 1. Profile → pin button visible.
  await page.goto(`${server.origin}/zachking/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });
  await page.waitForFunction(
    () => !!document.querySelector(".fs-root .fs-pin-btn"),
    null,
    { timeout: 5_000 }
  );

  const pinBtn = page.locator(".fs-root .fs-pin-btn");
  await expect(pinBtn).toBeVisible();

  // 2. Explore → pin button hidden.
  await page.goto(`${server.origin}/explore/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });
  // Wait for scope class to flip.
  await expect
    .poll(
      async () =>
        (await page.locator(".fs-root").getAttribute("class")) || "",
      { timeout: 5_000 }
    )
    .toMatch(/fs-scope-explore/);
  await expect(page.locator(".fs-root .fs-pin-btn")).toBeHidden();

  // 3. Back to profile → click pin → creator should land in store.
  await page.goto(`${server.origin}/zachking/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });
  await page.waitForFunction(
    () => !!window.__fsStore && typeof window.__fsStore.getAllCreators === "function",
    null,
    { timeout: 10_000 }
  );

  // Creator list should not yet contain zachking.
  const creators = await getCreators(page);
  expect(creators.find((c) => c.username === "zachking")).toBeFalsy();

  await page.locator(".fs-root .fs-pin-btn").click();
  await expect
    .poll(async () => (await getCreators(page)).find((c) => c.username === "zachking"), {
      timeout: 5_000,
    })
    .toBeTruthy();

  // Button should now be in the "pinned" state.
  await expect(page.locator(".fs-root .fs-pin-btn")).toHaveClass(/fs-pin-on/);

  // 4. Click again → creator removed.
  await page.locator(".fs-root .fs-pin-btn").click();
  await expect
    .poll(async () => (await getCreators(page)).find((c) => c.username === "zachking"), {
      timeout: 5_000,
    })
    .toBeFalsy();
  await expect(page.locator(".fs-root .fs-pin-btn")).not.toHaveClass(/fs-pin-on/);

  await page.close();
});
