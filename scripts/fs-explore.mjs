import { chromium } from "playwright";
import path from "node:path";
const EXT = "/Users/imorgado/Downloads/feed-sorter-instagram";
const PROFILE = path.join(EXT, ".pw-profile");
const ts = () => new Date().toISOString().slice(11, 23);
const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  channel: "chromium",
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--no-default-browser-check"],
});
// No auto-collect — user clicks "Collect all" in the overlay.
const attach = (p) => {
  p.on("console", (m) => { const t = m.text(); if (t.startsWith("[FS]")) console.log(`[fs ${ts()}]`, t.slice(5)); });
};
ctx.pages().forEach(attach);
ctx.on("page", attach);
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto("https://www.instagram.com/explore/", { waitUntil: "domcontentloaded" });
setInterval(async () => {
  for (const p of ctx.pages()) {
    if (!/instagram\.com/.test(p.url())) continue;
    const s = await p.evaluate(async () => {
      if (!window.fs) return null;
      const posts = await window.fs.posts();
      const bySurface = posts.reduce((a, p) => ((a[p.surface] = (a[p.surface] || 0) + 1), a), {});
      const authors = new Set(posts.map(p => p.author).filter(Boolean)).size;
      return { total: posts.length, authors, bySurface, scope: window.__feedSorter?.getScope?.() };
    }).catch(() => null);
    if (s) console.log(`[hb ${ts()}]`, s);
  }
}, 5000);
await new Promise(() => {});
