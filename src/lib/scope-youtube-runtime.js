// IIFE mirror of src/lib/scope-youtube.js. Keep in lock-step.

(function () {
  const HANDLE_RE = /^\/@([A-Za-z0-9._-]+)\/?(?:[a-z]+\/?)?$/;
  const CHANNEL_RE = /^\/channel\/([A-Za-z0-9_-]+)\/?(?:[a-z]+\/?)?$/;
  const LEGACY_C_RE = /^\/(?:c|user)\/([A-Za-z0-9._-]+)\/?(?:[a-z]+\/?)?$/;
  const SHORTS_RE = /^\/shorts\/([A-Za-z0-9_-]{6,})\/?$/;

  function deriveScope(pathname) {
    const path = pathname || '/';
    const ms = path.match(SHORTS_RE);
    if (ms) return { kind: 'shorts-feed', username: null, videoId: ms[1] };
    if (path === '/feed/shorts' || path.indexOf('/feed/shorts/') === 0) {
      return { kind: 'shorts-feed', username: null, videoId: null };
    }
    const mh = path.match(HANDLE_RE);
    if (mh) return { kind: 'profile', username: mh[1].toLowerCase(), videoId: null };
    const mc = path.match(CHANNEL_RE);
    if (mc) return { kind: 'profile', username: mc[1], videoId: null };
    const ml = path.match(LEGACY_C_RE);
    if (ml) return { kind: 'profile', username: ml[1].toLowerCase(), videoId: null };
    if (path === '/results' || path.indexOf('/results?') === 0) {
      return { kind: 'search', username: null, videoId: null };
    }
    return { kind: 'other', username: null, videoId: null };
  }

  globalThis.FeedSorterYouTubeScope = { deriveScope };
})();
