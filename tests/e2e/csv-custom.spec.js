import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
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

const parseCSV = (text) => {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (c === "\r") { /* skip */ }
      else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
};

test("csv: custom export supports sort and rich column selection", async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/zachking/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  await expect
    .poll(async () => (await page.evaluate(() => window.fs.posts())).length, { timeout: 8_000 })
    .toBeGreaterThanOrEqual(4);

  await page.locator('[data-act="csv-custom"]').click();
  await expect(page.locator(".fs-modal")).toBeVisible();
  await page.locator("[data-csv-preset='transcripts']").click();
  await page.locator("[data-csv-sort]").selectOption("views");

  const downloadPromise = page.waitForEvent("download", { timeout: 5_000 });
  await page.locator('[data-act="csv-download"]').click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toContain("_views_");
  const text = readFileSync(await download.path(), "utf8");
  expect(text.charCodeAt(0)).toBe(0xfeff);
  const rows = parseCSV(text);
  expect(rows[0]).toContain("Creator name");
  expect(rows[0]).toContain("Category");
  expect(rows[0]).toContain("Niche");
  expect(rows[0]).toContain("Format");
  expect(rows[0]).toContain("Content format");
  expect(rows[0]).toContain("Visual format");
  expect(rows[0]).toContain("Category confidence");
  expect(rows[0]).toContain("Format confidence");
  expect(rows[0]).toContain("Classification source");
  expect(rows[0]).toContain("Outlier score");
  expect(rows[0]).toContain("Caption");
  expect(rows[0]).toContain("Transcript");
  expect(rows[0]).toContain("Transcript segments");
  expect(rows[0]).toContain("Hook");
  expect(rows[0]).toContain("Hook type");
  expect(rows[0]).toContain("Middle/value summary");
  expect(rows[0]).toContain("CTA");
  expect(rows[0]).toContain("CTA type");
  expect(rows[0]).toContain("URL");

  await page.close();
});
