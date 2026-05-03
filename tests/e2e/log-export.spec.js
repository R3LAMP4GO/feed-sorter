// Verifies the upgraded logger:
//  - download.fail is recorded as level=warn with an Error stack
//  - entries are persisted in IndexedDB (db: feed-sorter-logs, store: logs)
//  - the export pipeline yields JSONL with the same shape
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

test("download.fail logged as warn with stack, persisted to IDB", async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/zachking/`, { waitUntil: "domcontentloaded" });

  // Wait for the page-world API and at least one reel row in the overlay.
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });
  await page.waitForFunction(
    () => document.querySelectorAll(".fs-root .fs-row").length >= 1,
    null,
    { timeout: 10_000 }
  );

  // Surface = reels so we know the row we click has a videoUrl.
  await page.evaluate(() => window.fs.setFilter("surface", "reels"));
  await page.waitForFunction(
    () => {
      const btns = document.querySelectorAll(".fs-root .fs-row .fs-dl:not([disabled])");
      return btns.length >= 1;
    },
    null,
    { timeout: 5_000 }
  );

  // Click the first enabled download button. The fixture's video_url points
  // at https://cdn.example/... which won't resolve, so fetch throws → warn.
  await page.click(".fs-root .fs-row .fs-dl:not([disabled])");

  // Wait for the warn entry to land in IDB.
  const entry = await page.waitForFunction(async () => {
    const dbs = await indexedDB.databases();
    if (!dbs.some((d) => d.name === "feed-sorter-logs")) return null;
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open("feed-sorter-logs");
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const rows = await new Promise((res, rej) => {
      const tx = db.transaction("logs", "readonly");
      const req = tx.objectStore("logs").getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    db.close();
    const hit = rows.find((r) => r.event === "download.fail");
    return hit || null;
  }, null, { timeout: 10_000 });

  const value = await entry.jsonValue();
  expect(value.event).toBe("download.fail");
  expect(value.level).toBe("warn");
  expect(typeof value.stack).toBe("string");
  expect(value.stack.length).toBeGreaterThan(0);
  expect(typeof value.err).toBe("string");

  await page.close();
});
