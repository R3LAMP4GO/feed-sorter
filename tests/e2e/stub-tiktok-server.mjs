// Tiny stub server that mimics a few TikTok endpoints using fixtures.
// Mirrors stub-server.mjs in shape so the same launchWithExtension() helper
// can drive both. No external deps — vanilla node:http.
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "fixtures");

const loadFixture = (name) => readFileSync(join(FIXTURES, name), "utf8");

const tiktokPageFixture = (surface, page, maxPages = 2) => {
  const base = JSON.parse(loadFixture("tiktok-foryou.json"));
  const pageNum = Number(page) || 1;
  const surfaceOffset = surface === "explore" ? 10_000 : 0;
  for (const item of base.itemList || []) {
    const native = BigInt(item.id) + BigInt(surfaceOffset + (pageNum - 1) * 100);
    item.id = String(native);
    item.video = { ...(item.video || {}), id: item.id };
    item.desc = `${surface} page ${pageNum} · ${item.desc || ""}`.trim();
    if (item.author?.uniqueId) item.author.uniqueId = `${item.author.uniqueId}_${pageNum}`;
  }
  base.hasMore = pageNum < maxPages;
  base.cursor = String(pageNum * 60);
  return JSON.stringify(base);
};

const profileHTML = (user) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${user} • TikTok</title></head>
<body>
<h1>@${user}</h1>
<div id="output">loading…</div>
<script>
// Delay so the content script has booted and pageScope is set before the
// JSON arrives (otherwise scope-change clears posts).
setTimeout(async () => {
  const r = await fetch('/api/post/item_list/?secUid=fake&user_id=1&count=30');
  const j = await r.json();
  window.__lastFeed = j;
  document.getElementById('output').textContent = 'loaded ' + (j.itemList||[]).length + ' items';
}, 500);
</script>
</body></html>`;

const videoHTML = (user, videoId) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${videoId} • TikTok</title></head>
<body>
<h1>@${user} video ${videoId}</h1>
<div id="output">loading…</div>
<script>
setTimeout(async () => {
  const r = await fetch('/api/post/item_list/?secUid=fake&user_id=1&count=30');
  const j = await r.json();
  window.__lastFeed = j;
  document.getElementById('output').textContent = 'loaded detail candidates ' + (j.itemList||[]).length;
}, 500);
</script>
</body></html>`;

const foryouHTML = () => `<!doctype html>
<html><head><meta charset="utf-8"><title>For You • TikTok</title></head>
<body style="min-height:100vh">
<h1>For You</h1>
<button data-e2e="arrow-right" id="next-video" type="button">Next</button>
<div id="output">loading…</div>
<script>
let page = 0;
const maxPages = Number(new URLSearchParams(location.search).get('pages') || '2');
async function loadNext() {
  page += 1;
  const r = await fetch('/api/recommend/item_list/?from_page=fyp&page=' + page + '&pages=' + maxPages);
  const j = await r.json();
  const items = j.itemList || [];
  window.__lastForYou = j;
  window.__forYouFetches = page;
  document.getElementById('output').textContent = 'loaded page ' + page + ' · ' + items.length + ' items';
  if (page >= maxPages) document.getElementById('next-video').disabled = true;
}
setTimeout(loadNext, 500);
document.getElementById('next-video').addEventListener('click', () => {
  if (page < maxPages) loadNext();
});
</script>
</body></html>`;

const exploreHTML = () => `<!doctype html>
<html><head><meta charset="utf-8"><title>Explore • TikTok</title></head>
<body style="min-height:100vh">
<h1>Explore</h1>
<button data-e2e="arrow-right" id="next-video" type="button">Next</button>
<div id="output">loading…</div>
<script>
let page = 0;
const params = new URLSearchParams(location.search);
const maxPages = Number(params.get('pages') || '2');
const batch = Number(params.get('batch') || sessionStorage.getItem('ttExploreBatch') || '0');
sessionStorage.setItem('ttExploreBatch', String(batch + 1));
async function loadNext() {
  page += 1;
  const r = await fetch('/api/explore/item_list/?page=' + page + '&pages=' + maxPages + '&batch=' + batch);
  const j = await r.json();
  const items = j.itemList || [];
  window.__lastExplore = j;
  window.__exploreFetches = page;
  window.__exploreBatch = batch;
  document.getElementById('output').textContent = 'loaded batch ' + batch + ' page ' + page + ' · ' + items.length + ' items';
  if (page >= maxPages) document.getElementById('next-video').disabled = true;
}
setTimeout(loadNext, 500);
document.getElementById('next-video').addEventListener('click', () => {
  if (page < maxPages) loadNext();
});
</script>
</body></html>`;

export const startStubServer = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url || "/";

      if (url.startsWith("/api/post/item_list")) {
        res.writeHead(200, {
          "Content-Type": "application/json",
          // Mirror what the DNR rule would inject in production.
          "x-feed-sorter-tag": "tt-profile",
        });
        res.end(loadFixture("tiktok-profile.json"));
        return;
      }
      if (url.startsWith("/api/recommend/item_list")) {
        const params = new URL(url, "http://127.0.0.1").searchParams;
        const page = params.get("page") || "1";
        const maxPages = Number(params.get("pages") || "2");
        res.writeHead(200, {
          "Content-Type": "application/json",
          "x-feed-sorter-tag": "tt-foryou",
        });
        res.end(tiktokPageFixture("foryou", page, maxPages));
        return;
      }
      if (url.startsWith("/api/explore/item_list")) {
        const params = new URL(url, "http://127.0.0.1").searchParams;
        const page = params.get("page") || "1";
        const maxPages = Number(params.get("pages") || "2");
        const batch = Number(params.get("batch") || "0");
        const pageNum = Number(page) || 1;
        const fixturePage = String(pageNum + batch * maxPages);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "x-feed-sorter-tag": "tt-explore",
        });
        res.end(tiktokPageFixture("explore", fixturePage, maxPages * Math.max(1, batch + 1)));
        return;
      }

      // / and /foryou page
      if (url === "/" || url.startsWith("/?") || url === "/foryou" || url === "/foryou/" || url.startsWith("/foryou?")) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(foryouHTML());
        return;
      }

      // /explore page
      if (url === "/explore" || url === "/explore/" || url.startsWith("/explore?")) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(exploreHTML());
        return;
      }

      // /@{user}/video/{id} → single-video page
      const videoMatch = url.match(/^\/@([\w.][\w._-]*[\w])\/video\/([0-9A-Za-z_-]+)\/?(?:\?.*)?$/);
      if (videoMatch) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(videoHTML(videoMatch[1], videoMatch[2]));
        return;
      }

      // /@{user} or /@{user}/  → profile page
      const profileMatch = url.match(/^\/@([\w.][\w._-]*[\w])\/?(?:\?.*)?$/);
      if (profileMatch) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(profileHTML(profileMatch[1]));
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`not found: ${url}`);
    });

    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        stop: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
