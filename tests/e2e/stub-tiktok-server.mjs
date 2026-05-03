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

const foryouHTML = () => `<!doctype html>
<html><head><meta charset="utf-8"><title>For You • TikTok</title></head>
<body>
<h1>For You</h1>
<div id="output">loading…</div>
<script>
setTimeout(async () => {
  const r = await fetch('/api/recommend/item_list/?from_page=fyp');
  const j = await r.json();
  window.__lastForYou = j;
  document.getElementById('output').textContent = 'loaded ' + (j.itemList||[]).length + ' items';
}, 500);
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
        res.writeHead(200, {
          "Content-Type": "application/json",
          "x-feed-sorter-tag": "tt-foryou",
        });
        res.end(loadFixture("tiktok-foryou.json"));
        return;
      }

      // /foryou page
      if (url === "/foryou" || url === "/foryou/" || url.startsWith("/foryou?")) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(foryouHTML());
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
      res.end("not found: " + url);
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
