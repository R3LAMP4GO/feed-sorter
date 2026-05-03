// Verifies the direct-sinks pipeline end-to-end against a stub HTTP
// receiver. Sheets is exercised "for real" because its URL is freeform —
// we point it at a localhost stub. Airtable + Notion mappings are covered
// by the unit suite (tests/unit/sinks.test.js) since their endpoints are
// hard-coded to api.airtable.com / api.notion.com.
//
// What we assert:
//   1. The Sinks UI is mounted in Settings.
//   2. "Test" POSTs `{rows: [], test: true, source: "feed-sorter-ig"}`
//      to the configured Apps Script URL and surfaces "ping ok" in status.
//   3. "Sync filtered view now" POSTs `{rows: [...]}` with field shape
//      matching the Apps Script template (id, author, likes, score, …).
//   4. The status line shows "N/N ok".

import { test, expect } from "@playwright/test";
import http from "node:http";
import { startStubServer } from "./stub-server.mjs";
import { launchWithExtension } from "./helpers.js";

const startSink = () =>
  new Promise((resolve) => {
    const received = [];
    const server = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let body = raw;
        try { body = JSON.parse(raw); } catch {}
        received.push({ path: req.url, method: req.method, body });
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify({ ok: true, appended: (body.rows || []).length }));
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
  const existing = ext.context.serviceWorkers();
  sw = existing[0] || (await ext.context.waitForEvent("serviceworker"));
});

test.afterAll(async () => {
  if (ext) await ext.close();
  if (sink) await sink.stop();
  if (stubServer) await stubServer.stop();
});

const writeSinkConfig = (cfg) =>
  sw.evaluate(
    (c) =>
      new Promise((resolve) =>
        chrome.storage.local.set({ "fs.sinks": c }, () => resolve(true)),
      ),
    cfg,
  );

const baseCfg = (sheetsUrl) => ({
  sheets: { enabled: true, url: sheetsUrl, autoOnCollect: false },
  airtable: { enabled: false, token: "", baseId: "", table: "", autoOnCollect: false },
  notion: { enabled: false, token: "", databaseId: "", autoOnCollect: false },
});

test("Sinks settings panel is mounted", async () => {
  const page = await ext.context.newPage();
  await page.goto(`${stubServer.origin}/zachking/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  await page.locator('.fs-tab[data-tab="settings"]').click();
  // Direct sinks live inside an accordion section — expand it first.
  await page.evaluate(() =>
    document.querySelectorAll('.fs-set-section').forEach((d) => (d.open = true))
  );
  await expect(page.locator('.fs-sink[data-sink="sheets"]')).toBeVisible();
  await expect(page.locator('.fs-sink[data-sink="airtable"]')).toBeVisible();
  await expect(page.locator('.fs-sink[data-sink="notion"]')).toBeVisible();
  await page.close();
});

test("Sheets sink: Test button POSTs ping to Apps Script URL", async () => {
  const page = await ext.context.newPage();
  await page.goto(`${stubServer.origin}/zachking/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  await writeSinkConfig(baseCfg(`${sink.origin}/sheets-test`));

  await page.locator('.fs-tab[data-tab="settings"]').click();
  await page.evaluate(() =>
    document.querySelectorAll('.fs-set-section').forEach((d) => (d.open = true))
  );
  await page.locator('.fs-sink[data-sink="sheets"] > summary').click();
  await expect(page.locator('[data-sink-ctl="sheets.url"]')).toHaveValue(
    `${sink.origin}/sheets-test`,
    { timeout: 5_000 },
  );

  const before = sink.received.filter((r) => r.path === "/sheets-test").length;
  await page.locator('.fs-sink[data-sink="sheets"] [data-act="sink-test"]').click();

  await expect
    .poll(() => sink.received.filter((r) => r.path === "/sheets-test").length, { timeout: 10_000 })
    .toBeGreaterThan(before);

  const ping = sink.received.filter((r) => r.path === "/sheets-test").pop();
  expect(ping.method).toBe("POST");
  expect(ping.body).toMatchObject({ source: "feed-sorter-ig", test: true });
  expect(Array.isArray(ping.body.rows)).toBe(true);
  expect(ping.body.rows.length).toBe(0);

  await expect(page.locator('[data-sink-status="sheets"]')).toContainText(/ok/i, { timeout: 5_000 });
  await page.close();
});

test("Sheets sink: Sync filtered view POSTs captured posts in correct shape", async () => {
  const page = await ext.context.newPage();
  await page.goto(`${stubServer.origin}/zachking/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  // Wait for the stub-server fixtures to populate the in-memory Map.
  await expect
    .poll(
      async () => (await page.evaluate(() => window.fs.posts())).length,
      { timeout: 10_000, intervals: [200, 400, 800] },
    )
    .toBeGreaterThanOrEqual(1);

  const captured = await page.evaluate(() => window.fs.posts());
  const expectedRows = captured.length;

  await writeSinkConfig(baseCfg(`${sink.origin}/sheets-sync`));

  await page.locator('.fs-tab[data-tab="settings"]').click();
  await page.evaluate(() =>
    document.querySelectorAll('.fs-set-section').forEach((d) => (d.open = true))
  );
  await page.locator('.fs-sink[data-sink="sheets"] > summary').click();
  await expect(page.locator('[data-sink-ctl="sheets.url"]')).toHaveValue(
    `${sink.origin}/sheets-sync`,
    { timeout: 5_000 },
  );

  const before = sink.received.filter((r) => r.path === "/sheets-sync").length;
  await page.locator('.fs-sink[data-sink="sheets"] [data-act="sink-sync"]').click();

  await expect
    .poll(() => sink.received.filter((r) => r.path === "/sheets-sync").length, { timeout: 15_000 })
    .toBeGreaterThan(before);

  const reqs = sink.received.filter((r) => r.path === "/sheets-sync");
  const totalRows = reqs.reduce((n, r) => n + (r.body.rows || []).length, 0);
  expect(totalRows).toBeGreaterThanOrEqual(expectedRows);

  // Field shape sanity-check on the first row of the first POST.
  const first = reqs[0].body.rows[0];
  expect(first).toHaveProperty("id");
  expect(first).toHaveProperty("author");
  expect(typeof first.likes).toBe("number");
  expect(typeof first.score).toBe("number");
  expect(typeof first.surface).toBe("string");
  expect(first).toHaveProperty("createdAt");

  await expect(page.locator('[data-sink-status="sheets"]')).toContainText(/\d+\/\d+ ok/, { timeout: 10_000 });
  await page.close();
});
