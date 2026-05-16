// Tiny stub server that mimics a few YouTube innertube endpoints using
// fixtures. Mirrors stub-server.mjs / stub-tiktok-server.mjs in shape so the
// same launchWithExtension() helper drives all three. No external deps —
// vanilla node:http.
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "..", "fixtures");

const loadFixture = (name) => readFileSync(join(FIXTURES, name), "utf8");

// Channel /shorts grid: fires /youtubei/v1/browse on a 500ms delay so the
// content script has booted and pageScope is set ('profile') before the
// JSON arrives. Otherwise scope-change clears posts.
const channelShortsHTML = (handle) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${handle} • YouTube</title></head>
<body>
<h1>@${handle} — Shorts</h1>
<div id="output">loading…</div>
<script>
setTimeout(async () => {
  const r = await fetch('/youtubei/v1/browse', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ context: {}, browseId: 'UCfake' }),
  });
  const j = await r.json();
  window.__lastBrowse = j;
  document.getElementById('output').textContent = 'loaded shorts shelf';
}, 500);
</script>
</body></html>`;

// Snap player /shorts/<id>: fires /youtubei/v1/player + /youtubei/v1/next so
// the YT branch of platform-runtime ingests both. Includes a fake
// <ytd-reel-video-renderer is-active> with #navigation-button-down so the
// snap-strategy click path can be exercised by capture-youtube.spec.js.
const shortsPlayerHTML = (videoId) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Shorts • YouTube</title></head>
<body>
<h1>Shorts player</h1>
<ytd-reel-video-renderer is-active>
  <div id="short-id">${videoId}</div>
  <div id="like-button">
    <button id="like-btn" aria-label="Like this video along with 344 other people">344</button>
  </div>
  <ytd-button-renderer id="comments-button">
    <button id="comments-btn" aria-label="10 comments">10</button>
  </ytd-button-renderer>
  <div id="metadata-line"><span aria-label="13.9K views">13.9K views</span></div>
  <div id="navigation-button-down">
    <button id="next-short-btn">Next</button>
  </div>
</ytd-reel-video-renderer>
<div id="output">loading…</div>
<script>
let advanceCount = 0;
window.__nextClicks = 0;
const setVisibleShort = (id, likes, comments, views) => {
  window.history.replaceState({}, '', '/shorts/' + id);
  document.getElementById('short-id').textContent = id;
  document.getElementById('like-btn').textContent = likes;
  document.getElementById('like-btn').setAttribute('aria-label', 'Like this video along with ' + likes + ' other people');
  document.getElementById('comments-btn').textContent = comments;
  document.getElementById('comments-btn').setAttribute('aria-label', comments + ' comments');
  const viewEl = document.querySelector('#metadata-line span');
  viewEl.textContent = views + ' views';
  viewEl.setAttribute('aria-label', views + ' views');
  window.dispatchEvent(new Event('yt-navigate-finish'));
};
// Each click on the next-button triggers a fresh /player fetch with a new
// videoId so the collector loop has new posts to ingest on each round.
document.getElementById('next-short-btn').addEventListener('click', async () => {
  window.__nextClicks++;
  advanceCount++;
  const fakeId = 'next' + advanceCount.toString().padStart(3, '0') + 'AB';
  setVisibleShort(fakeId, String(344 + advanceCount), String(10 + advanceCount), (13.9 + advanceCount).toFixed(1) + 'K');
  await fetch('/youtubei/v1/player?v=' + fakeId, { method: 'POST', body: '{}' });
});

setTimeout(async () => {
  if (new URLSearchParams(location.search).get('prefetch') === '1') {
    await fetch('/youtubei/v1/player?v=prefetch001', { method: 'POST', body: '{}' });
    await fetch('/youtubei/v1/player?v=prefetch002', { method: 'POST', body: '{}' });
  }
  await fetch('/youtubei/v1/player?v=${videoId}', { method: 'POST', body: '{}' });
  await fetch('/youtubei/v1/next?v=${videoId}', { method: 'POST', body: '{}' });
  document.getElementById('output').textContent = 'loaded';
}, 500);
</script>
</body></html>`;

// Fake /player JSON that overrides the videoId so each round of the collector
// loop produces a fresh row. Falls back to the fixture for ?v=abc123XYZ_-.
const playerJsonForVideoId = (videoId) => {
  const base = JSON.parse(loadFixture("youtube-player.json"));
  if (videoId && videoId !== base.videoDetails.videoId) {
    base.videoDetails.videoId = videoId;
    base.videoDetails.title = `auto-advanced ${videoId}`;
  }
  return JSON.stringify(base);
};

export const startStubServer = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url || "/";

      // /youtubei/v1/browse → shorts shelf JSON
      if (url.startsWith("/youtubei/v1/browse")) {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "x-feed-sorter-tag": "yt-shorts",
        });
        res.end(loadFixture("youtube-browse.json"));
        return;
      }
      // /youtubei/v1/player?v=<id> → player JSON for that video id
      if (url.startsWith("/youtubei/v1/player")) {
        const m = url.match(/[?&]v=([^&]+)/);
        const videoId = m ? decodeURIComponent(m[1]) : "abc123XYZ_-";
        res.writeHead(200, {
          "Content-Type": "application/json",
          "x-feed-sorter-tag": "yt-player",
        });
        res.end(playerJsonForVideoId(videoId));
        return;
      }
      // /youtubei/v1/next → next JSON (views/dateText only here). Engagement
      // counts are intentionally absent so the E2E exercises the live Shorts DOM
      // fallback for like/comment buttons.
      if (url.startsWith("/youtubei/v1/next")) {
        const m = url.match(/[?&]v=([^&]+)/);
        const videoId = m ? decodeURIComponent(m[1]) : "abc123XYZ_-";
        const base = JSON.parse(loadFixture("youtube-next.json"));
        base.currentVideoEndpoint = { reelWatchEndpoint: { videoId } };
        const primary = base.contents?.twoColumnWatchNextResults?.results?.results?.contents?.[0]?.videoPrimaryInfoRenderer;
        if (primary) delete primary.videoActions;
        res.writeHead(200, {
          "Content-Type": "application/json",
          "x-feed-sorter-tag": "yt-next",
        });
        res.end(JSON.stringify(base));
        return;
      }

      // /shorts/<id> → snap player page
      const shortsMatch = url.match(/^\/shorts\/([\w-]+)\/?(?:\?.*)?$/);
      if (shortsMatch) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(shortsPlayerHTML(shortsMatch[1]));
        return;
      }

      // /@<handle>/shorts → channel grid
      const channelMatch = url.match(/^\/@([\w.-]+)(?:\/shorts)?\/?(?:\?.*)?$/);
      if (channelMatch) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(channelShortsHTML(channelMatch[1]));
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
