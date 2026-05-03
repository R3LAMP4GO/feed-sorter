// Tiny stub server that mimics a few Instagram endpoints using fixtures.
// No external deps — vanilla node:http.
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "fixtures");

const loadFixture = (name) =>
  readFileSync(join(FIXTURES, name), "utf8");

const profileHTML = (user) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${user} • profile</title></head>
<body>
<h1>@${user}</h1>
<div id="output">loading…</div>
<script>
// Delay fetches so the content script has finished booting and set
// pageScope before responses arrive (otherwise scope-change clears posts).
setTimeout(async () => {
  const r = await fetch('/api/v1/feed/user/${user}/');
  const j = await r.json();
  window.__lastFeed = j;
  document.getElementById('output').textContent = 'loaded ' + (j.items||[]).length + ' items';
  const r2 = await fetch('/api/v1/clips/user/${user}/');
  const j2 = await r2.json();
  window.__lastClips = j2;
  window.__lastClipsCount = (j2.items || []).length;
}, 500);
</script>
</body></html>`;

const exploreHTML = () => `<!doctype html>
<html><head><meta charset="utf-8"><title>explore</title></head>
<body>
<h1>Explore</h1>
<div id="output">loading…</div>
<script>
(async () => {
  const r = await fetch('/api/v1/discover/topical/');
  const j = await r.json();
  window.__lastExplore = j;
  document.getElementById('output').textContent = 'loaded explore';
})();
</script>
</body></html>`;

export const startStubServer = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url || "/";

      // Profile page: /profile/zachking, /zachking/, /zachking/reels/
      const profileMatch = url.match(/^\/(?:profile\/)?([\w.][\w.]*[\w])\/(?:reels\/?)?(?:\?.*)?$/);

      if (url === "/explore/" || url === "/explore" || url.startsWith("/explore/")) {
        if (url.startsWith("/explore/")) {
          if (url.startsWith("/api")) {
            // fall through
          } else {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(exploreHTML());
            return;
          }
        } else {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(exploreHTML());
          return;
        }
      }

      if (url.startsWith("/api/v1/feed/user/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(loadFixture("feed-user.json"));
        return;
      }
      if (url.startsWith("/api/v1/clips/user/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(loadFixture("clips-user.json"));
        return;
      }
      if (url.startsWith("/api/v1/discover/topical")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(loadFixture("discover-sectional.json"));
        return;
      }

      if (profileMatch) {
        const user = profileMatch[1];
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(profileHTML(user));
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
