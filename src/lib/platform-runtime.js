// Classic-script (IIFE) mirror of src/lib/platform.js for the content script.
// MV3 content scripts can't import ES modules, so the per-platform parsers
// + scope detectors are inlined here. Keep in lock-step with the ESM
// modules:
//   - src/lib/parser.js          → IG parser (richer here: includes hook,
//                                  audio, usertags, coauthors, location,
//                                  carousel/product fields)
//   - src/lib/parser-tiktok.js   → TT parser
//   - src/lib/scope.js           → IG scope
//   - src/lib/scope-tiktok.js    → TT scope
//   - src/lib/platform.js        → dispatcher
//
// Exposes window.__fsPlatform with:
//   PLATFORMS, detectPlatform(host?), getActiveConfig(),
//   getConfig(platform).
//
// Each "config" bundle is:
//   { platform, postIdPrefix, csvPrefix, downloadFolder, surfaces[],
//     scope: { deriveScope, RESERVED },
//     parser: { harvest, toPost, surfaceFromTag, looksLikeMedia },
//     postUrl(post), profileUrl(username), audioUrl(audioId) }

(function attach(global) {
  if (global.__fsPlatform) return;

  const PLATFORMS = Object.freeze({
    INSTAGRAM: "instagram",
    TIKTOK: "tiktok",
    YOUTUBE: "youtube",
  });

  const num = (v) => (typeof v === "number" ? v : Number(v) || 0);
  const str = (v) => (v == null ? "" : String(v));

  // ============ Instagram ============

  const IG_RESERVED = new Set([
    "explore","reels","direct","accounts","p","reel","stories","tv","about",
    "settings","challenge","web","api","graphql","ajax","oauth","legal",
    "press","developer",
  ]);

  const igDeriveScope = (pathname) => {
    const path = pathname || "/";
    if (path === "/explore" || path.startsWith("/explore/")) {
      return { kind: "explore", username: null };
    }
    const m = path.match(/^\/([\w.][\w.]*[\w])\/(?:reels\/?)?$/);
    if (m) {
      const u = m[1].toLowerCase();
      if (!IG_RESERVED.has(u)) return { kind: "profile", username: u };
    }
    const m2 = path.match(/^\/([\w.][\w.]*[\w])\/?$/);
    if (m2) {
      const u = m2[1].toLowerCase();
      if (!IG_RESERVED.has(u)) return { kind: "profile", username: u };
    }
    return { kind: "other", username: null };
  };

  const igLooksLikeMedia = (o) => {
    if (!o || typeof o !== "object") return false;
    const hasId = o.pk != null || o.id != null;
    if (!hasId) return false;
    const hasStat =
      "like_count" in o ||
      "play_count" in o ||
      "comment_count" in o ||
      "view_count" in o ||
      "ig_play_count" in o ||
      "edge_media_preview_like" in o ||
      "edge_liked_by" in o;
    const hasShape =
      "code" in o || "shortcode" in o || "media_type" in o || "carousel_media" in o;
    const hasMediaPayload =
      "taken_at" in o ||
      "taken_at_timestamp" in o ||
      "display_url" in o ||
      "thumbnail_url" in o ||
      "thumbnail_src" in o ||
      "video_versions" in o ||
      "video_url" in o ||
      "image_versions2" in o ||
      (Array.isArray(o.carousel_media) && o.carousel_media.length > 0) ||
      /^Graph(Image|Video|Sidecar)$/.test(String(o.__typename || ""));
    return hasShape && (hasStat || hasMediaPayload);
  };

  const igCover = (m) => {
    const v2 =
      m.image_versions2?.candidates?.[0]?.url ||
      m.image_versions?.candidates?.[0]?.url;
    if (v2) return v2;
    if (m.display_url) return m.display_url;
    if (m.thumbnail_url) return m.thumbnail_url;
    if (m.thumbnail_src) return m.thumbnail_src;
    if (m.carousel_media?.[0]) return igCover(m.carousel_media[0]);
    return "";
  };
  const igCaption = (m) => {
    if (typeof m.caption === "string") return m.caption;
    if (m.caption?.text) return m.caption.text;
    if (m.edge_media_to_caption?.edges?.[0]?.node?.text)
      return m.edge_media_to_caption.edges[0].node.text;
    return "";
  };
  const igAuthor = (m) =>
    m.user?.username ||
    m.owner?.username ||
    m.user?.user?.username ||
    m.media?.user?.username ||
    m.caption?.user?.username ||
    "";
  const igVideoUrl = (m) => {
    if (m.video_versions?.[0]?.url) return m.video_versions[0].url;
    if (typeof m.video_url === "string") return m.video_url;
    return "";
  };
  const igLikes = (m) => {
    if (typeof m.like_count === "number") return m.like_count;
    if (m.edge_media_preview_like?.count != null) return num(m.edge_media_preview_like.count);
    if (m.edge_liked_by?.count != null) return num(m.edge_liked_by.count);
    return 0;
  };
  const igComments = (m) => {
    if (typeof m.comment_count === "number") return m.comment_count;
    if (m.edge_media_to_comment?.count != null) return num(m.edge_media_to_comment.count);
    if (m.edge_media_to_parent_comment?.count != null) return num(m.edge_media_to_parent_comment.count);
    return 0;
  };
  const igViews = (m) =>
    num(m.play_count ?? m.ig_play_count ?? m.view_count ?? m.video_view_count);

  const igExtractHook = (desc) => {
    const first = String(desc || "").split("\n")[0].slice(0, 80).toLowerCase();
    return first.replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
  };

  // IG video duration. Reels expose `video_duration` (float seconds) at the
  // top level. Falls back to clips_metadata.original_sound_info.duration_in_ms
  // (audio length ≈ video length on reels), then audio_metadata.duration_in_ms.
  // Returns null when no signal is available so downstream classifiers can
  // distinguish "unknown" from "zero".
  const igDuration = (m) => {
    if (typeof m.video_duration === "number" && m.video_duration > 0) {
      return m.video_duration;
    }
    if (m.video_versions && Array.isArray(m.video_versions)) {
      for (const v of m.video_versions) {
        if (typeof v?.duration === "number" && v.duration > 0) return v.duration;
      }
    }
    const cm = m.clips_metadata;
    if (cm) {
      const osiMs = cm.original_sound_info?.duration_in_ms;
      if (typeof osiMs === "number" && osiMs > 0) return osiMs / 1000;
      const amMs = cm.audio_metadata?.duration_in_ms;
      if (typeof amMs === "number" && amMs > 0) return amMs / 1000;
    }
    return null;
  };

  const igAudio = (m) => {
    const cm = m.clips_metadata;
    if (!cm) return null;
    const osi = cm.original_sound_info;
    const mi = cm.music_info?.music_asset_info || cm.music_info;
    if (osi) {
      return {
        id: String(osi.audio_asset_id ?? osi.id ?? ""),
        title: osi.original_audio_title || "",
        artist: osi.ig_artist?.username || osi.original_audio_subtype || "",
        originalAuthor: osi.original_media_owner_username || osi.ig_artist?.username || "",
        isOriginal: true,
        useCount: num(osi.original_audio_use_count) || 0,
        downloadUrl: typeof osi.progressive_download_url === "string" ? osi.progressive_download_url : "",
      };
    }
    if (mi) {
      return {
        id: String(mi.audio_cluster_id ?? mi.id ?? ""),
        title: mi.title || mi.song_name || "",
        artist: mi.display_artist || mi.artist_name || "",
        originalAuthor: "",
        isOriginal: false,
        useCount: num(mi.use_count) || 0,
        downloadUrl: "",
      };
    }
    return null;
  };

  const igUsertags = (m) => {
    const arr = m.usertags?.in;
    if (!Array.isArray(arr)) return [];
    return arr.map((t) => t?.user?.username).filter((u) => typeof u === "string" && u.length > 0);
  };
  const igCoauthors = (m) => {
    const arr = m.coauthor_producers;
    if (!Array.isArray(arr)) return [];
    return arr.map((u) => u?.username).filter((u) => typeof u === "string" && u.length > 0);
  };
  const igLocation = (m) => {
    const l = m.location;
    if (!l || typeof l !== "object") return null;
    if (l.pk == null && l.id == null && !l.name) return null;
    return {
      id: String(l.pk ?? l.id ?? ""),
      name: l.name || l.short_name || "",
      lat: num(l.lat),
      lng: num(l.lng),
    };
  };

  const IG_ID_PREFIX = "ig_";

  const igToPost = (m, surface, pageScope) => {
    const ps = pageScope || { kind: "other", username: null };
    const native = String(m.pk ?? m.id);
    const id = native.startsWith(IG_ID_PREFIX) ? native : IG_ID_PREFIX + native;
    const shortcode = m.code || m.shortcode || "";
    const isReel =
      m.product_type === "clips" || m.media_type === 2 || surface === "reels";
    let a = igAuthor(m);
    if (!a && ps.kind === "profile" && ps.username) a = ps.username;
    const desc = igCaption(m);
    return {
      id,
      nativeId: native,
      shortcode,
      author: a,
      desc,
      hook: igExtractHook(desc),
      createTime: num(m.taken_at ?? m.taken_at_timestamp),
      likes: igLikes(m),
      comments: igComments(m),
      views: igViews(m),
      mediaType: num(m.media_type),
      isReel,
      cover: igCover(m),
      videoUrl: igVideoUrl(m),
      url: shortcode
        ? `https://www.instagram.com/${isReel ? "reel" : "p"}/${shortcode}/`
        : "",
      surface,
      platform: "instagram",
      audio: igAudio(m),
      audioClusterId: String(m.clips_metadata?.audio_ranking_info?.best_audio_cluster_id ?? ""),
      durationSec: igDuration(m),
      usertags: igUsertags(m),
      coauthors: igCoauthors(m),
      location: igLocation(m),
      accessibilityCaption: typeof m.accessibility_caption === "string" ? m.accessibility_caption : "",
      carouselCount: Array.isArray(m.carousel_media) ? m.carousel_media.length : 0,
      productType: typeof m.product_type === "string" ? m.product_type : "",
    };
  };

  const igSurfaceFromTag = (url, tag) => {
    if (tag === "ig-clips" || /\/clips\/user\//.test(url)) return "reels";
    if (tag === "ig-explore" || /\/discover\//.test(url)) return "explore";
    if (tag === "ig-feed" || /\/feed\/user\//.test(url)) return "profile";
    if (tag === "ig-graphql" || /\/(?:api\/graphql|graphql\/)/.test(url)) return "graphql";
    return "unknown";
  };

  const igHarvest = (root, surface, pageScope) => {
    const found = [];
    const seen = new WeakSet();
    const stack = [root];
    while (stack.length) {
      const v = stack.pop();
      if (!v || typeof v !== "object") continue;
      if (seen.has(v)) continue;
      seen.add(v);
      if (igLooksLikeMedia(v)) { found.push(v); continue; }
      if (v.node && igLooksLikeMedia(v.node)) { found.push(v.node); continue; }
      if (Array.isArray(v)) for (const x of v) stack.push(x);
      else for (const k in v) stack.push(v[k]);
    }
    return found.map((m) => igToPost(m, surface, pageScope));
  };

  // ============ TikTok ============

  const TT_RESERVED = new Set([
    "explore","foryou","following","live","upload","music","tag","trending",
    "discover","video","login","signup","about","embed","node","share",
    "feedback","legal","setting","creators","business","passport","api",
    "ajax","aweme","captcha","tiktokstudio",
  ]);

  const ttDeriveScope = (pathname) => {
    const path = pathname || "/";
    if (path === "/" || path === "/explore" || path.startsWith("/explore/")) {
      return { kind: "explore", username: null, videoId: null };
    }
    if (path === "/foryou" || path.startsWith("/foryou/")) {
      return { kind: "explore", username: null, videoId: null };
    }
    const m = path.match(/^\/@([\w.][\w._-]*[\w])\/?$/);
    if (m) {
      const u = m[1].toLowerCase();
      if (!TT_RESERVED.has(u)) return { kind: "profile", username: u, videoId: null };
    }
    const m2 = path.match(/^\/@([\w.][\w._-]*[\w])\/(?:video|live)\/([0-9A-Za-z_-]+)/);
    if (m2) {
      const u = m2[1].toLowerCase();
      if (!TT_RESERVED.has(u)) return { kind: "profile", username: u, videoId: m2[2] };
    }
    return { kind: "other", username: null, videoId: null };
  };

  const ttLooksLikeMedia = (o) => {
    if (!o || typeof o !== "object") return false;
    if (o.id == null) return false;
    const hasStats = !!(o.stats && typeof o.stats === "object");
    const hasVideo = !!(o.video && typeof o.video === "object");
    const hasAuthor = !!(o.author && typeof o.author === "object" && o.author.uniqueId);
    const hasShape =
      "desc" in o || "createTime" in o || "video" in o || "music" in o;
    return (hasStats || hasVideo || hasAuthor) && hasShape;
  };

  const ttCover = (m) => {
    if (m.video?.cover) return m.video.cover;
    if (m.video?.dynamicCover) return m.video.dynamicCover;
    if (m.video?.originCover) return m.video.originCover;
    if (typeof m.cover === "string") return m.cover;
    return "";
  };
  const ttCaption = (m) => {
    if (typeof m.desc === "string") return m.desc;
    if (typeof m.contents?.[0]?.desc === "string") return m.contents[0].desc;
    return "";
  };
  const ttAuthor = (m) => str(m.author?.uniqueId || m.author?.unique_id || "");
  const ttVideoUrl = (m) => {
    if (typeof m.video?.playAddr === "string" && m.video.playAddr) return m.video.playAddr;
    if (typeof m.video?.downloadAddr === "string" && m.video.downloadAddr) return m.video.downloadAddr;
    if (typeof m.video?.play_addr === "string" && m.video.play_addr) return m.video.play_addr;
    return "";
  };
  const ttLikes = (m) => num(m.stats?.diggCount ?? m.statsV2?.diggCount);
  const ttComments = (m) => num(m.stats?.commentCount ?? m.statsV2?.commentCount);
  const ttViews = (m) => num(m.stats?.playCount ?? m.statsV2?.playCount);
  const ttShares = (m) => num(m.stats?.shareCount ?? m.statsV2?.shareCount);
  const ttSaves = (m) => num(m.stats?.collectCount ?? m.statsV2?.collectCount);

  const ttCaptions = (m) => {
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

  const ttAudio = (m) => {
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

  const TT_ID_PREFIX = "tt_";

  const ttExtractHook = (desc) => {
    const first = String(desc || "").split("\n")[0].slice(0, 80).toLowerCase();
    return first.replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
  };

  const ttToPost = (m, surface, pageScope) => {
    const ps = pageScope || { kind: "other", username: null };
    const native = str(m.id);
    const id = native.startsWith(TT_ID_PREFIX) ? native : TT_ID_PREFIX + native;
    let a = ttAuthor(m);
    if (!a && ps.kind === "profile" && ps.username) a = ps.username;
    const url =
      typeof m.shareUrl === "string" && m.shareUrl
        ? m.shareUrl
        : a && native
          ? `https://www.tiktok.com/@${a}/video/${native}`
          : "";
    const desc = ttCaption(m);
    const caps = ttCaptions(m);
    return {
      id,
      nativeId: native,
      shortcode: native,
      author: a,
      desc,
      hook: ttExtractHook(desc),
      createTime: num(m.createTime),
      likes: ttLikes(m),
      comments: ttComments(m),
      views: ttViews(m),
      shares: ttShares(m),
      saves: ttSaves(m),
      durationSec: num(m.video?.duration),
      mediaType: 2,
      isReel: true,
      cover: ttCover(m),
      videoUrl: ttVideoUrl(m),
      url,
      surface,
      platform: "tiktok",
      audio: ttAudio(m),
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

  const ttSurfaceFromTag = (url, tag) => {
    if (tag === "tt-foryou" || /\/api\/recommend\/item_list\//.test(url)) return "foryou";
    if (tag === "tt-explore" || /\/api\/explore\/item_list\//.test(url)) return "explore";
    if (tag === "tt-related" || /\/api\/related\/item_list\//.test(url)) return "related";
    if (tag === "tt-profile" || /\/api\/post\/item_list\//.test(url)) return "profile";
    return "unknown";
  };

  const ttHarvest = (root, surface, pageScope) => {
    const found = [];
    const seen = new WeakSet();
    const stack = [root];
    while (stack.length) {
      const v = stack.pop();
      if (!v || typeof v !== "object") continue;
      if (seen.has(v)) continue;
      seen.add(v);
      if (ttLooksLikeMedia(v)) { found.push(v); continue; }
      if (Array.isArray(v)) for (const x of v) stack.push(x);
      else for (const k in v) stack.push(v[k]);
    }
    return found.map((m) => ttToPost(m, surface, pageScope));
  };

  // ============ YouTube ============
  // YT parser + scope live in their own runtime IIFEs (parser-youtube-runtime.js,
  // scope-youtube-runtime.js) — both registered before us in manifest.json.
  // We bind to those namespaces so the dispatcher stays in lock-step with
  // src/lib/platform.js (ESM).

  const YT_NS = global.FeedSorterYouTubeParser || {};
  const YT_SCOPE_NS = global.FeedSorterYouTubeScope || {};

  const ytDeriveScope = (pathname) =>
    typeof YT_SCOPE_NS.deriveScope === "function"
      ? YT_SCOPE_NS.deriveScope(pathname)
      : { kind: "other", username: null, videoId: null };

  // Resolve the user-facing UI surface stamped on posts. The `surface` arg
  // here comes from surfaceFromUrlTag, which returns API-endpoint tags
  // ("player", "next") for /youtubei/v1/player and /next. Those endpoints
  // don't speak for the UI surface on their own — fall back to pageScope.kind
  // (mirrors how IG /graphql is refined into "reels"/"profile"/"explore").
  const ytResolveSurface = (urlSurface, pageScope) => {
    if (urlSurface === "shorts-feed" || urlSurface === "player" || urlSurface === "next") return "shorts-feed";
    const k = pageScope?.kind;
    if (k && k !== "other") return k;
    return urlSurface || "other";
  };

  // Dispatch over the three innertube response shapes:
  //   /youtubei/v1/browse  → harvestBrowse: list of partial posts (one per shorts thumb)
  //   /youtubei/v1/player  → playerToPost: one fully-hydrated post
  //   /youtubei/v1/next    → enrichFromNext: partial post (likes/views/comments/uploadedAt)
  //                          re-shaped so ingest's Math.max merger folds it
  //                          into the row from /player.
  const ytHarvest = (root, surface, pageScope) => {
    const ps = pageScope || { kind: "other", username: null, videoId: null };
    if (!root || typeof root !== "object") return [];
    const userSurface = ytResolveSurface(surface, ps);

    if (surface === "player" && typeof YT_NS.playerToPost === "function") {
      const post = YT_NS.playerToPost(root, ps);
      if (!post) return [];
      post.surface = userSurface;
      return [post];
    }
    if (surface === "next" && typeof YT_NS.enrichFromNext === "function") {
      const enrich = YT_NS.enrichFromNext(root) || {};
      // Re-shape into a partial post keyed by the videoId in pageScope so
      // the ingest merge folds likes/views/comments/createTime onto the
      // existing row from /player.
      const nativeId = String((enrich?.videoId) || (ps?.videoId) || "");
      if (!nativeId) return [];
      return [{
        id: `yt_${nativeId}`,
        nativeId,
        shortcode: nativeId,
        author: enrich.author || ps.username || "",
        likes: num(enrich.likes),
        comments: num(enrich.comments),
        views: num(enrich.views),
        createTime: num(enrich.uploadedAt),
        isReel: true,
        cover: "",
        videoUrl: "",
        url: `https://www.youtube.com/shorts/${nativeId}`,
        surface: userSurface,
        platform: "youtube",
        audio: null,
      }];
    }
    if (typeof YT_NS.harvestBrowse === "function") {
      const posts = YT_NS.harvestBrowse(root, ps);
      // harvestBrowse stamps surface from pageScope.kind; promote to the
      // URL-tag-derived surface so /browse posts always land in the
      // "shorts-feed" bucket regardless of which page the user is on.
      for (const p of posts) p.surface = userSurface;
      return posts;
    }
    return [];
  };

  const ytSurfaceFromTag = (url, tag) =>
    typeof YT_NS.surfaceFromUrlTag === "function"
      ? YT_NS.surfaceFromUrlTag(url || "", tag || "")
      : "unknown";

  const ytLooksLikeMedia = (o) =>
    !!(o && typeof o === "object" && (o.videoId || (o.videoDetails?.videoId)));

  const ytToPost = (m, _surface, pageScope) => {
    if (!m || typeof m !== "object") return null;
    if (m.videoDetails && typeof YT_NS.playerToPost === "function") {
      return YT_NS.playerToPost(m, pageScope || { kind: "other", username: null });
    }
    return null;
  };

  // Snap-player navigation: tier-fall-through selectors used by every
  // mainstream Shorts auto-scroller (Tyson3101/Auto-Youtube-Shorts-Scroller,
  // SoRadGaming, YouTube-Enhancer, Archimetrix/Youtube-Pro-Plus).
  const YT_NEXT_BUTTON_SELECTORS = Object.freeze([
    "ytd-reel-video-renderer[is-active] #navigation-button-down button",
    "#navigation-button-down ytd-button-renderer button",
    "#navigation-button-down button",
  ]);

  const SCROLL_STRATEGY = Object.freeze({
    kind: "scroll",
    useScrollHeightStall: true,
    advance(opts) {
      const doc = (opts?.doc) || (typeof document !== "undefined" ? document : null);
      if (!doc || !doc.documentElement) return false;
      const w = doc.defaultView || (typeof window !== "undefined" ? window : null);
      if (!w || typeof w.scrollTo !== "function") return false;
      w.scrollTo(0, doc.documentElement.scrollHeight || 0);
      return true;
    },
  });

  const YT_SNAP_STRATEGY = Object.freeze({
    kind: "snap",
    useScrollHeightStall: false,
    useIdleEnd: false,
    advance(opts) {
      const doc = (opts?.doc) || (typeof document !== "undefined" ? document : null);
      if (!doc || typeof doc.querySelector !== "function") return false;
      for (const sel of YT_NEXT_BUTTON_SELECTORS) {
        const btn = doc.querySelector(sel);
        if (btn && typeof btn.click === "function" && !btn.disabled) {
          btn.click();
          return true;
        }
      }
      const w = doc.defaultView || (typeof window !== "undefined" ? window : null);
      const height = Math.max(1, (w?.innerHeight) || (doc.documentElement?.clientHeight) || 900);
      const sentArrowDown = [doc.activeElement, doc.body, doc.documentElement, w]
        .map((target) => dispatchArrowDown(target))
        .some(Boolean);
      const sentWheel = dispatchWheelDown(doc, height);
      if (w && typeof w.scrollBy === "function") {
        w.scrollBy(0, height);
        return true;
      }
      return sentArrowDown || sentWheel;
    },
  });

  const TT_NEXT_BUTTON_SELECTORS = Object.freeze([
    'button[data-e2e="arrow-right"]',
    'button[data-e2e="arrow-down"]',
    '[data-e2e="arrow-right"] button',
    '[data-e2e="arrow-down"] button',
    'button[aria-label="Go to next video"]',
    'button[aria-label="Next video"]',
    'button[aria-label="next video"]',
    'button[aria-label="Scroll down"]',
    'button[aria-label="Next"]',
    'button[title="Next"]',
    'svg path[d^="m24 27.76"]',
    'svg path[d^="M24 27.76"]',
  ]);

  const buttonForSelector = (doc, selector) => {
    const el = doc.querySelector(selector);
    if (!el) return null;
    return (el.closest?.("button")) || el;
  };

  const isDisabledButton = (btn) =>
    !!(
      !btn ||
      btn.disabled ||
      (btn.getAttribute && btn.getAttribute("aria-disabled") === "true") ||
      (btn.getAttribute && btn.getAttribute("disabled") != null)
    );

  const dispatchArrowDown = (target) => {
    if (!target || typeof target.dispatchEvent !== "function") return false;
    const KeyboardEventCtor =
      target.KeyboardEvent || (typeof KeyboardEvent !== "undefined" ? KeyboardEvent : null);
    if (!KeyboardEventCtor) return false;
    const opts = {
      key: "ArrowDown",
      code: "ArrowDown",
      keyCode: 40,
      which: 40,
      bubbles: true,
      cancelable: true,
    };
    target.dispatchEvent(new KeyboardEventCtor("keydown", opts));
    target.dispatchEvent(new KeyboardEventCtor("keyup", opts));
    return true;
  };

  const dispatchWheelDown = (doc, amount) => {
    const w = doc.defaultView || (typeof window !== "undefined" ? window : null);
    const WheelEventCtor = w?.WheelEvent ? w.WheelEvent : (typeof WheelEvent !== "undefined" ? WheelEvent : null);
    if (!WheelEventCtor) return false;
    const targets = [];
    const add = (el) => {
      if (el && typeof el.dispatchEvent === "function" && targets.indexOf(el) < 0) targets.push(el);
    };
    add(doc.activeElement);
    if (typeof doc.elementFromPoint === "function" && w) {
      add(doc.elementFromPoint(Math.floor((w.innerWidth || 1200) / 2), Math.floor((w.innerHeight || 900) / 2)));
    }
    add(doc.body);
    add(doc.documentElement);
    add(w);
    const opts = {
      deltaY: amount,
      deltaX: 0,
      deltaMode: 0,
      bubbles: true,
      cancelable: true,
      clientX: Math.floor(((w?.innerWidth) || 1200) / 2),
      clientY: Math.floor(((w?.innerHeight) || 900) / 2),
    };
    let sent = false;
    for (const target of targets) {
      target.dispatchEvent(new WheelEventCtor("wheel", opts));
      sent = true;
    }
    return sent;
  };

  const scrollTikTokContainers = (doc, amount) => {
    if (typeof doc.querySelectorAll !== "function") return false;
    const selectors = [
      '[data-e2e="recommend-list-container"]',
      '[data-e2e="recommend-list-item-container"]',
      '[data-e2e="feed-container"]',
      'main',
      '#app',
    ];
    const candidates = [];
    for (const sel of selectors) {
      const nodes = doc.querySelectorAll(sel);
      for (const el of nodes) candidates.push(el);
    }
    const all = doc.querySelectorAll("body, html, div");
    for (const el of all) {
      if (candidates.length >= 80) break;
      if (el?.classList?.contains("fs-root")) continue;
      const scrollable = ((el?.scrollHeight) || 0) > ((el?.clientHeight) || 0) + 20;
      if (scrollable) candidates.push(el);
    }
    const seen = new Set();
    for (const el of candidates) {
      if (!el || seen.has(el)) continue;
      seen.add(el);
      if (typeof el.scrollBy === "function") {
        el.scrollBy(0, amount);
        return true;
      }
      if (typeof el.scrollTop === "number") {
        el.scrollTop += amount;
        return true;
      }
    }
    return false;
  };

  const TT_SNAP_STRATEGY = Object.freeze({
    kind: "snap",
    useScrollHeightStall: false,
    useIdleEnd: false,
    advance(opts) {
      const doc = (opts?.doc) || (typeof document !== "undefined" ? document : null);
      if (!doc || typeof doc.querySelector !== "function") return false;
      let sawNextButton = false;
      for (const sel of TT_NEXT_BUTTON_SELECTORS) {
        const btn = buttonForSelector(doc, sel);
        if (!btn) continue;
        sawNextButton = true;
        if (typeof btn.click === "function" && !isDisabledButton(btn)) {
          btn.click();
          return true;
        }
      }
      if (sawNextButton) return false;
      const w = doc.defaultView || (typeof window !== "undefined" ? window : null);
      const height = Math.max(1, (w?.innerHeight) || (doc.documentElement?.clientHeight) || 900);
      const sentArrowDown = [doc.activeElement, doc.body, doc.documentElement, w]
        .map((target) => dispatchArrowDown(target))
        .some(Boolean);
      const sentWheel = dispatchWheelDown(doc, height);
      const scrolledContainer = scrollTikTokContainers(doc, height);
      if (w && typeof w.scrollBy === "function") {
        w.scrollBy(0, height);
        return true;
      }
      return sentArrowDown || sentWheel || scrolledContainer;
    },
  });

  const defaultCollectStrategy = () => SCROLL_STRATEGY;
  const ttCollectStrategy = (pageScope) =>
    pageScope && pageScope.kind === "explore" ? TT_SNAP_STRATEGY : SCROLL_STRATEGY;

  // ============ Configs ============

  const igConfig = {
    platform: PLATFORMS.INSTAGRAM,
    postIdPrefix: "ig_",
    csvPrefix: "ig",
    downloadFolder: "feed-sorter-ig",
    surfaces: ["profile", "reels", "explore", "graphql"],
    scope: { deriveScope: igDeriveScope, RESERVED: IG_RESERVED },
    parser: {
      harvest: igHarvest,
      toPost: igToPost,
      surfaceFromTag: igSurfaceFromTag,
      looksLikeMedia: igLooksLikeMedia,
    },
    collectStrategy: defaultCollectStrategy,
    postUrl: (post) => {
      if (!post) return "";
      if (post.url) return post.url;
      const sc = post.shortcode || "";
      if (!sc) return "";
      return `https://www.instagram.com/${post.isReel ? "reel" : "p"}/${sc}/`;
    },
    profileUrl: (username) =>
      username ? `https://www.instagram.com/${username}/` : "https://www.instagram.com/",
    audioUrl: (audioId) =>
      audioId ? `https://www.instagram.com/reels/audio/${encodeURIComponent(audioId)}/` : "",
  };

  const ttConfig = {
    platform: PLATFORMS.TIKTOK,
    postIdPrefix: "tt_",
    csvPrefix: "tt",
    downloadFolder: "feed-sorter-tt",
    surfaces: ["profile", "foryou", "explore", "related"],
    scope: { deriveScope: ttDeriveScope, RESERVED: TT_RESERVED },
    parser: {
      harvest: ttHarvest,
      toPost: ttToPost,
      surfaceFromTag: ttSurfaceFromTag,
      looksLikeMedia: ttLooksLikeMedia,
    },
    collectStrategy: ttCollectStrategy,
    postUrl: (post) => {
      if (!post) return "";
      if (post.url) return post.url;
      const native = String(post.nativeId || post.shortcode || post.id || "").replace(/^tt_/, "");
      const author = post.author || "";
      if (!native || !author) return "";
      return `https://www.tiktok.com/@${author}/video/${native}`;
    },
    profileUrl: (username) =>
      username ? `https://www.tiktok.com/@${username}` : "https://www.tiktok.com/",
    audioUrl: (audioId) =>
      audioId ? `https://www.tiktok.com/music/-${encodeURIComponent(audioId)}` : "",
  };

  const ytConfig = {
    platform: PLATFORMS.YOUTUBE,
    postIdPrefix: "yt_",
    csvPrefix: "yt",
    downloadFolder: "feed-sorter-yt",
    surfaces: ["profile", "shorts-feed", "search"],
    scope: { deriveScope: ytDeriveScope, RESERVED: new Set() },
    parser: {
      harvest: ytHarvest,
      toPost: ytToPost,
      surfaceFromTag: ytSurfaceFromTag,
      looksLikeMedia: ytLooksLikeMedia,
    },
    // Snap player on /shorts/<id> + /feed/shorts; classic page-scroll
    // on the channel /@handle/shorts grid + search.
    collectStrategy: (pageScope) =>
      pageScope && pageScope.kind === "shorts-feed" ? YT_SNAP_STRATEGY : SCROLL_STRATEGY,
    postUrl: (post) => {
      if (!post) return "";
      if (post.url) return post.url;
      const native = String(post.nativeId || post.shortcode || post.id || "").replace(/^yt_/, "");
      return native ? `https://www.youtube.com/shorts/${native}` : "";
    },
    profileUrl: (username) =>
      username ? `https://www.youtube.com/@${username}` : "https://www.youtube.com/",
    audioUrl: () => "",
  };

  const detectPlatform = (host, pathname) => {
    const h = String(host == null ? (global.location?.host) || "" : host).toLowerCase();
    if (/(^|\.)tiktok\.com$/.test(h)) return PLATFORMS.TIKTOK;
    if (/(^|\.)instagram\.com$/.test(h)) return PLATFORMS.INSTAGRAM;
    if (/(^|\.)youtube\.com$/.test(h)) return PLATFORMS.YOUTUBE;
    // Path-based fallback for localhost stubs.
    // YouTube wins when the path has a YT-specific shape:
    //   - /shorts/<id>, /feed/shorts            (snap player / FYP)
    //   - /@<handle>/(shorts|videos|community|playlists|featured|streams|posts)
    //   - /channel/<id>, /c/<name>, /user/<name> (legacy creator URLs)
    // Otherwise /@user or /foryou → TikTok. Localhost /explore is ambiguous
    // with IG stubs, so tests can opt into TikTok via ?platform=tiktok.
    const p = String(pathname == null ? (global.location?.pathname) || "" : pathname);
    if (/^\/shorts\//.test(p) || /^\/feed\/shorts/.test(p)) return PLATFORMS.YOUTUBE;
    if (/^\/@[\w.-]+\/(shorts|videos|community|playlists|featured|streams|posts)\b/.test(p)) {
      return PLATFORMS.YOUTUBE;
    }
    if (/^\/(channel|c|user)\/[\w.-]+/.test(p)) return PLATFORMS.YOUTUBE;
    const q = String((global.location?.search) || "").toLowerCase();
    if (/^\/@[\w.]/.test(p) || /^\/foryou/.test(p) || ((p === "/" || /^\/explore\b/.test(p)) && /(?:[?&])platform=tiktok(?:&|$)/.test(q))) {
      return PLATFORMS.TIKTOK;
    }
    return null;
  };

  const getConfig = (platform) => {
    if (platform === PLATFORMS.TIKTOK) return ttConfig;
    if (platform === PLATFORMS.INSTAGRAM) return igConfig;
    if (platform === PLATFORMS.YOUTUBE) return ytConfig;
    return null;
  };

  // The active config is locked at boot to the host the script is running on.
  // For test stubs that serve under 127.0.0.1 with IG-shaped JSON, fall back
  // to IG so existing e2e capture specs keep working.
  let activePlatform = detectPlatform();
  if (!activePlatform) activePlatform = PLATFORMS.INSTAGRAM;

  const getActiveConfig = () => getConfig(activePlatform);

  global.__fsPlatform = {
    PLATFORMS,
    detectPlatform,
    getConfig,
    getActiveConfig,
    activePlatform,
  };

  // One-shot init breadcrumb so the platform pick is visible in DevTools
  // even if the content script's logInfo() comes much later (or never,
  // on an off-feed page that aborts boot).
  try {
    const host = (global.location?.host) || "(none)";
    const path = (global.location?.pathname) || "";
    console.log(
      "%c[FS:platform]%c init platform=%s host=%s path=%s detected=%s",
      "color:#e1306c;font-weight:bold", "color:inherit",
      activePlatform, host, path,
      detectPlatform() || "null(fallback=instagram)"
    );
  } catch {}
})(typeof window !== "undefined" ? window : globalThis);
