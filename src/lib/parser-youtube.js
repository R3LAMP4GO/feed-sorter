// Pure parsers for YouTube innertube responses (`/youtubei/v1/player`,
// `/youtubei/v1/browse`, `/youtubei/v1/next`).
//
// References: `apades/dmMiniPlayer` `youtube/utils.ts` for caption-track JSON
// shape; `Xerophayze/XeroFlow` `youtube_transcript_node.py` for the
// caption-track baseUrl convention.
//
// No DOM, no chrome APIs, no global state. Safe to import from tests and the
// runtime IIFE mirror alike.

const ID_PREFIX = 'yt_';

const num = (v) => (typeof v === 'number' ? v : Number(v) || 0);
const str = (v) => (v == null ? '' : String(v));

// --- /youtubei/v1/player ----------------------------------------------------
//
// Response shape:
//   {
//     videoDetails: { videoId, title, lengthSeconds, viewCount, author,
//       channelId, shortDescription, thumbnail: { thumbnails:[{url,...}] } },
//     streamingData: { adaptiveFormats:[{itag, url, mimeType, contentLength}],
//       formats:[…] },
//     captions: { playerCaptionsTracklistRenderer: { captionTracks:[
//       { baseUrl, name, vssId, languageCode, kind } ] } }
//   }

export const captionTracksOf = (player) => {
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks)) return [];
  return tracks.map((t) => ({
    baseUrl: str(t?.baseUrl),
    languageCode: str(t?.languageCode),
    name: str(t?.name?.simpleText ?? t?.name?.runs?.[0]?.text ?? ''),
    kind: str(t?.kind), // 'asr' for auto, '' for human-uploaded
  }));
};

export const pickCaptionTrack = (tracks, preferredLang = 'en') => {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  // Prefer non-ASR human captions in preferred lang, then ASR in lang, then any.
  const pref = (lang) => (t) => t.languageCode.toLowerCase().startsWith(lang.toLowerCase());
  const nonAsr = tracks.filter((t) => t.kind !== 'asr');
  return (
    nonAsr.find(pref(preferredLang)) ||
    tracks.find(pref(preferredLang)) ||
    nonAsr[0] ||
    tracks[0]
  );
};

export const videoUrlOfPlayer = (player) => {
  const adaptive = player?.streamingData?.adaptiveFormats;
  if (Array.isArray(adaptive)) {
    // Prefer mp4 video+audio combined, smallest size that's still video.
    const mp4Combined = player?.streamingData?.formats?.find?.(
      (f) => typeof f?.url === 'string' && /video\/mp4/i.test(f?.mimeType ?? ''),
    );
    if (mp4Combined?.url) return mp4Combined.url;
    const anyVideo = adaptive.find(
      (f) => typeof f?.url === 'string' && /video\/mp4/i.test(f?.mimeType ?? ''),
    );
    if (anyVideo?.url) return anyVideo.url;
  }
  return '';
};

export const playerToPost = (player, pageScope = { kind: 'other', username: null }) => {
  const vd = player?.videoDetails ?? {};
  const nativeId = str(vd.videoId);
  if (!nativeId) return null;
  const id = ID_PREFIX + nativeId;
  const handle = pageScope.username ?? str(vd.author).replace(/^@/, '').toLowerCase();
  const cover = vd?.thumbnail?.thumbnails?.slice?.(-1)?.[0]?.url ?? '';
  const surface = pageScope.kind === 'shorts-feed' ? 'shorts-feed' : pageScope.kind;
  return {
    id,
    nativeId,
    shortcode: nativeId,
    author: handle,
    channelId: str(vd.channelId),
    desc: str(vd.shortDescription ?? vd.title ?? ''),
    title: str(vd.title),
    createTime: 0, // YouTube /player doesn't include uploadDate; needs /next or microformat
    likes: 0,
    comments: 0,
    views: num(vd.viewCount),
    shares: 0,
    saves: 0,
    durationSec: num(vd.lengthSeconds),
    mediaType: 2,
    isReel: true,
    cover: str(cover),
    videoUrl: videoUrlOfPlayer(player),
    url: nativeId ? `https://www.youtube.com/shorts/${nativeId}` : '',
    surface,
    platform: 'youtube',
    audio: null,
    audioClusterId: '',
    usertags: [],
    coauthors: [],
    location: null,
    accessibilityCaption: '',
    carouselCount: 0,
    productType: 'video',
    captionTracks: captionTracksOf(player),
  };
};

// --- /youtubei/v1/next ------------------------------------------------------
//
// Used to get likes/comments + uploadDate. Response is deeply nested; we walk
// for `likeButtonRenderer` / `dateText` / `viewCount` siblings.

// Requires at least one digit; allows surrounding/separating commas/dots/whitespace.
// Without the leading `\d` anchor, the regex would happily match a single space
// (since `\s` is in the character class) e.g. on labels like
// "like this video along with 89,432 other people".
const VIEW_COUNT_RE = /(\d[\d,.\s]*)\s*(views?|view)?/i;
const LIKE_RE = /(\d[\d,.\s]*)/;

export const enrichFromNext = (next) => {
  const out = { likes: 0, views: 0, comments: 0, uploadedAt: 0 };
  const stack = [next];
  const seen = new WeakSet();
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== 'object' || seen.has(v)) continue;
    seen.add(v);

    const lbr = v.toggleButtonRenderer || v.likeButtonRenderer;
    if (lbr?.defaultText?.accessibility?.accessibilityData?.label) {
      const m = String(lbr.defaultText.accessibility.accessibilityData.label).match(LIKE_RE);
      if (m) out.likes = parseLooseNumber(m[1]);
    }
    if (v.viewCount?.simpleText) {
      const m = String(v.viewCount.simpleText).match(VIEW_COUNT_RE);
      if (m) out.views = parseLooseNumber(m[1]);
    }
    if (v.dateText?.simpleText) {
      const t = Date.parse(String(v.dateText.simpleText));
      if (Number.isFinite(t)) out.uploadedAt = Math.floor(t / 1000);
    }

    if (Array.isArray(v)) for (const x of v) stack.push(x);
    else for (const k in v) stack.push(v[k]);
  }
  return out;
};

function parseLooseNumber(s) {
  const cleaned = String(s).replace(/[,\s]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

// --- Caption track parsing (XML transcript → text) --------------------------
//
// YouTube returns an XML doc:
//   <transcript>
//     <text start="0" dur="2.5">Hello world</text>
//     ...
//   </transcript>
//
// fmt=json3 (preferred) gives a JSON shape; we accept both.

export const parseCaptionsXml = (xml) => {
  const segments = [];
  const tagRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
  const attrRe = (name) => new RegExp(`\\b${name}="([^"]+)"`);
  let m;
  while ((m = tagRe.exec(xml))) {
    const attrs = m[1] || '';
    const startMatch = attrs.match(attrRe('start'));
    const durMatch = attrs.match(attrRe('dur'));
    const start = startMatch ? Number(startMatch[1]) || 0 : 0;
    const dur = durMatch ? Number(durMatch[1]) || 0 : 0;
    const text = decodeXmlEntities(m[2])
      .replace(/<[^>]+>/g, '')
      .trim();
    if (text) segments.push({ start, end: start + dur, text });
  }
  const fullText = segments.map((s) => s.text).join(' ').trim();
  return { fullText, segments };
};

export const parseCaptionsJson3 = (json) => {
  const events = json?.events;
  if (!Array.isArray(events)) return { fullText: '', segments: [] };
  const segments = [];
  for (const ev of events) {
    const segs = ev?.segs;
    if (!Array.isArray(segs)) continue;
    const start = (Number(ev.tStartMs) || 0) / 1000;
    const dur = (Number(ev.dDurationMs) || 0) / 1000;
    const text = segs.map((s) => String(s?.utf8 ?? '')).join('').trim();
    if (text) segments.push({ start, end: start + dur, text });
  }
  const fullText = segments.map((s) => s.text).join(' ').trim();
  return { fullText, segments };
};

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

// --- /youtubei/v1/browse (Shorts shelf or channel feed) ---------------------
//
// Best-effort harvest: looks for any object that has `videoId` + view/title
// fields, returns a partial post per match. Used for batch capture; full
// metric enrichment happens via /next + /player on click.

export const harvestBrowse = (root, pageScope = { kind: 'other', username: null }) => {
  const found = [];
  const seen = new WeakSet();
  const stack = [root];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== 'object' || seen.has(v)) continue;
    seen.add(v);
    if (v.videoId && (v.headline || v.title || v.shortBylineText)) {
      found.push(v);
      continue;
    }
    if (Array.isArray(v)) for (const x of v) stack.push(x);
    else for (const k in v) stack.push(v[k]);
  }
  return found.map((it) => browseItemToPost(it, pageScope)).filter(Boolean);
};

function browseItemToPost(it, pageScope) {
  const nativeId = str(it.videoId);
  if (!nativeId) return null;
  return {
    id: ID_PREFIX + nativeId,
    nativeId,
    shortcode: nativeId,
    author: pageScope?.username ?? '',
    desc: str(it?.title?.simpleText ?? it?.headline?.simpleText ?? it?.title?.runs?.[0]?.text ?? ''),
    title: str(it?.title?.simpleText ?? it?.headline?.simpleText ?? ''),
    likes: 0,
    comments: 0,
    views: parseLooseNumber(it?.viewCountText?.simpleText ?? '0'),
    durationSec: parseLooseNumber(it?.lengthText?.simpleText ?? '0'),
    isReel: true,
    cover: str(it?.thumbnail?.thumbnails?.slice?.(-1)?.[0]?.url ?? ''),
    videoUrl: '',
    url: `https://www.youtube.com/shorts/${nativeId}`,
    surface: pageScope?.kind ?? 'other',
    platform: 'youtube',
    audio: null,
  };
}

export const surfaceFromUrlTag = (url, tag) => {
  if (tag === 'yt-shorts' || /\/youtubei\/v1\/browse/.test(url)) return 'shorts-feed';
  if (tag === 'yt-player' || /\/youtubei\/v1\/player/.test(url)) return 'player';
  if (tag === 'yt-next' || /\/youtubei\/v1\/next/.test(url)) return 'next';
  return 'unknown';
};

export const ID_PREFIX_YT = ID_PREFIX;
