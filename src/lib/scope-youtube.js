// Page-scope detection for YouTube URL pathnames. Pure.
//
// Mapping (per managed-backend plan):
//   /shorts/<id>             → 'shorts-feed'  (gated for free tier)
//   /@<handle>               → 'profile'
//   /@<handle>/<tab>         → 'profile'      (videos / shorts / community / …)
//   /channel/<id>            → 'profile'
//   /c/<name>                → 'profile'      (legacy)
//   /user/<name>             → 'profile'      (legacy)
//   /results, /feed/...      → 'other'

const HANDLE_RE = /^\/@([A-Za-z0-9._-]+)\/?(?:[a-z]+\/?)?$/;
const CHANNEL_RE = /^\/channel\/([A-Za-z0-9_-]+)\/?(?:[a-z]+\/?)?$/;
const LEGACY_C_RE = /^\/(?:c|user)\/([A-Za-z0-9._-]+)\/?(?:[a-z]+\/?)?$/;
const SHORTS_RE = /^\/shorts\/([A-Za-z0-9_-]{6,})\/?$/;

/**
 * @returns {{ kind: 'profile'|'shorts-feed'|'search'|'other', username: string|null, videoId: string|null }}
 */
export const deriveScope = (pathname = '/') => {
  const path = pathname || '/';

  // Shorts viewer counts as the shorts-feed surface
  const ms = path.match(SHORTS_RE);
  if (ms) return { kind: 'shorts-feed', username: null, videoId: ms[1] };

  if (path === '/feed/shorts' || path.startsWith('/feed/shorts/')) {
    return { kind: 'shorts-feed', username: null, videoId: null };
  }

  const mh = path.match(HANDLE_RE);
  if (mh) return { kind: 'profile', username: mh[1].toLowerCase(), videoId: null };

  const mc = path.match(CHANNEL_RE);
  if (mc) return { kind: 'profile', username: mc[1], videoId: null };

  const ml = path.match(LEGACY_C_RE);
  if (ml) return { kind: 'profile', username: ml[1].toLowerCase(), videoId: null };

  if (path === '/results' || path.startsWith('/results?')) {
    return { kind: 'search', username: null, videoId: null };
  }

  return { kind: 'other', username: null, videoId: null };
};
