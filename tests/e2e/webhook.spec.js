// Verifies outbound webhook integrations:
//  - "Send test ping" → all configured sinks receive a stub
//  - Manual "Send view to webhook" → Generic sink receives JSON
//  - Weekly digest trigger → Generic sink receives `weekly-digest` payload
//
// chrome.* APIs aren't exposed in the page world, so config writes and IDB
// seeding go through the service-worker context.
import { test, expect } from "@playwright/test";
import http from "node:http";
import { startStubServer } from "./stub-server.mjs";
import { launchWithExtension } from "./helpers.js";

const startSink = () =>
  new Promise((resolve) => {
    /** @type {Array<{path:string, body:any}>} */
    const received = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body = raw;
        try { body = JSON.parse(raw); } catch {}
        received.push({ path: req.url, body });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        received,
        stop: () => new Promise((r) => server.close(r)),
      });
    });
  });

let stubServer, sink, ext, sw;

test.beforeAll(async () => {
  stubServer = await startStubServer();
  sink = await startSink();
  ext = await launchWithExtension({
    stubOrigin: stubServer.origin,
    extraHostPermissions: ["http://127.0.0.1/*"],
  });
  // Grab the SW context (used for chrome.storage + IDB seeding).
  const existing = ext.context.serviceWorkers();
  sw = existing[0] || (await ext.context.waitForEvent("serviceworker"));
});

test.afterAll(async () => {
  if (ext) await ext.close();
  if (sink) await sink.stop();
  if (stubServer) await stubServer.stop();
});

const writeWebhookConfig = (cfg) =>
  sw.evaluate(
    (c) =>
      new Promise((resolve) =>
        chrome.storage.local.set({ "fs.webhooks": c }, () => resolve(true)),
      ),
    cfg,
  );

test("test ping POSTs a stub to every configured webhook", async () => {
  const page = await ext.context.newPage();
  await page.goto(`${stubServer.origin}/zachking/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  await writeWebhookConfig({
    generic: `${sink.origin}/test-ping-generic`,
    slack: `${sink.origin}/test-ping-slack`,
    discord: `${sink.origin}/test-ping-discord`,
    autoOnCollect: false,
  });

  const before = sink.received.length;
  await page.locator('.fs-tab[data-tab="settings"]').click();
  // Wait for renderSettings to async-populate the input from chrome.storage.local.
  await expect(page.locator('[data-ctl="whGeneric"]')).toHaveValue(
    `${sink.origin}/test-ping-generic`,
    { timeout: 5_000 },
  );
  // Settings is an accordion: expand all sections so the buttons are clickable.
  await page.evaluate(() =>
    document.querySelectorAll('.fs-set-section').forEach((d) => (d.open = true))
  );
  await page.locator('[data-act="wh-test"]').click();

  await expect
    .poll(() => sink.received.length - before, { timeout: 10_000 })
    .toBeGreaterThanOrEqual(3);

  const paths = sink.received.slice(before).map((r) => r.path);
  expect(paths).toEqual(
    expect.arrayContaining([
      "/test-ping-generic",
      "/test-ping-slack",
      "/test-ping-discord",
    ]),
  );
  const generic = sink.received.find((r) => r.path === "/test-ping-generic");
  expect(generic.body).toMatchObject({ source: "feed-sorter-ig", version: "test-ping" });

  await page.close();
});

test("'Send view to webhook' POSTs filtered posts as JSON", async () => {
  const page = await ext.context.newPage();
  await page.goto(`${stubServer.origin}/zachking/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  // Stub server fires /feed/user/ + /clips/user/ on a delay; wait for posts.
  await expect
    .poll(
      async () => (await page.evaluate(() => window.fs.posts())).length,
      { timeout: 8_000, intervals: [200, 400, 800] },
    )
    .toBeGreaterThanOrEqual(1);

  await writeWebhookConfig({
    generic: `${sink.origin}/view`,
    slack: "",
    discord: "",
    autoOnCollect: false,
  });

  await page.locator('.fs-tab[data-tab="settings"]').click();
  await expect(page.locator('[data-ctl="whGeneric"]')).toHaveValue(
    `${sink.origin}/view`,
    { timeout: 5_000 },
  );
  await page.evaluate(() =>
    document.querySelectorAll('.fs-set-section').forEach((d) => (d.open = true))
  );
  const before = sink.received.filter((r) => r.path === "/view").length;
  await page.locator('[data-act="wh-send-view"]').click();

  await expect
    .poll(() => sink.received.filter((r) => r.path === "/view").length, { timeout: 10_000 })
    .toBeGreaterThan(before);

  const last = [...sink.received].reverse().find((r) => r.path === "/view");
  expect(last.body).toMatchObject({ source: "feed-sorter-ig", version: "view" });
  expect(Array.isArray(last.body.posts)).toBe(true);
  expect(last.body.posts.length).toBeGreaterThan(0);
  expect(last.body.scope).toMatchObject({ kind: "profile", username: "zachking" });

  await page.close();
});

test("weekly digest dispatch hits the generic sink with watchlist outliers", async () => {
  await writeWebhookConfig({
    generic: `${sink.origin}/weekly`,
    slack: "",
    discord: "",
    autoOnCollect: false,
  });

  // Seed creators + posts via the SW's IDB (same DB the digest reads).
  await sw.evaluate(async () => {
    const open = () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("feed-sorter", 5);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const [name, key] of [
            ["posts", "id"], ["meta", "id"], ["creators", "username"],
            ["audio", "id"], ["signals", "id"],
          ]) {
            if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: key });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    const db = await open();
    const put = (store, row) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        const r = tx.objectStore(store).put(row);
        r.onsuccess = () => resolve();
        r.onerror = () => reject(r.error);
      });
    await put("creators", {
      username: "zachking", niche: "test",
      autoCollect: false, scrapeIntervalHrs: 24, lastScrapedAt: 0,
    });
    const now = Math.floor(Date.now() / 1000);
    const mk = (i, likes) => ({
      id: `seed-${i}`, shortcode: `s${i}`, author: "zachking",
      desc: `seed ${i}`, createTime: now - i * 3600, surface: "profile",
      likes, views: likes * 4, comments: Math.floor(likes / 50),
      url: `https://www.instagram.com/p/s${i}/`, cover: "",
      lastSeenAt: Date.now(),
    });
    for (let i = 0; i < 5; i++) await put("posts", mk(i, 1000));
    await put("posts", mk(99, 50000)); // clear outlier
  });

  // Call the digest function directly inside the SW. (chrome.runtime
  // .sendMessage from a SW doesn't loop back to its own listener.)
  await sw.evaluate(() => globalThis.__fsWeeklyDigest());

  await expect
    .poll(() => sink.received.filter((r) => r.path === "/weekly").length, { timeout: 15_000 })
    .toBeGreaterThan(0);

  const last = [...sink.received].reverse().find((r) => r.path === "/weekly");
  expect(last.body).toMatchObject({ source: "feed-sorter-ig", version: "weekly-digest" });
  expect(Array.isArray(last.body.posts)).toBe(true);
  expect(last.body.posts.length).toBeGreaterThan(0);
  // The 50000-likes post should rank #1.
  expect(last.body.posts[0].likes).toBe(50000);
});
