// Pure parsing helpers for TikTok web JSON.
// Same shape contract as src/lib/parser.js — exposes harvest/toPost/
// surfaceFromUrlTag/looksLikeMedia + small field accessors. No DOM, no
// chrome APIs, no global state. Safe to import from tests and from the
// runtime mirror (src/lib/platform-runtime.js) alike.

export const num = (v) => (typeof v === "number" ? v : Number(v) || 0);

const str = (v) => (v == null ? "" : String(v));

// A TikTok web "item" — looks like:
//   { id, desc, createTime, author: { uniqueId }, video: {…},
//     stats: { playCount, diggCount, commentCount, shareCount } }
export const looksLikeMedia = (o) => {
  if (!o || typeof o !== "object") return false;
  if (o.id == null) return false;
  const hasStats = !!(o.stats && typeof o.stats === "object");
  const hasVideo = !!(o.video && typeof o.video === "object");
  const hasAuthor = !!(o.author && typeof o.author === "object" && o.author.uniqueId);
  // `desc` + `createTime` are both ~always present on TT items.
  const hasShape =
    "desc" in o || "createTime" in o || "video" in o || "music" in o;
  return (hasStats || hasVideo || hasAuthor) && hasShape;
};

export const cover = (m) => {
  if (m.video?.cover) return m.video.cover;
  if (m.video?.dynamicCover) return m.video.dynamicCover;
  if (m.video?.originCover) return m.video.originCover;
  if (typeof m.cover === "string") return m.cover;
  return "";
};

export const captionText = (m) => {
  if (typeof m.desc === "string") return m.desc;
  if (typeof m.contents?.[0]?.desc === "string") return m.contents[0].desc;
  return "";
};

export const author = (m) => str(m.author?.uniqueId || m.author?.unique_id || "");

export const videoUrlOf = (m) => {
  if (typeof m.video?.playAddr === "string" && m.video.playAddr) return m.video.playAddr;
  if (typeof m.video?.downloadAddr === "string" && m.video.downloadAddr) return m.video.downloadAddr;
  if (typeof m.video?.play_addr === "string" && m.video.play_addr) return m.video.play_addr;
  return "";
};

export const likesOf = (m) => num(m.stats?.diggCount ?? m.statsV2?.diggCount);
export const commentsOf = (m) =>
  num(m.stats?.commentCount ?? m.statsV2?.commentCount);
export const viewsOf = (m) => num(m.stats?.playCount ?? m.statsV2?.playCount);
export const sharesOf = (m) => num(m.stats?.shareCount ?? m.statsV2?.shareCount);
export const savesOf = (m) =>
  num(m.stats?.collectCount ?? m.statsV2?.collectCount);

export const surfaceFromUrlTag = (url, tag) => {
  if (tag === "tt-foryou" || /\/api\/recommend\/item_list\//.test(url)) return "foryou";
  if (tag === "tt-explore" || /\/api\/explore\/item_list\//.test(url)) return "explore";
  if (tag === "tt-related" || /\/api\/related\/item_list\//.test(url)) return "related";
  if (tag === "tt-profile" || /\/api\/post\/item_list\//.test(url)) return "profile";
  return "unknown";
};

const ID_PREFIX = "tt_";

// Pick the auto-caption track from item.video.subtitleInfos[]. Prefers
// English (LanguageCodeName starting with "en"); falls back to the first
// element. Returns four parallel strings — never undefined — so the
// post schema stays stable when subtitleInfos is missing.
export const captionsOf = (m) => {
  const arr = m.video?.subtitleInfos;
  if (!Array.isArray(arr) || arr.length === 0) {
    return { captionUrl: "", captionFormat: "", captionSource: "", captionLang: "" };
  }
  const en = arr.find(
    (s) => s && typeof s.LanguageCodeName === "string" && s.LanguageCodeName.toLowerCase().startsWith("en")
  );
  const pick = en || arr[0];
  return {
    captionUrl: str(pick?.Url),
    captionFormat: str(pick?.Format).toLowerCase(),
    captionSource: str(pick?.Source),
    captionLang: str(pick?.LanguageCodeName),
  };
};

export const audioOf = (m) => {
  const mu = m.music;
  if (!mu || typeof mu !== "object") return null;
  return {
    id: str(mu.id || mu.mid || ""),
    title: str(mu.title || ""),
    artist: str(mu.authorName || mu.author || ""),
    originalAuthor: str(mu.original ? (mu.authorName || "") : ""),
    isOriginal: !!mu.original,
    useCount: 0,
    downloadUrl: typeof mu.playUrl === "string" ? mu.playUrl : "",
  };
};

// `pageScope` is passed in so this remains pure & testable.
export const toPost = (m, surface, pageScope = { kind: "other", username: null }) => {
  const nativeId = str(m.id);
  const id = nativeId.startsWith(ID_PREFIX) ? nativeId : ID_PREFIX + nativeId;
  let a = author(m);
  if (!a && pageScope.kind === "profile" && pageScope.username) {
    a = pageScope.username;
  }
  const url =
    typeof m.shareUrl === "string" && m.shareUrl
      ? m.shareUrl
      : a && nativeId
        ? `https://www.tiktok.com/@${a}/video/${nativeId}`
        : "";
  const caps = captionsOf(m);
  return {
    id,
    nativeId,
    shortcode: nativeId,
    author: a,
    desc: captionText(m),
    createTime: num(m.createTime),
    likes: likesOf(m),
    comments: commentsOf(m),
    views: viewsOf(m),
    shares: sharesOf(m),
    saves: savesOf(m),
    durationSec: num(m.video?.duration),
    mediaType: 2,
    isReel: true,
    cover: cover(m),
    videoUrl: videoUrlOf(m),
    url,
    surface,
    platform: "tiktok",
    audio: audioOf(m),
    audioClusterId: "",
    usertags: [],
    coauthors: [],
    location: null,
    accessibilityCaption: "",
    carouselCount: 0,
    productType: "video",
    captionUrl: caps.captionUrl,
    captionFormat: caps.captionFormat,
    captionSource: caps.captionSource,
    captionLang: caps.captionLang,
  };
};

export const harvest = (root, surface, pageScope) => {
  const found = [];
  const seen = new WeakSet();
  const stack = [root];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== "object") continue;
    if (seen.has(v)) continue;
    seen.add(v);
    if (looksLikeMedia(v)) {
      found.push(v);
      continue;
    }
    if (Array.isArray(v)) {
      for (const x of v) stack.push(x);
    } else {
      for (const k in v) stack.push(v[k]);
    }
  }
  return found.map((m) => toPost(m, surface, pageScope));
};
