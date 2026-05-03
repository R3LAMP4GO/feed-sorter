// Click the CSV button, intercept the download, parse the body, and
// verify both row count and the filename pattern
//   ig_{scope}[_surface]_{sortPart}[_range]_{rows}_{YYYY-MM-DD_HHMM}.csv
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
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

// Minimal CSV parser tolerant to quoted fields with embedded commas/newlines.
const parseCSV = (text) => {
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

test("csv: download has expected rows and filename pattern", async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/zachking/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => !!window.fs, null, { timeout: 10_000 });

  // Wait for fixtures (4 posts).
  await expect
    .poll(async () => (await page.evaluate(() => window.fs.posts())).length, {
      timeout: 8_000,
    })
    .toBeGreaterThanOrEqual(4);

  const expectedRows = await page.evaluate(
    () => window.fs.posts().then((p) => p.length)
  );

  const downloadPromise = page.waitForEvent("download", { timeout: 5_000 });
  await page.locator('[data-act="csv"]').click();
  const download = await downloadPromise;

  // Filename pattern: ig_zachking[_surface]_outlier-likes[_range]_{rows}_YYYY-MM-DD_HHMM.csv
  const name = download.suggestedFilename();
  expect(name).toMatch(
    /^ig_zachking(?:_[a-z]+)?_[a-z-]+(?:_[a-z0-9]+)?_(\d+)_\d{4}-\d{2}-\d{2}_\d{4}\.csv$/
  );
  const rowsInName = parseInt(name.match(/_(\d+)_\d{4}-\d{2}-\d{2}/)[1], 10);
  expect(rowsInName).toBe(expectedRows);

  // Read & parse the file body.
  const path = await download.path();
  expect(path).toBeTruthy();
  const text = readFileSync(path, "utf8");
  const rows = parseCSV(text);

  // 1 header + N data rows.
  expect(rows.length).toBe(expectedRows + 1);
  expect(rows[0][0]).toBe("rank");
  expect(rows[0]).toContain("author");
  expect(rows[0]).toContain("id");

  // Every data row's author column should be zachking.
  const authorIdx = rows[0].indexOf("author");
  for (let i = 1; i < rows.length; i++) {
    expect(rows[i][authorIdx]).toBe("zachking");
  }

  await page.close();
});
