// Verifies the IndexedDB-backed store: collect on profile A, navigate
// away (fresh content-script load wipes the in-memory cache), navigate
// back to A, posts should reappear with their *original* firstSeenAt
// timestamps from IDB rather than fresh timestamps from a new fetch.
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

const waitPosts = (page, min) =>
  expect
    .poll(async () => (await page.evaluate(() => window.fs.posts())).length, {
      timeout: 8_000,
      intervals: [100, 200, 400],
    })
    .toBeGreaterThanOrEqual(min);

test("rehydrate: posts survive scope change A → B → A via IDB", async () => {
  const page = await ext.context.newPage();

  // 1. Visit profile A → fixtures populate IDB with firstSeenAt timestamps.
  await page.goto(`${server.origin}/zachking/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });
  await waitPosts(page, 4);

  const initial = await page.evaluate(() => window.fs.posts());
  expect(initial.every((p) => p.firstSeenAt > 0 && p.lastSeenAt > 0)).toBe(true);
  const firstSeenById = Object.fromEntries(initial.map((p) => [p.id, p.firstSeenAt]));

  // 2. Navigate to profile B (different scope). Content script re-boots,
  //    in-memory Map starts empty.
  await page.goto(`${server.origin}/nasa/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });
  // Wait long enough that any rehydrate from IDB would have run by now.
  await page.waitForTimeout(800);

  // 3. Navigate back to profile A.
  await page.goto(`${server.origin}/zachking/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });
  await waitPosts(page, 4);

  const after = await page.evaluate(() => window.fs.posts());
  // Every original id must reappear with its original firstSeenAt — proving
  // the row came from IDB, not from a fresh ingest.
  for (const p of after) {
    if (firstSeenById[p.id] !== undefined) {
      expect(p.firstSeenAt).toBe(firstSeenById[p.id]);
    }
  }
  // At least the 4 fixture ids must match.
  const matched = after.filter((p) => firstSeenById[p.id] !== undefined).length;
  expect(matched).toBeGreaterThanOrEqual(4);

  await page.close();
});
