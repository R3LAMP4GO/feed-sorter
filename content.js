// Instagram feed sorter — isolated-world content script.
// Captures profile feed, profile reels, and Explore grid responses,
// extracts media items (robust against schema drift via tree walk),
// and renders a sortable overlay.

(() => {
  if (window.__feedSorterIGBooted) return;
  window.__feedSorterIGBooted = true;

  const SOURCE = "feed-sorter";

  // -------- inject page-world hook --------
  const inject = () => {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("injected.js");
    s.async = false;
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  };
  inject();

  // -------- state --------
  // posts: hot in-memory cache. The authoritative store is IndexedDB
  // (see src/store.js). On scope change we re-populate this Map from IDB
  // for the new scope; we never clear the DB.
  /** @type {Map<string, Post>} */
  const posts = new Map();

  // Ids first observed in *this browser session*. Used by the
  // "Session vs All-time" toggle to scope the visible list.
  /** @type {Set<string>} */
  const sessionIds = new Set();

  // During detail-page snap collection (YT Shorts / TT video), keep posts from
  // videos we advance onto instead of only the URL's starting video.
  const collectionSeenVideoIds = new Set();

  // Per-post user metadata (pin/status/note/tags). Authoritative copy is in
  // IDB (store: meta); this Map is a hot read cache shared across scopes.
  /** @typedef {{ id: string, pinned: boolean, status: string|null,
   *   note: string, tags: string[], updatedAt: number }} PostMeta */
  /** @type {Map<string, PostMeta>} */
  const metaCache = new Map();

  // Pinned posts persist across scope changes (i.e. they show in the Pinned
  // section even when you nav from profile A → profile B). Loaded from IDB
  // on boot; refreshed whenever a pin toggles.
  /** @type {Map<string, Post>} */
  const pinnedPosts = new Map();

  const STATUSES = ["idea", "drafted", "posted", "skip"];
  const STATUS_RANK = { idea: 1, drafted: 2, posted: 3, skip: 4 };

  const getMetaSync = (id) => metaCache.get(String(id)) || null;
  const isPinned = (id) => !!getMetaSync(id)?.pinned;
  const hasNote = (id) => !!(getMetaSync(id)?.note || "").trim();
  const statusOf = (id) => getMetaSync(id)?.status || null;

  // Debounced autosave queues per id (for note/tags typing).
  const metaDebounce = new Map();
  const flushMetaWrite = (id) => {
    const t = metaDebounce.get(id);
    if (t) { clearTimeout(t.timer); t.fn(); metaDebounce.delete(id); }
  };
  const queueMetaWrite = (id, patch, delayMs = 500) => {
    const cur = metaCache.get(id) || { id, pinned: false, status: null, note: "", tags: [], updatedAt: 0 };
    const next = { ...cur, ...patch, id };
    metaCache.set(id, next);
    const fn = () => {
      if (!window.__fsStore) return;
      window.__fsStore.setMeta(id, patch)
        .then((merged) => {
          if (merged) metaCache.set(id, merged);
          logDebug("meta.save", { id, fields: Object.keys(patch) });
        })
        .catch((e) => logWarn("meta.save.fail", e, { id }));
    };
    const prev = metaDebounce.get(id);
    if (prev) clearTimeout(prev.timer);
    const timer = setTimeout(() => { metaDebounce.delete(id); fn(); }, delayMs);
    metaDebounce.set(id, { timer, fn });
  };

  // Immediate write (for pin toggle, status change, tag add/remove).
  const writeMetaNow = async (id, patch) => {
    const cur = metaCache.get(id) || { id, pinned: false, status: null, note: "", tags: [], updatedAt: 0 };
    const optimistic = { ...cur, ...patch, id, updatedAt: Date.now() };
    metaCache.set(id, optimistic);
    if (!window.__fsStore) return optimistic;
    try {
      const merged = await window.__fsStore.setMeta(id, patch);
      if (merged) metaCache.set(id, merged);
      return merged;
    } catch (e) {
      logWarn("meta.save.fail", e, { id });
      return optimistic;
    }
  };

  /** @typedef {{ id: string, title: string, artist: string, originalAuthor: string,
   *   isOriginal: boolean, useCount: number }} AudioInfo */
  /** @typedef {{ id: string, name: string, lat: number, lng: number }} LocationInfo */
  /** @typedef {{
   *   id: string, shortcode: string, author: string, desc: string, createTime: number,
   *   likes: number, comments: number, views: number,
   *   mediaType: number, isReel: boolean,
   *   cover: string, url: string, surface: string, videoUrl: string,
   *   firstSeenAt: number, lastSeenAt: number,
   *   audio: AudioInfo|null, audioClusterId: string,
   *   usertags: string[], coauthors: string[],
   *   location: LocationInfo|null,
   *   accessibilityCaption: string,
   *   carouselCount: number,
   *   productType: string
   * }} Post */

  // -------- platform dispatcher --------
  // window.__fsPlatform comes from src/lib/platform-runtime.js (registered
  // before this script in the manifest). It bundles the per-platform
  // parser, scope detector, URL builders, and IDB/CSV/download conventions.
  // We resolve once at boot and cache so every hot path is a property read.
  const PLATFORM = (window.__fsPlatform && window.__fsPlatform.getActiveConfig())
    || null;
  if (!PLATFORM) {
    console.error("[FS] no platform config for host", location.host, "- aborting boot");
    return;
  }
  console.log(
    "%c[FS] platform=%s host=%s",
    "color:#e1306c;font-weight:bold",
    PLATFORM.platform,
    location.host
  );
  const PLATFORM_DOWNLOAD_FOLDER = PLATFORM.downloadFolder;
  const PLATFORM_CSV_PREFIX = PLATFORM.csvPrefix;
  const PLATFORM_SOURCE = `feed-sorter-${PLATFORM_CSV_PREFIX}`;
  const PLATFORM_LABELS = Object.freeze({ instagram: "IG", tiktok: "TT", youtube: "YT" });
  const PLATFORM_LABEL = PLATFORM_LABELS[PLATFORM.platform] || PLATFORM_CSV_PREFIX.toUpperCase();

  // -------- tier gate --------
  // Surfaces Pro-only features (transcription, Explore-page overlay). The
  // runtime mirror in src/lib/tier-gate-runtime.js caches the tier so this
  // is a sync truth-table check — fast enough to call once per row.
  const proAccess = () => {
    const tg = globalThis.FeedSorterTierGate;
    return tg ? !!tg.isPro() : false;
  };

  // -------- page scope --------
  // What page are we on? Drives ingest filtering + auto-collect gating.
  // Updated on SPA navs via patched history methods + popstate.
  /** @type {{ kind: "profile"|"explore"|"other", username: string|null }} */
  let pageScope = { kind: "other", username: null };

  const deriveScope = () => PLATFORM.scope.deriveScope(location.pathname || "/");

  // Per-session memo of usernames whose profile we've already requested
  // from injected.js. Prevents re-firing the fetch on every tab focus /
  // SPA back-nav. Page reload clears it (correct — we might want fresh bio).
  const profileFetched = new Set();
  const maybeFetchProfileInfo = () => {
    if (pageScope.kind !== "profile" || !pageScope.username) return;
    const u = String(pageScope.username).toLowerCase();
    if (profileFetched.has(u)) return;
    profileFetched.add(u);
    try {
      window.postMessage({
        source: SOURCE,
        kind: "fetch-profile",
        platform: PLATFORM.platform,
        username: u,
      }, "*");
      logInfo("profile.fetch.request", { username: u, platform: PLATFORM.platform });
    } catch (e) {
      logWarn("profile.fetch.request.fail", e, { username: u });
    }
  };

  const onScopeMaybeChanged = () => {
    const next = deriveScope();
    if (next.kind === pageScope.kind && next.username === pageScope.username && next.videoId === pageScope.videoId) return;
    const old = { ...pageScope };
    const onlyDetailVideoChanged =
      collector.running &&
      old.kind === next.kind &&
      old.username === next.username &&
      old.videoId !== next.videoId;
    pageScope = next;
    // Don't wipe IDB. Just drop the rendered/in-memory view; we'll rehydrate
    // for the new scope below. During snap collection, changing from one
    // short/video URL to the next is expected and must not abort the collector.
    if (!onlyDetailVideoChanged) {
      posts.clear();
    }
    if (onlyDetailVideoChanged && next.videoId) collectionSeenVideoIds.add(String(next.videoId));
    collector.abort = collector.running && !onlyDetailVideoChanged ? true : false;
    collector.reason = null;
    logInfo("scope.change", { from: old, to: pageScope, path: location.pathname, collectorRunning: collector.running, onlyDetailVideoChanged });
    updateHeader();
    render();
    setStatus(pageScope.kind === "other" ? "idle (off-feed page)" : "idle");
    // Rehydrate from IDB for the new scope (or all-time if toggle is set).
    rehydrateFromStore().catch((e) => logError("store.rehydrate.fail", e));
    // Trigger an explicit profile-info fetch so the bio cascade has data
    // to embed. No-op on non-profile pages.
    maybeFetchProfileInfo();
  };

  // SPA nav detection: monkey-patch history (guarded) + popstate.
  if (!window.__feedSorterHistoryPatched) {
    window.__feedSorterHistoryPatched = true;
    const wrap = (name) => {
      const orig = history[name];
      if (typeof orig !== "function") return;
      history[name] = function (...args) {
        const r = orig.apply(this, args);
        try { window.dispatchEvent(new Event("feed-sorter:locationchange")); } catch {}
        return r;
      };
    };
    wrap("pushState");
    wrap("replaceState");
    window.addEventListener("popstate", () => {
      window.dispatchEvent(new Event("feed-sorter:locationchange"));
    });
  }
  window.addEventListener("feed-sorter:locationchange", onScopeMaybeChanged);
  if (PLATFORM.platform === "youtube") {
    const onYouTubeNavigate = () => setTimeout(() => {
      try { window.dispatchEvent(new Event("feed-sorter:locationchange")); } catch {}
      try { hydrateVisibleYouTubeShortFromDom("yt-navigate"); } catch {}
    }, 0);
    window.addEventListener("yt-navigate", onYouTubeNavigate);
    window.addEventListener("yt-navigate-finish", onYouTubeNavigate);
    window.addEventListener("yt-page-data-updated", onYouTubeNavigate);
  }

  // -------- parser: delegated to the platform config --------
  // The actual parser (looksLikeMedia / cover / toPost / harvest) lives in
  // src/lib/platform-runtime.js, keyed off the active host. Hot-path
  // wrappers below let callers stay terse.

  const num = (v) => (typeof v === "number" ? v : Number(v) || 0);

  const platformParser = PLATFORM.parser;
  const surfaceFromUrlTag = (url, tag) =>
    platformParser.surfaceFromTag(url || "", tag || "");
  const harvestPosts = (root, surface) =>
    platformParser.harvest(root, surface, pageScope);
  const authorMergeScore = (value) => {
    const a = String(value || "").trim();
    if (!a) return 0;
    let score = 1;
    if (/^[A-Za-z0-9._-]+$/.test(a) && !/\s/.test(a)) score += 1;
    if (/[_.-]/.test(a)) score += 1;
    return score;
  };
  const pickAuthor = (prevAuthor, nextAuthor) =>
    authorMergeScore(nextAuthor) >= authorMergeScore(prevAuthor) ? (nextAuthor || prevAuthor || "") : (prevAuthor || nextAuthor || "");
  const canonicalNativeId = (post) => String(post?.nativeId || post?.shortcode || post?.id || "").replace(/^(ig|tt|yt)_/, "");
  const isYouTubePost = (post) => post?.platform === "youtube" || /^yt_/.test(String(post?.id || ""));
  const COUNT_TOKEN_RE = /(\d[\d,.\s]*\d|\d)(?:\s*([kmb]|thousand|million|billion))?/i;
  const suffixToMultiplier = (suffix) => {
    const s = String(suffix || "").toLowerCase();
    if (s === "k" || s === "thousand") return 1_000;
    if (s === "m" || s === "million") return 1_000_000;
    if (s === "b" || s === "billion") return 1_000_000_000;
    return 1;
  };
  const parseHumanCount = (value) => {
    const raw = String(value || "").replace(/\u00a0/g, " ").trim();
    if (!/\d/.test(raw)) return 0;
    const match = raw.match(COUNT_TOKEN_RE);
    if (!match) return 0;
    let token = String(match[1] || "").replace(/\s+/g, "");
    const hasSuffix = !!match[2];
    const hasComma = token.includes(",");
    const hasDot = token.includes(".");
    if (hasComma && hasDot) {
      const lastComma = token.lastIndexOf(",");
      const lastDot = token.lastIndexOf(".");
      const decimalSep = lastComma > lastDot ? "," : ".";
      const decimalDigits = token.length - Math.max(lastComma, lastDot) - 1;
      if (!hasSuffix && decimalDigits === 3) token = token.replace(/[,.]/g, "");
      else if (decimalSep === ",") token = token.replace(/\./g, "").replace(",", ".");
      else token = token.replace(/,/g, "");
    } else if (hasComma || hasDot) {
      const sep = hasComma ? "," : ".";
      const parts = token.split(sep);
      const last = parts[parts.length - 1] || "";
      token = (parts.length > 2 || last.length === 3) ? parts.join("") : parts.join(".");
    }
    const base = Number(token);
    return Number.isFinite(base) ? Math.round(base * suffixToMultiplier(match[2])) : 0;
  };
  const activeYouTubeShortRoot = (doc = document) => {
    if (PLATFORM.platform !== "youtube" || !doc?.querySelector) return null;
    return doc.querySelector("ytd-reel-video-renderer[is-active]") ||
      doc.querySelector("ytd-reel-video-renderer[is-active='true']") ||
      doc.querySelector("ytd-shorts ytd-reel-video-renderer") ||
      doc.querySelector("ytd-reel-video-renderer");
  };
  const textPartsForElement = (el) => {
    if (!el) return [];
    const parts = [];
    const add = (v) => { if (v) parts.push(String(v)); };
    add(el.getAttribute?.("aria-label"));
    add(el.getAttribute?.("title"));
    add(el.getAttribute?.("aria-description"));
    add(el.textContent);
    const button = el.closest?.("button,[role='button']");
    if (button && button !== el) {
      add(button.getAttribute?.("aria-label"));
      add(button.getAttribute?.("title"));
      add(button.textContent);
    }
    return parts;
  };
  const metricFromElements = (root, selectors, keywordRe, excludeRe) => {
    if (!root?.querySelectorAll) return 0;
    const nodes = [];
    for (const selector of selectors) {
      try { root.querySelectorAll(selector).forEach((node) => nodes.push(node)); } catch {}
    }
    let out = 0;
    for (const node of nodes) {
      const idClass = `${node.id || ""} ${node.className || ""}`;
      const parts = textPartsForElement(node);
      const haystack = `${idClass} ${parts.join(" ")}`;
      if (excludeRe && excludeRe.test(haystack)) continue;
      if (!keywordRe.test(haystack)) continue;
      for (const part of parts) out = Math.max(out, parseHumanCount(part));
    }
    return out;
  };
  const scrapeYouTubeShortMetricsFromDom = (doc = document) => {
    const root = activeYouTubeShortRoot(doc);
    if (!root) return { likes: 0, comments: 0, views: 0 };
    return {
      likes: metricFromElements(root, [
        "#like-button",
        "#like-button button",
        "like-button-view-model",
        "like-button-view-model button",
        "segmented-like-dislike-button-view-model button",
        "button[aria-label*='Like' i]",
        "[aria-label*='Like this video' i]",
      ], /\blikes?\b|like-button|like this video|other people/i, /\bdislike\b/i),
      comments: metricFromElements(root, [
        "#comments-button",
        "#comments-button button",
        "ytd-button-renderer#comments-button",
        "ytd-button-renderer#comments-button button",
        "button[aria-label*='comment' i]",
        "[aria-label*='comment' i]",
      ], /\bcomments?\b|comments-button/i),
      views: metricFromElements(root, [
        "[aria-label*='view' i]",
        "[title*='view' i]",
        "#metadata-line span",
      ], /\bviews?\b/i),
    };
  };
  const hydrateVisibleYouTubeShortFromDom = (reason = "") => {
    if (PLATFORM.platform !== "youtube" || pageScope.kind !== "shorts-feed") return 0;
    const nativeId = pageScope.videoId || deriveScope().videoId;
    if (!nativeId) return 0;
    const id = `yt_${nativeId}`;
    const prev = posts.get(id);
    if (!prev) return 0;
    const metrics = scrapeYouTubeShortMetricsFromDom();
    const patch = {
      platform: "youtube",
      surface: "shorts-feed",
      isReel: true,
      nativeId: prev.nativeId || nativeId,
      shortcode: prev.shortcode || nativeId,
    };
    if (metrics.likes > (prev.likes || 0)) patch.likes = metrics.likes;
    if (metrics.comments > (prev.comments || 0)) patch.comments = metrics.comments;
    if (metrics.views > (prev.views || 0)) patch.views = metrics.views;
    const changed = Object.entries(patch).some(([key, value]) => prev[key] !== value);
    if (!changed) return 0;
    const merged = { ...prev, ...patch, lastSeenAt: Date.now() };
    posts.set(id, merged);
    sessionIds.add(id);
    if (window.__fsStore) {
      window.__fsStore.bulkUpsert([merged])
        .then((rows) => {
          const canonical = rows && rows[0];
          if (canonical?.id) posts.set(canonical.id, { ...posts.get(canonical.id), ...canonical });
        })
        .catch((e) => logWarn("youtube.dom-hydrate.store.fail", e, { id }));
    }
    logInfo("youtube.dom-hydrate", { id, reason, likes: merged.likes || 0, comments: merged.comments || 0, views: merged.views || 0 });
    render();
    return 1;
  };
  const isCurrentDetailVideo = (post) => {
    if (!pageScope.videoId) return true;
    const native = canonicalNativeId(post);
    if (!native) return false;
    if (native === String(pageScope.videoId)) return true;
    return collector.running && collectionSeenVideoIds.has(native);
  };
  const isSingleVideoHydrationSurface = (surface) => surface === "player" || surface === "next";
  const shouldKeepDetailVideoPost = (post, surface) => {
    if (!pageScope.videoId) return true;
    if (isCurrentDetailVideo(post)) return true;
    const native = canonicalNativeId(post);
    if (collector.running && native && isSingleVideoHydrationSurface(surface)) {
      collectionSeenVideoIds.add(native);
      logInfo("ingest.collector-hydration.accept", {
        platform: PLATFORM.platform,
        scopeVideoId: pageScope.videoId || null,
        postNativeId: native,
        postId: post.id || null,
        surface,
        path: location.pathname,
      });
      return true;
    }
    return false;
  };

  // Hook = normalized first line of the caption, max 80 chars, lowercased
  // and with non-word/space chars stripped. Used to detect cross-creator
  // hook reuse via trigram-Jaccard similarity.
  const extractHook = (desc) => {
    const first = String(desc || "").split("\n")[0].slice(0, 80).toLowerCase();
    return first.replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
  };
  const hookTrigrams = (s) => {
    const t = `  ${String(s || "")}  `;
    const out = new Set();
    if (t.length < 3) return out;
    for (let i = 0; i <= t.length - 3; i++) out.add(t.slice(i, i + 3));
    return out;
  };
  const hookJaccard = (a, b) => {
    if (!a || !b || !a.size || !b.size) return 0;
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    let inter = 0;
    for (const x of small) if (big.has(x)) inter++;
    const uni = a.size + b.size - inter;
    return uni ? inter / uni : 0;
  };

  // IG's profile-reels tab and modern profile feed both come through
  // /graphql/query, which surfaceFromUrlTag tags generically as "graphql".
  // Promote that to the real bucket using the live URL + page scope so the
  // surface dropdown ("reels" / "profile" / "explore") actually matches.
  const refineSurface = (surface) => {
    if (surface !== "graphql") return surface;
    const path = (location && location.pathname) || "";
    if (/\/reels\/?$/.test(path)) return "reels";
    if (pageScope.kind === "profile") return "profile";
    if (pageScope.kind === "explore") return "explore";
    return surface;
  };

  const ingest = (raw, url, tag) => {
    let json;
    try { json = JSON.parse(raw); } catch { return 0; }
    const surface = refineSurface(surfaceFromUrlTag(url || "", tag || ""));
    const items = harvestPosts(json, surface);
    let added = 0;
    let droppedScope = 0;
    const toPersist = [];
    const now = Date.now();
    for (const p of items) {
      if (!p.id) continue;
      // Scope filter
      if (pageScope.kind === "other") { droppedScope++; continue; }
      if (!shouldKeepDetailVideoPost(p, surface)) {
        droppedScope++;
        logInfo("ingest.current-video.drop", {
          platform: PLATFORM.platform,
          scopeVideoId: pageScope.videoId || null,
          postNativeId: canonicalNativeId(p) || null,
          postId: p.id || null,
          surface: p.surface || null,
          path: location.pathname,
        });
        continue;
      }
      if (pageScope.kind === "profile" && p.author && pageScope.username &&
          p.author.toLowerCase() !== pageScope.username) {
        droppedScope++;
        continue;
      }
      const prev = posts.get(p.id);
      let merged;
      if (prev) {
        merged = {
          ...prev,
          ...p,
          likes: Math.max(prev.likes, p.likes),
          comments: Math.max(prev.comments, p.comments),
          views: Math.max(prev.views, p.views),
          desc: p.desc || prev.desc,
          cover: prev.cover || p.cover,
          author: pickAuthor(prev.author, p.author),
          videoUrl: p.videoUrl || prev.videoUrl,
          platform: isYouTubePost(prev) || isYouTubePost(p) ? "youtube" : (p.platform || prev.platform),
          surface: isYouTubePost(prev) || isYouTubePost(p) ? "shorts-feed" : (p.surface || prev.surface),
          // Preserve snapshots; canonical update arrives via the IDB callback below.
          snapshots: prev.snapshots || [],
          firstSeenAt: prev.firstSeenAt || now,
          lastSeenAt: now,
        };
      } else {
        merged = {
          ...p,
          platform: isYouTubePost(p) ? "youtube" : p.platform,
          surface: isYouTubePost(p) ? "shorts-feed" : p.surface,
          snapshots: [{ capturedAt: now, views: p.views || 0, likes: p.likes || 0, comments: p.comments || 0 }],
          firstSeenAt: now,
          lastSeenAt: now,
        };
        added++;
      }
      posts.set(p.id, merged);
      sessionIds.add(p.id);
      toPersist.push(merged);
      // Auto-tag posts collected from the Explore surface so users can
      // tell at a glance where a row originated. Idempotent: only writes
      // when the tag isn't already present in cached meta.
      if (merged.surface === "explore") {
        const curMeta = metaCache.get(p.id) || { tags: [] };
        const curTags = curMeta.tags || [];
        if (!curTags.includes("explore")) {
          writeMetaNow(p.id, { tags: [...curTags, "explore"] });
        }
      }
    }
    if (droppedScope) logInfo("ingest.dropped", { scope: pageScope.kind, videoId: pageScope.videoId || null, dropped: droppedScope });
    // Queue any newly-ingested posts for cross-creator hook-similarity scan.
    if (toPersist.length) queueHookScan(toPersist.map((p) => p.id));
    // Write-through to IDB. After the merge resolves, copy the canonical
    // (post-merge) rows back into the in-memory Map — this corrects fields
    // like firstSeenAt when an ingest races a not-yet-finished rehydrate.
    if (toPersist.length && window.__fsStore) {
      // Side-channel: upsert audio aggregates for any reels with sound.
      const audioPosts = toPersist.filter((p) => p.isReel && p.audio && p.audio.id);
      if (audioPosts.length) {
        window.__fsStore.bulkUpsertAudio(audioPosts)
          .then((n) => { if (n) logDebug("audio.upsert", { n }); })
          .catch((e) => logWarn("audio.upsert.fail", e));
      }
      window.__fsStore.bulkUpsert(toPersist)
        .then((merged) => {
          let corrected = 0;
          for (const m of merged || []) {
            if (!m || !m.id) continue;
            const cur = posts.get(m.id);
            if (!cur) { posts.set(m.id, m); continue; }
            const snapsChanged =
              (cur.snapshots?.length || 0) !== (m.snapshots?.length || 0);
            if (cur.firstSeenAt !== m.firstSeenAt || cur.lastSeenAt !== m.lastSeenAt || snapsChanged) {
              posts.set(m.id, {
                ...cur,
                firstSeenAt: m.firstSeenAt,
                lastSeenAt: m.lastSeenAt,
                snapshots: m.snapshots || cur.snapshots || [],
              });
              corrected++;
            }
          }
          if (corrected) render();
        })
        .catch((e) => logError("store.upsert.fail", e));
    }
    if (items.length) {
      if (PLATFORM.platform === "youtube") hydrateVisibleYouTubeShortFromDom("ingest");
      render();
    }
    return added;
  };

  // Bridge messages from the background service worker (auto-rescrape).
  // bg sends `start-collect`; we acknowledge `ping` so it knows the overlay
  // is up; we emit `collect.end` (see startCollect) so it knows when to
  // close the hidden tab.
  let bgRescrapeActive = false;
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || msg.type !== "fs-bg") return;
      if (msg.cmd === "ping") {
        sendResponse({ ok: true, scope: pageScope });
        return; // sync response
      }
      if (msg.cmd === "start-collect") {
        bgRescrapeActive = true;
        logInfo("bg.start-collect", { scope: pageScope });
        startCollect("background");
        sendResponse({ ok: true });
        return;
      }
      if (msg.cmd === "stop-collect") {
        stopCollect("background");
        sendResponse({ ok: true });
        return;
      }
    });
    // Popup-initiated sync: the popup has no access to this page's IDB,
    // so it asks the active tab to do the read + dispatch.
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || msg.type !== "fs-popup") return;
      if (msg.cmd === "sync-from-page") {
        const storeRef = (typeof window !== "undefined" && window.__fsStore) || null;
        const read = storeRef && typeof storeRef.getAll === "function"
          ? storeRef.getAll()
          : Promise.resolve([]);
        read
          .then((rows) => {
            const all = Array.isArray(rows) ? rows : [];
            if (!all.length) {
              sendResponse({ ok: false, err: "empty store — collect first" });
              return;
            }
            chrome.runtime.sendMessage(
              { type: "fs-bg", cmd: "api.sync-posts", posts: all },
              (r) => {
                if (chrome.runtime.lastError) {
                  sendResponse({ ok: false, err: chrome.runtime.lastError.message });
                  return;
                }
                sendResponse(r || { ok: false, err: "no response" });
              },
            );
          })
          .catch((err) => sendResponse({ ok: false, err: String(err && err.message || err) }));
        return true; // async response
      }
    });
  } catch (e) {
    // chrome.runtime can be undefined when the extension context is
    // invalidated (e.g. mid-reload). Non-fatal.
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.source !== SOURCE) return;
    if (data.kind === "feed-response" && typeof data.body === "string") {
      const before = posts.size;
      const surface = refineSurface(surfaceFromUrlTag(data.url, data.tag));
      // Profile-info branch (bio-first niche cascade). IG `web_profile_info`
      // and TT `api/user/detail` carry just the user object — no items —
      // so we route to profile-parser-runtime.js and persist bio/category/
      // externalUrl/fullName on the matching creators row. The cascade in
      // background.js (clusterNiches) reads these fields next pass and
      // picks `bio` as the embedding source when present + rich enough.
      const PP = globalThis.__fsProfileParser;
      if (PP && (PP.isInstagramProfileInfoUrl(data.url) || PP.isTikTokProfileInfoUrl(data.url))) {
        try {
          const parsed = PP.parseProfile(JSON.parse(data.body), data.url);
          if (parsed && parsed.username && window.__fsStore && window.__fsStore.addCreator) {
            const at = Date.now();
            // Category-as-niche shortcut: IG business accounts carry a
            // category_name ("Real Estate Agent", "Fitness Trainer", etc.)
            // that's a better niche label than anything we'd cluster from
            // captions. Use it directly. _autoNiche=true so this never
            // overrides a label the user manually pinned.
            const patch = {
              bio: parsed.bio || "",
              category: parsed.category || "",
              fullName: parsed.fullName || "",
              externalUrl: parsed.externalUrl || "",
              bioCapturedAt: at,
            };
            if (parsed.category) {
              patch.niche = parsed.category;
              patch._autoNiche = true;
            }
            window.__fsStore.addCreator(parsed.username, patch).then(async () => {
              const bioSnippet = (parsed.bio || "").slice(0, 80);
              logInfo("profile.capture", {
                username: parsed.username,
                platform: parsed.platform,
                bioWords: PP.nicheTextWordCount(PP.profileToNicheText(parsed)),
                category: parsed.category || null,
                bioSnippet,
                externalUrl: parsed.externalUrl || null,
                followerCount: parsed.followerCount,
                fullName: parsed.fullName || null,
              });
              if (parsed.category) {
                // Backfill: stamp niche on every existing post by this
                // creator. renderStats reads post.niche, not creator.niche,
                // so without this the NICHES chip stays "No labels yet."
                // nicheBasis "author" = inherited from the creator-level
                // signal (bio/category), per store.js NICHE_BASES.
                let backfilled = 0;
                try {
                  const myPosts = await window.__fsStore.getByAuthor(parsed.username);
                  for (const p of myPosts) {
                    if (!p || !p.id) continue;
                    // Don't clobber a post.niche that was set by the
                    // post-level pipeline (more specific than creator-level).
                    if (typeof p.niche === "string" && p.niche) continue;
                    try { await window.__fsStore.setPostNiche(p.id, parsed.category, "author"); backfilled++; }
                    catch (e) { logWarn("niche.backfill.post.fail", e, { id: p.id }); }
                  }
                } catch (e) { logWarn("niche.backfill.read.fail", e, { username: parsed.username }); }
                logInfo("niche.set-from-category", {
                  username: parsed.username,
                  niche: parsed.category,
                  source: "ig-category",
                  postsBackfilled: backfilled,
                });
                // Repaint the overlay so the NICHES section flips from
                // "No niche labels yet" to the new chip immediately.
                try { typeof reloadCreators === "function" && reloadCreators(); } catch { /* not in scope yet */ }
                try { typeof render === "function" && render(); } catch { /* boot race */ }
              }
            }).catch((e) => logWarn("profile.capture.fail", e, { username: parsed.username }));
          } else if (!parsed) {
            logWarn("profile.parse.empty", { url: String(data.url || "").slice(0, 120) });
          }
        } catch (e) {
          logWarn("profile.parse.fail", e, { url: String(data.url || "").slice(0, 120) });
        }
        return;
      }
      // Always log the response arrival so users can diagnose "0 posts"
      // states (e.g. wrong scope, parser missing items, off-feed page).
      const urlTail = String(data.url || "").replace(/^https?:\/\/[^/]+/, "").slice(0, 120);
      let parsed = 0;
      try { parsed = harvestPosts(JSON.parse(data.body), surface).length; } catch {}
      ingest(data.body, data.url, data.tag);
      const added = posts.size - before;
      const payload = {
        platform: PLATFORM.platform,
        surface,
        tag: data.tag || "",
        url: urlTail,
        parsed,
        added,
        total: posts.size,
        scope: pageScope.kind,
      };
      if (added > 0) logInfo("capture", payload);
      else if (parsed === 0) logWarn("ingest.empty", payload);
      else logInfo("ingest.no-new", payload);
      return;
    }
    if (data.kind === "cmd") {
      if (data.cmd === "start-collect") startCollect("console");
      else if (data.cmd === "stop-collect") stopCollect("console");
      else if (data.cmd === "set-filter" && data.key in state) {
        const old = state[data.key];
        state[data.key] = data.key === "limit" ? Number(data.value) : data.value;
        logInfo("filter.change", { key: data.key, from: old, to: state[data.key], via: "console" });
        const sel = els.root?.querySelector(`[data-ctl="${data.key}"]`);
        if (sel) sel.value = String(state[data.key]);
        render();
      } else if (data.cmd === "get-posts") {
        window.postMessage(
          { source: SOURCE, kind: "reply", id: data.id, posts: [...posts.values()] },
          "*"
        );
      }
    }
  });

  // -------- logger --------
  // In-memory ring buffer feeds the overlay panel. Authoritative log history
  // lives in IndexedDB (db: feed-sorter-logs, store: logs) capped at
  // LOG_DB_MAX entries with autoincrement keys + indexes on t and event.
  const LOG_BUF = [];
  const LOG_BUF_MAX = 200;
  const LOG_DB_MAX = 5000;
  const LOG_DB_NAME = "feed-sorter-logs";
  const LOG_DB_VERSION = 1;
  const LOG_STORE = "logs";
  const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
  const LOG_LEVEL_TAG = { debug: "D", info: "I", warn: "W", error: "E" };

  // Normalize an Error or arbitrary data payload, lifting Error.stack.
  const enrichErr = (errOrData, extra) => {
    if (errOrData instanceof Error) {
      return { err: String(errOrData), stack: errOrData.stack || "", ...(extra || {}) };
    }
    if (typeof errOrData === "string") {
      return { err: errOrData, ...(extra || {}) };
    }
    if (errOrData && typeof errOrData === "object") {
      // If a plain payload contains an `err` field that is an Error, lift its stack.
      const out = { ...errOrData, ...(extra || {}) };
      if (out.err instanceof Error) {
        out.stack = out.err.stack || "";
        out.err = String(out.err);
      }
      return out;
    }
    return { ...(extra || {}) };
  };

  const log = (event, data = {}, level = "info") => {
    if (!LOG_LEVELS[level]) level = "info";
    // If `data` is an Error, lift stack regardless of level.
    const payload = (data instanceof Error)
      ? enrichErr(data)
      : (data && typeof data === "object" && data.err instanceof Error)
        ? enrichErr(data)
        : data;
    const entry = { t: Date.now(), level, event, ...payload };
    LOG_BUF.push(entry);
    if (LOG_BUF.length > LOG_BUF_MAX) LOG_BUF.shift();
    const tag = `[FS:${LOG_LEVEL_TAG[level]}]`;
    const fn = level === "error" ? console.error
             : level === "warn" ? console.warn
             : level === "debug" ? console.debug
             : console.log;
    try { fn(tag, event, JSON.stringify(payload)); } catch { console.log(tag, event); }
    try {
      window.dispatchEvent(new CustomEvent("feed-sorter:log", { detail: entry }));
      window.postMessage({ source: SOURCE, kind: "log", entry }, "*");
    } catch {}
    queuePersist(entry);
    if (els.logPanel) renderLog();
  };
  const logDebug = (event, data) => log(event, data, "debug");
  const logInfo  = (event, data) => log(event, data, "info");
  const logWarn  = (event, errOrData, extra) => log(event, enrichErr(errOrData, extra), "warn");
  const logError = (event, errOrData, extra) => log(event, enrichErr(errOrData, extra), "error");

  // -------- log persistence (IndexedDB) --------
  // Async write queue. log() never awaits; entries flush in microtask batches.
  /** @type {Promise<IDBDatabase>|null} */
  let logDbPromise = null;
  const openLogDb = () => {
    if (logDbPromise) return logDbPromise;
    if (!globalThis.idb || typeof globalThis.idb.openDB !== "function") {
      logDbPromise = Promise.reject(new Error("idb UMD not loaded"));
      return logDbPromise;
    }
    logDbPromise = globalThis.idb.openDB(LOG_DB_NAME, LOG_DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(LOG_STORE)) {
          const os = db.createObjectStore(LOG_STORE, { keyPath: "_k", autoIncrement: true });
          os.createIndex("by_t", "t");
          os.createIndex("by_event", "event");
        }
      },
    });
    return logDbPromise;
  };

  const persistQueue = [];
  let persistFlushScheduled = false;
  // Trim only every N writes — prune is O(N) and rarely needs to run on each entry.
  let writesSinceTrim = 0;
  const TRIM_EVERY = 200;

  const queuePersist = (entry) => {
    persistQueue.push(entry);
    if (persistFlushScheduled) return;
    persistFlushScheduled = true;
    // Microtask: never blocks the calling code path.
    Promise.resolve().then(flushPersist).catch((e) => {
      try { console.warn("[FS:W] log.persist.fail", String(e)); } catch {}
    });
  };

  const flushPersist = async () => {
    persistFlushScheduled = false;
    if (!persistQueue.length) return;
    const batch = persistQueue.splice(0, persistQueue.length);
    let db;
    try { db = await openLogDb(); } catch { return; }
    try {
      const tx = db.transaction(LOG_STORE, "readwrite");
      const os = tx.objectStore(LOG_STORE);
      for (const e of batch) os.add(e);
      await tx.done;
      writesSinceTrim += batch.length;
      if (writesSinceTrim >= TRIM_EVERY) {
        writesSinceTrim = 0;
        trimLogStore(db).catch(() => {});
      }
    } catch (e) {
      try { console.warn("[FS:W] log.persist.fail", String(e)); } catch {}
    }
  };

  // Cap the store at LOG_DB_MAX rows by deleting oldest keys (autoincrement
  // keys are monotonic, so cursor.openKeyCursor in default direction = oldest first).
  const trimLogStore = async (db) => {
    const count = await db.count(LOG_STORE);
    if (count <= LOG_DB_MAX) return;
    const toDelete = count - LOG_DB_MAX;
    const tx = db.transaction(LOG_STORE, "readwrite");
    const os = tx.objectStore(LOG_STORE);
    let cursor = await os.openKeyCursor();
    let deleted = 0;
    while (cursor && deleted < toDelete) {
      await os.delete(cursor.key);
      deleted++;
      cursor = await cursor.continue();
    }
    await tx.done;
  };

  const readAllPersistedLogs = async () => {
    let db;
    try { db = await openLogDb(); } catch { return []; }
    try {
      const all = await db.getAll(LOG_STORE);
      // Sorted by autoincrement key already (insertion order), but also
      // sort by t for safety in case of clock-skew across navigations.
      all.sort((a, b) => (a.t || 0) - (b.t || 0));
      return all;
    } catch { return []; }
  };

  // Best-effort drain on unload.
  window.addEventListener("pagehide", () => { try { flushPersist(); } catch {} });

  window.__feedSorter = window.__feedSorter || {};
  window.__feedSorter.getLog = () => LOG_BUF.slice();
  window.__feedSorter.getPosts = () => [...posts.values()];
  window.__feedSorter.getScope = () => ({ ...pageScope });
  window.__feedSorter.readPersistedLogs = readAllPersistedLogs;
  window.__feedSorter.flushLogs = flushPersist;
  // Public log namespace — consumers can call window.__feedSorter.log.error(...)
  // and benefit from the same Error-stack capture as internal call sites.
  window.__feedSorter.log = {
    debug: logDebug,
    info: logInfo,
    warn: logWarn,
    error: logError,
  };

  // -------- auto-collector --------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const IDLE_MS = 8000;
  // When the user set an explicit limit and we haven't reached it yet, be
  // far more patient before giving up on "end of feed" — the platform may
  // be slow to load the next page or briefly stall.
  const IDLE_MS_BELOW_LIMIT = 30000;
  const STEP_MS = 1500;
  const COLLECT_TIMEOUT_MS = 5 * 60 * 1000;
  const COLLECT_TIMEOUT_BELOW_LIMIT_MS = 30 * 60 * 1000;
  // Hard end-of-feed signal: when the document scrollHeight has stopped
  // growing for this long despite repeated scroll attempts, the page has
  // bottomed out and we stop regardless of any unmet limit.
  const SCROLL_HEIGHT_STALL_MS = 10000;

  const collector = {
    running: false,
    abort: false,
    reason: null,
    startedAt: 0,
  };

  const oldestInScope = () => {
    const sessionOnly = state.scope === "session";
    let oldest = Infinity;
    for (const p of posts.values()) {
      if (sessionOnly && !sessionIds.has(p.id)) continue;
      if (state.surface !== "all" && !matchesSurface(p, state.surface)) continue;
      if (p.createTime && p.createTime < oldest) oldest = p.createTime;
    }
    return oldest === Infinity ? 0 : oldest;
  };

  const inScopeCount = () => {
    // Match what the user sees as "in scope": respect both the surface
    // filter and the session/alltime scope toggle. Otherwise rehydrated
    // posts already in IDB satisfy the limit before the first scroll.
    const sessionOnly = state.scope === "session";
    if (state.surface === "all" && !sessionOnly) return posts.size;
    let n = 0;
    for (const p of posts.values()) {
      if (sessionOnly && !sessionIds.has(p.id)) continue;
      if (state.surface !== "all" && !matchesSurface(p, state.surface)) continue;
      n++;
    }
    return n;
  };

  const stopCollect = (reason) => {
    if (!collector.running) return;
    collector.abort = true;
    collector.reason = reason;
  };

  const startCollect = async (trigger = "manual") => {
    if (pageScope.kind === "other") {
      logDebug("collect.skip", { reason: "bad-scope", path: location.pathname });
      return;
    }
    if (collector.running) {
      logDebug("collect.skip", { reason: "already-running" });
      return;
    }
    collector.running = true;
    collector.abort = false;
    collector.reason = null;
    collector.startedAt = Date.now();
    collectionSeenVideoIds.clear();
    if (pageScope.videoId) collectionSeenVideoIds.add(String(pageScope.videoId));
    const preIds = new Set(posts.keys());

    const { from: cutoff, to: cutoffTo } = rangeCutoffs();
    const limit = state.limit;

    // Per-platform / per-scope advance strategy. IG, TT profile, and
    // YT-channel-grid get page-scroll until scrollHeight stalls. TT
    // For You/Explore and YT Shorts use snap-style next-video navigation.
    // Falls back to a synthetic scroll strategy if a platform forgot to
    // declare one — keeps behavior bit-for-bit with the pre-strategy code.
    const strategy = (typeof PLATFORM.collectStrategy === "function"
      ? PLATFORM.collectStrategy(pageScope)
      : null) || {
        kind: "scroll",
        useScrollHeightStall: true,
        useIdleEnd: true,
        advance({ doc }) {
          const d = doc || document;
          if (!d || !d.documentElement) return false;
          window.scrollTo(0, d.documentElement.scrollHeight || 0);
          return true;
        },
      };

    logInfo("collect.start", {
      trigger,
      platform: PLATFORM.platform,
      scope: pageScope,
      surface: state.surface,
      range: state.range,
      cutoffISO: cutoff ? new Date(cutoff * 1000).toISOString() : null,
      limit,
      url: location.pathname,
      strategy: strategy.kind,
      useIdleEnd: strategy.useIdleEnd !== false,
    });
    setStatus("collecting…");

    let lastCount = inScopeCount();
    let stagnantSince = Date.now();
    let scrolls = 0;
    let maxScrollHeight = document.documentElement.scrollHeight || 0;
    let heightGrewAt = Date.now();

    while (!collector.abort) {
      const beforePath = location.pathname;
      const beforeScope = { ...pageScope };
      const advanced = strategy.advance({ doc: document });
      scrolls++;
      await sleep(STEP_MS);
      if (strategy.kind === "snap" && PLATFORM.platform === "youtube") hydrateVisibleYouTubeShortFromDom("collect-step");
      if (strategy.kind === "snap" || scrolls <= 3 || scrolls % 5 === 0) {
        logInfo("collect.step", {
          scrolls,
          platform: PLATFORM.platform,
          strategy: strategy.kind,
          advanced: advanced !== false,
          beforePath,
          afterPath: location.pathname,
          beforeScope,
          afterScope: pageScope,
          inScope: inScopeCount(),
          total: posts.size,
          abort: collector.abort,
          reason: collector.reason || null,
        });
      }

      // The scroll-list jiggle (scroll-up-then-down) un-sticks IG/TT virtual
      // lists that occasionally fail to fire their next page request. It
      // doesn't apply to the snap player (fixed-height document), so skip it.
      if (strategy.kind === "scroll" && scrolls % 3 === 0) {
        window.scrollBy(0, -400);
        await sleep(200);
        window.scrollTo(0, document.documentElement.scrollHeight);
      }

      // Snap players (fixed-height document) signal end-of-feed by returning
      // false from advance() — e.g. when #navigation-button-down disappears
      // at the bottom of the FYP. Treat as immediate end-of-feed.
      if (strategy.kind === "snap" && advanced === false) {
        collector.reason = "end-of-feed";
        break;
      }

      // Track scrollHeight growth as an end-of-feed signal independent of
      // post counts. If the page can't grow any taller, there's nothing
      // left to load — stop even if the user-set limit isn't reached.
      const sh = document.documentElement.scrollHeight || 0;
      if (sh > maxScrollHeight) {
        maxScrollHeight = sh;
        heightGrewAt = Date.now();
      }

      const cur = inScopeCount();
      if (cur > lastCount) {
        logDebug("collect.progress", {
          scrolls,
          inScope: cur,
          delta: cur - lastCount,
          oldestISO: oldestInScope() ? new Date(oldestInScope() * 1000).toISOString() : null,
        });
        lastCount = cur;
        stagnantSince = Date.now();
      }

      if (limit > 0 && cur >= limit) {
        collector.reason = "limit-reached";
        break;
      }
      if (cutoff && oldestInScope() && oldestInScope() < cutoff) {
        collector.reason = "date-cutoff-reached";
        break;
      }
      // Hard end-of-feed: scrollHeight hasn't grown for a while AND no
      // new posts arrived recently. This wins over the patient
      // below-limit budget so we don't spin forever on a creator who has
      // fewer posts than the requested limit. Skipped on snap players
      // where the document height is fixed (the snap-advanced=false path
      // above handles end-of-feed there).
      const heightStalled = Date.now() - heightGrewAt > SCROLL_HEIGHT_STALL_MS;
      const noNewPostsRecent = Date.now() - stagnantSince > IDLE_MS;
      if (strategy.useScrollHeightStall && heightStalled && noNewPostsRecent) {
        collector.reason = "end-of-feed";
        break;
      }
      // While the user-set limit hasn't been reached, be patient: extend
      // the idle window and overall timeout so the collector keeps
      // scrolling until it actually hits the goal (or truly stalls).
      const belowLimit = limit > 0 && cur < limit;
      const endlessSnap = strategy.kind === "snap" && strategy.useIdleEnd === false && limit === 0 && !cutoff;
      const idleBudget = belowLimit ? IDLE_MS_BELOW_LIMIT : IDLE_MS;
      const timeoutBudget = belowLimit || endlessSnap ? COLLECT_TIMEOUT_BELOW_LIMIT_MS : COLLECT_TIMEOUT_MS;
      if (!endlessSnap && Date.now() - stagnantSince > idleBudget) {
        collector.reason = "idle-end-of-feed";
        break;
      }
      if (Date.now() - collector.startedAt > timeoutBudget) {
        collector.reason = belowLimit ? "timeout-30min" : "timeout-5min";
        break;
      }
    }
    if (collector.abort && !collector.reason) collector.reason = "user-stopped";

    const endPayload = {
      reason: collector.reason,
      scrolls,
      inScope: inScopeCount(),
      total: posts.size,
      durationMs: Date.now() - collector.startedAt,
    };
    logInfo("collect.end", endPayload);
    setStatus(`done · ${collector.reason}`);
    collector.running = false;
    collector.abort = false;
    render();
    // Fire-and-forget auto-webhook delta if configured.
    runAutoOnCollect(preIds, endPayload).catch((e) => logWarn("auto.collect.fail", e));
    if (bgRescrapeActive) {
      bgRescrapeActive = false;
      try {
        chrome.runtime.sendMessage({ type: "fs-bg", event: "collect.end", payload: endPayload });
      } catch {}
    }
  };
  window.__feedSorter.startCollect = startCollect;
  window.__feedSorter.stopCollect = stopCollect;

  // -------- derived fields (velocity / accelerating) --------
  // Pure mirror of src/lib/filter.js computeDerived.
  // Observed velocity = (current views - first captured views) / elapsed hours
  // between first capture and last seen; a single baseline snapshot becomes
  // velocity-ready after the row is re-seen later.
  const ACCEL_RATIO = 1.5;
  const computeDerived = (p, now = Date.now()) => {
    const snaps = Array.isArray(p?.snapshots) ? p.snapshots.filter(Boolean) : [];
    const currentViews = Number(p?.views) || 0;
    if (!snaps.length) {
      return { firstSeenViews: currentViews, velocityViewsPerHr: 0, velocityReady: false, accelerating: false, snapshotCount: 0 };
    }
    const first = snaps[0] || {};
    const lastSnapshot = snaps[snaps.length - 1] || {};
    const lastSnapshotViews = Number(lastSnapshot.views) || 0;
    const last = currentViews > lastSnapshotViews
      ? { ...lastSnapshot, views: currentViews, capturedAt: Number(p?.lastSeenAt) || now }
      : lastSnapshot;
    const firstAt = Number(first.capturedAt) || Number(p?.firstSeenAt) || 0;
    const lastAtRaw = Math.max(Number(last.capturedAt) || 0, Number(p?.lastSeenAt) || 0, firstAt);
    const lastAt = Math.max(lastAtRaw, firstAt);
    const hrs = (lastAt - firstAt) / 3600000;
    const dViews = Math.max(0, Number(last.views || 0) - Number(first.views || 0));
    const velocityReady = hrs > 0;
    const velocity = velocityReady ? dViews / hrs : 0;
    let accelerating = false;
    if (snaps.length >= 3 && velocity > 0) {
      const prev = snaps[snaps.length - 2] || {};
      const prevAt = Number(prev.capturedAt) || firstAt;
      const recentHrs = Math.max((lastAt - prevAt) / 3600000, 0);
      const recentV = recentHrs > 0
        ? Math.max(0, Number(last.views || 0) - Number(prev.views || 0)) / recentHrs
        : 0;
      accelerating = recentV > velocity * ACCEL_RATIO;
    }
    return {
      firstSeenViews: Number(first.views) || 0,
      velocityViewsPerHr: velocity,
      velocityReady,
      accelerating,
      snapshotCount: snaps.length,
    };
  };

  // -------- outlier score --------
  const median = (xs) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // Outlier score = value / baseline. Two-tier baseline (mirrors
  // src/lib/scoring.js — keep them in lock-step):
  //   1. ±5 sliding median over createTime-sorted neighbours, when the
  //      author has ≥MIN_AUTHOR_POSTS_FOR_WINDOW posts in scope. This is
  //      time-local: a creator who grew 10× doesn't have ancient low-view
  //      posts dragging the baseline down (1of10's algorithm).
  //   2. Author all-time median across the visible scope.
  //   3. Global median (Explore / single-sample fallback).
  // _scoreBasis labels: "window" | "author" | "global" | "none".
  const MIN_SAMPLES = 2;
  const WINDOW_RADIUS = 5;
  const MIN_AUTHOR_POSTS_FOR_WINDOW = 12;
  const MIN_WINDOW_SAMPLES = 4;
  const computeOutliers = (list, metric) => {
    const byAuthor = new Map();
    const globalPositives = [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const v = Number(p[metric]) || 0;
      if (v > 0) globalPositives.push(v);
      const k = p.author || "_unknown";
      if (!byAuthor.has(k)) byAuthor.set(k, []);
      byAuthor.get(k).push({ p, idx: i, v });
    }
    const globalMed = median(globalPositives);
    const authorMeds = new Map();
    for (const [a, rows] of byAuthor) {
      const positives = rows.map((r) => r.v).filter((x) => x > 0);
      authorMeds.set(a, positives.length >= MIN_SAMPLES ? median(positives) : 0);
    }
    const out = new Array(list.length);
    for (const [a, rows] of byAuthor) {
      const authorMed = authorMeds.get(a) || 0;
      const useWindow = rows.length >= MIN_AUTHOR_POSTS_FOR_WINDOW;
      const chrono = useWindow
        ? [...rows].sort((x, y) => {
            const ax = Number(x.p.createTime) || 0;
            const ay = Number(y.p.createTime) || 0;
            if (ax !== ay) return ay - ax;
            return x.idx - y.idx;
          })
        : null;
      for (let j = 0; j < rows.length; j++) {
        const { p, idx, v } = rows[j];
        let baseline = 0;
        let basis = "none";
        if (useWindow) {
          const ci = chrono.findIndex((r) => r.idx === idx);
          const lo = Math.max(0, ci - WINDOW_RADIUS);
          const hi = Math.min(chrono.length, ci + WINDOW_RADIUS + 1);
          const neighbours = [];
          for (let k = lo; k < hi; k++) {
            if (k === ci) continue;
            if (chrono[k].v > 0) neighbours.push(chrono[k].v);
          }
          if (neighbours.length >= MIN_WINDOW_SAMPLES) {
            baseline = median(neighbours);
            basis = "window";
          }
        }
        if (!baseline) {
          if (authorMed > 0) {
            baseline = authorMed;
            basis = "author";
          } else if (globalMed > 0) {
            baseline = globalMed;
            basis = "global";
          }
        }
        const score = baseline > 0 ? v / baseline : 0;
        out[idx] = { ...p, _score: score, _scoreBasis: baseline > 0 ? basis : "none" };
      }
    }
    return out;
  };

  // -------- UI --------
  const fmt = (n) => {
    if (!n) return "0";
    if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(n);
  };
  const fmtScore = (s) => (s ? s.toFixed(2) + "x" : "—");
  const fmtDate = (t) => (t ? new Date(t * 1000).toLocaleDateString() : "");

  const RANGES = { all: 0, "1w": 7, "1m": 30, "3m": 90, "6m": 180, "1y": 365 };

  // VPH since posted = views / hours-since-creation. Baseline-free signal
  // that surfaces "this is accumulating views fast for its age" without
  // needing per-author history. Used as the default sort on Explore.
  // Lower-bounds the divisor at 1 hour so a just-posted reel doesn't get
  // an absurd score from a near-zero denominator.
  const vphSincePosted = (p) => {
    const views = Number(p.views) || 0;
    const created = Number(p.createTime) || 0;
    if (!views || !created) return 0;
    const ageHrs = Math.max(1, (Date.now() / 1000 - created) / 3600);
    return views / ageHrs;
  };

  // Normalize a possibly-millisecond timestamp to seconds.
  // Some API paths surface taken_at in ms; comparing those against a
  // seconds-based cutoff would either include or exclude *all* posts.
  const toSec = (t) => {
    const n = Number(t) || 0;
    if (n <= 0) return 0;
    return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
  };

  // Apply the active range to a list. Posts with no known createTime are
  // *kept* (date unknown → give benefit of the doubt) so a working dataset
  // doesn't collapse to zero just because the parser missed a field.
  const applyRangeFilter = (list) => {
    const { from, to } = rangeCutoffs();
    if (!from && !to) return list;
    let dropped = 0;
    const out = list.filter((p) => {
      const t = toSec(p.createTime);
      if (!t) return true;
      if (from && t < from) { dropped++; return false; }
      if (to && t > to) { dropped++; return false; }
      return true;
    });
    if (dropped && applyRangeFilter._lastDropped !== dropped) {
      applyRangeFilter._lastDropped = dropped;
      logDebug("filter.range.drop", { dropped, kept: out.length, from, to });
    }
    return out;
  };

  // Resolve the active range to {from, to} cutoff seconds (epoch). 0 = open-ended.
  // For preset ranges, only `from` is used (relative to now). For "custom",
  // both bounds are read from state.rangeFrom / state.rangeTo (YYYY-MM-DD).
  const rangeCutoffs = () => {
    if (state.range === "custom") {
      const fromS = state.rangeFrom
        ? Math.floor(new Date(state.rangeFrom + "T00:00:00").getTime() / 1000)
        : 0;
      const toS = state.rangeTo
        ? Math.floor(new Date(state.rangeTo + "T23:59:59").getTime() / 1000)
        : 0;
      return { from: fromS, to: toS };
    }
    const days = RANGES[state.range];
    return { from: days ? Math.floor(Date.now() / 1000 - days * 86400) : 0, to: 0 };
  };

  // Mirror of matchesSurface() in src/lib/filter.js — IG profile-reels now
  // serves reels through /graphql/query (surface="graphql"), so the "reels"
  // bucket must match by isReel rather than strict surface equality.
  const matchesSurface = (p, target) => {
    if (!target || target === "all") return true;
    const s = p.surface;
    if (target === "reels") return p.isReel === true || s === "reels";
    if (target === "profile") return !p.isReel && (s === "profile" || s === "graphql");
    return s === target;
  };

  const els = {};
  /** @type {{username:string,niche:string,addedAt:number,lastScrapedAt:number,scrapeIntervalHrs:number,autoCollect:boolean}[]} */
  let creators = [];
  const state = {
    sort: "outlier",
    metric: "likes",
    range: "all",
    rangeFrom: "",   // YYYY-MM-DD; only used when range === "custom"
    rangeTo: "",     // YYYY-MM-DD; only used when range === "custom"
    limit: 0,
    limitCustom: false, // true when the user picked "Custom…" in the Limit select
    limitCustomValue: 0, // last typed value for the custom Limit input
    surface: "all",
    scope: "session", // "session" | "alltime"
    logLevel: "info",
    q: "",
    focusedIdx: -1,
    /** @type {Set<string>} */
    selected: new Set(),
    /** @type {Set<string>} usernames selected on the Niche tab */
    selectedCreators: new Set(),
    // Meta-driven filters (chips). null/false = inactive.
    pinnedOnly: false,
    statusFilter: null, // null | "idea" | "drafted" | "posted" | "skip"
    hasNote: false,
    hasTranscript: false,
    statsSectionOpen: false,
    nicheClusterBusy: false,
    nicheClusterStatus: "",
    hashtagFilter: null,
    keywordFilter: null, // single caption keyword — set by clicking a Stats keyword chip
    nicheFilter: null,  // single niche label — set by clicking a Stats niche chip
    formatFilter: null, // single format value (FORMATS) — set by clicking a Stats format chip
    hasAi: false,
    hookTypeFilter: null,
    topicFilter: null,
    angleFilter: null,
    // Currently expanded row (for note/tag editor). One at a time.
    expandedId: null,
    // Tabbed view + Radar overlay.
    view: "current", // "current" | "pinned" | "niche" | "settings"
    radar: false,
    minScore: 3,
    radarRange: "all",
    radarLimit: 100,
    // Sounds tab + cross-tab audio filter.
    audioOriginalsOnly: false,
    audioMusicOnly: false,
    audioMinUses: true, // chip: min uses ≥ 3
    audioId: null,      // when set, filters Current list to posts with this audio.id
    // Signals tab (cross-creator hook reuse).
    signalsMinHistScore: 3,
    signalsMinSim: 0.6,
    signalsMaxAgeDays: 7,
    signalsNotify: false,
    signalsUnreadOnly: false,
    signalsOpen: false, // floating drawer (replaces the old Signals tab)
    // Outbound webhooks (loaded from chrome.storage.local on boot).
    webhooks: {
      generic: "",
      slack: "",
      discord: "",
      autoOnCollect: false,
    },
    webhookStatus: "",
    // Direct sinks (Sheets/Airtable/Notion). Persisted under fs.sinks.
    sinks: {
      sheets: { enabled: false, url: "", autoOnCollect: false },
      airtable: { enabled: false, token: "", baseId: "", table: "", unifiedTable: "UnifiedPosts", autoOnCollect: false },
      notion: { enabled: false, token: "", databaseId: "", autoOnCollect: false },
    },
    sinkStatus: { sheets: "", airtable: "", notion: "" },
    // Bulk-download outliers (footer button).
    outlierThresh: 3,
    bulkZip: false, // toggle in settings; requires JSZip on window
    bulk: { running: false, cancel: false, done: 0, total: 0, fail: 0 },
    // Sidecar transcribe (faster-whisper). Port 8788 — the API uses 8787, the
    // sidecar must run on a different port (sidecar/transcribe-server.py default
    // collided; we run it as `FS_WHISPER_PORT=8788 python transcribe-server.py`).
    transcribeUrl: "http://localhost:8788",
    // Cascade override: "auto" | "free-only" | "cloud-only" | "sidecar-only".
    // Forces a specific tier (or set of tiers) for testing/debugging.
    transcribeMode: "auto",
    // Cloud BYOK transcription (Groq Whisper-Large-v3-Turbo). Persisted under
    // fs:transcribeCloud, kept separate from fs:ai because LLM and STT are
    // different services with different keys.
    transcriptCloud: { groqApiKey: "", hfApiKey: "", hfFallbackOnRateLimit: false },
    groqHealth: { ok: null, msg: "", checkedAt: 0 },
    hfHealth: { ok: null, msg: "", checkedAt: 0 },
    transcribeStatus: { ok: null, msg: "", model: "", checkedAt: 0 },
    transcribeBulk: { running: false, cancel: false, done: 0, total: 0, fail: 0 },
    // Visible-feed bulk transcribe (footer button). Distinct from transcribeBulk
    // (top-N outliers via the radar bar) — this one walks the entire visible
    // list and is rate-limited to <30 RPM so it can't trip Groq's free tier.
    bulkTx: { running: false, cancel: false, done: 0, skipped: 0, failed: 0, total: 0, last: null },
    transcribeInflight: new Set(), // post ids being transcribed right now
    // LLM config. Persisted under fs:ai. Provider can be:
    //   "groq"  — cloud, BYOK (key reused from state.transcriptCloud.groqApiKey)
    //   "ollama" — local, opt-in "Power Mode" (the original default)
    ai: {
      provider: "ollama", // migrated to "groq" the first time a Groq key is set
      // Ollama (local).
      endpoint: "http://localhost:11434",
      model: "gemma4",
      visionModel: "gemma4",
      concurrency: 2,
      // Groq (cloud).
      groq: {
        model: "llama-3.3-70b-versatile",
        fastModel: "llama-3.1-8b-instant",
        // 1h cache of /openai/v1/models so we don't hammer the API on every
        // settings open. Cleared whenever the key changes.
        modelsCache: { fetchedAt: 0, models: [] },
      },
    },
    aiHealth: { ok: null, msg: "", models: [], checkedAt: 0 },
    // "Me" — the user's own IG handle. When set, repurpose-rewrites pull THIS
    // creator's voice fingerprint as the system prompt (so we translate the
    // source into the user's own voice, not the source creator's). Persisted
    // under fs:me.
    me: { username: "" },
    // Per-post repurpose runs in flight (id → true). Used to disable the
    // ✍ button while a generate batch is running for that post.
    rewriteInflight: new Set(),
    rewriteBatch: { running: false, cancel: false, done: 0, total: 0, fail: 0 },
    // Repurpose pipeline (full local content packs).
    pipelineTopN: 10,
    // Group rows by a key (sibling to sort). "none" disables grouping.
    groupBy: "none", // "none" | "status" | "hookType" | "topic" | "angle" | "coverWinRate"
    // Footer bulk dropdown.
    bulkAction: "download", // "download" | "audio" | "transcribe" | "rewrite"
  };
  /** @type {Map<string, any>} */
  const signalsCache = new Map();

  // -------- shareable URL hash --------
  // Persist user-facing filter/sort state in `location.hash` so views are
  // copy-pasteable. focusedIdx + logLevel are session-local and excluded.
  const HASH_KEYS = ["sort", "groupBy", "metric", "range", "rangeFrom", "rangeTo", "limit", "limitCustom", "limitCustomValue", "surface", "scope", "q", "pinnedOnly", "statusFilter", "hasNote", "hasTranscript", "hashtagFilter", "keywordFilter", "nicheFilter", "formatFilter", "hasAi", "hookTypeFilter", "topicFilter", "angleFilter"];
  const b64uEncode = (s) => btoa(unescape(encodeURIComponent(s)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const b64uDecode = (s) => {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return decodeURIComponent(escape(atob(s)));
  };
  let suppressHashSync = false;
  const syncHash = () => {
    if (suppressHashSync) return;
    const snap = {};
    for (const k of HASH_KEYS) snap[k] = state[k];
    try {
      const s = b64uEncode(JSON.stringify(snap));
      const next = "#fs=" + s;
      if (location.hash !== next) {
        history.replaceState(null, "", location.pathname + location.search + next);
      }
    } catch (e) { logWarn("hash.write.fail", e); }
  };
  const restoreFromHash = () => {
    const m = (location.hash || "").match(/#fs=([A-Za-z0-9_\-]+)/);
    if (!m) return;
    try {
      const snap = JSON.parse(b64uDecode(m[1]));
      for (const k of HASH_KEYS) {
        if (snap[k] !== undefined) state[k] = snap[k];
      }
      // Legacy: the old sort dropdown contained group keys. Migrate them to
      // groupBy + reset sort to outlier.
      if (["status", "hookType", "topic", "angle", "coverWinRate"].includes(state.sort)) {
        state.groupBy = state.sort;
        state.sort = "outlier";
      }
      // Legacy snapshots may have persisted view= one of the removed tabs.
      // Coerce them to current/sensible flags so old shareable links work.
      if (snap.view === "pinned") {
        state.view = "current";
        state.pinnedOnly = true;
      } else if (snap.view === "patterns") {
        state.view = "current";
        state.statsSectionOpen = true;
      } else if (snap.view === "signals") {
        state.view = "current";
        state.signalsOpen = true;
      } else if (typeof snap.view === "string") {
        state.view = snap.view;
      }
      logInfo("hash.restore", { snap });
    } catch (e) { logWarn("hash.restore.fail", e); }
  };

  const updateHeader = () => {
    if (!els.title) return;
    const suffix = pageScope.kind === "profile" && pageScope.username
      ? ` · @${pageScope.username}${pageScope.videoId ? " · video" : ""}`
      : pageScope.kind === "explore"
        ? " · explore"
        : pageScope.kind === "shorts-feed"
          ? " · Shorts"
          : pageScope.kind === "search"
            ? " · search"
            : "";
    els.title.textContent = `Feed Sorter · ${PLATFORM_LABEL}${suffix}`;
    if (els.reportBtn) {
      const profileScope = pageScope.kind === "profile" && !!pageScope.username;
      els.reportBtn.hidden = !profileScope;
      els.reportBtn.dataset.username = profileScope ? pageScope.username : "";
    }
    updatePinBtn();
    if (els.root) {
      els.root.classList.toggle("fs-scope-explore", pageScope.kind === "explore");
      els.root.classList.toggle("fs-scope-profile", pageScope.kind === "profile");
      els.root.classList.toggle("fs-scope-other", pageScope.kind === "other");
      // On explore, force surface=all (everything is the explore surface anyway).
      if (pageScope.kind === "explore" && state.surface !== "all") {
        state.surface = "all";
        const sel = els.root.querySelector('[data-ctl="surface"]');
        if (sel) sel.value = "all";
      }
      // Hide the "Explore" surface option on profile + explore pages —
      // profiles never contain explore-tagged posts, and the explore page
      // itself only surfaces posts/reels (the filter is redundant there).
      const exploreOpt = els.root.querySelector('[data-ctl="surface"] option[value="explore"]');
      if (exploreOpt) {
        const hideExplore = pageScope.kind === "profile" || pageScope.kind === "explore";
        exploreOpt.hidden = hideExplore;
        exploreOpt.disabled = hideExplore;
        if (hideExplore && state.surface === "explore") {
          state.surface = "all";
          const sel = els.root.querySelector('[data-ctl="surface"]');
          if (sel) sel.value = "all";
        }
      }
      // On Explore the outlier score is meaningless (every post has a
      // different author with no baseline). Hide the option and default
      // sort to VPH (views/hour since posted), which needs no baseline.
      const outlierOpt = els.root.querySelector('[data-ctl="sort"] option[data-sort-outlier]');
      if (outlierOpt) {
        const isExplore = pageScope.kind === "explore";
        outlierOpt.hidden = isExplore;
        outlierOpt.disabled = isExplore;
        if (isExplore && state.sort === "outlier") {
          state.sort = "vph";
          const sel = els.root.querySelector('[data-ctl="sort"]');
          if (sel) sel.value = "vph";
          syncHash();
        }
      }
    }
  };

  // Reflect web-app connection state on the Sync button.
  // Asks SW for current token+baseUrl, then validates by hitting /v1/me.
  // Listens to chrome.storage.onChanged for live updates after /connect.
  const initWebAppConnIndicator = (root) => {
    const apply = (state) => {
      const btn = root.querySelector('[data-act="sync-webapp"]');
      if (!btn) return;
      btn.setAttribute("data-conn", state); // 'on' | 'off' | 'unknown'
      const dot = btn.querySelector("[data-conn-dot]");
      if (dot) dot.setAttribute("data-state", state);
      btn.title =
        state === "on" ? "Sync collected posts to the web app" :
        state === "off" ? "Not connected to web app \u2014 click to connect" :
        "Web app status unknown";
    };
    const refresh = () => {
      try {
        chrome.runtime.sendMessage({ type: "fs-bg", cmd: "api.config" }, (cfg) => {
          if (chrome.runtime.lastError || !cfg) return apply("unknown");
          if (!cfg.token) return apply("off");
          chrome.runtime.sendMessage({ type: "fs-bg", cmd: "api.request", path: "/v1/me" }, (r) => {
            if (chrome.runtime.lastError || !r) return apply("unknown");
            apply(r.ok && r.body && r.body.id ? "on" : "off");
          });
        });
      } catch (_) { apply("unknown"); }
    };
    refresh();
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes["fs.api.token"] || changes["fs.api.baseUrl"]) refresh();
      });
    } catch (_) {}
  };

  const buildUI = () => {
    if (els.root) return;
    const root = document.createElement("div");
    root.className = "fs-root";
    root.innerHTML = `
      <div class="fs-header" data-drag>
        <span class="fs-title" data-title>Feed Sorter · ${PLATFORM_LABEL}</span>
        <button class="fs-icon-btn fs-signals-bell" data-act="signals" data-signals-btn title="Signals — cross-creator hook reuse" hidden>🔔<span class="fs-tab-badge" data-signals-badge hidden>0</span></button>
        <button class="fs-icon-btn" data-act="report" data-report-btn title="Generate PDF report for this profile" hidden>📄</button>
        <button class="fs-icon-btn fs-pin-btn" data-act="pin-creator" data-pin-btn title="Pin creator to watchlist" hidden>📌</button>
        <button class="fs-icon-btn" data-act="help" title="Keyboard shortcuts (?)">?</button>
        <button class="fs-icon-btn" data-act="settings" title="Web app + dev settings">⚙</button>
        <button class="fs-icon-btn" data-act="collapse" title="Collapse">–</button>
        <button class="fs-icon-btn" data-act="clear" title="Re-scan this page">⟳</button>
      </div>
      <div class="fs-tabs" data-tabs>
        <button class="fs-tab" data-tab="current">Current</button>
      </div>
      <div class="fs-section">
        <div class="fs-section-label">Sort</div>
        <div class="fs-section-grid">
          <label>Sort by
            <select data-ctl="sort">
              <option value="relevance" data-sort-relevance>Relevance (smart)</option>
              <option value="outlier" data-sort-outlier>Outlier score</option>
              <option value="vph">Views/hour since published</option>
              <option value="velocity">Observed growth since collected</option>
              <option value="likes">Likes</option>
              <option value="views">Views</option>
              <option value="comments">Comments</option>
              <option value="cpr">CPR (comments/1k likes)</option>
              <option value="recent">Most recent</option>
            </select>
          </label>
          <label data-metric-label hidden>Outlier metric
            <select data-ctl="metric">
              <option value="likes">Likes</option>
              <option value="views">Views</option>
              <option value="comments">Comments</option>
              <option value="velocity">Velocity (views/hr)</option>
            </select>
          </label>
        </div>
      </div>
      <div class="fs-section">
        <div class="fs-section-label">Filter</div>
        <div class="fs-section-grid">
          <label data-for="surface">Surface
            <select data-ctl="surface">
              <option value="all">All on this page</option>
              <option value="profile">Posts (grid)</option>
              <option value="reels">Reels</option>
              <option value="explore">Explore</option>
            </select>
          </label>
          <label>Date range
            <select data-ctl="range">
              <option value="all">All</option>
              <option value="1w">Past week</option>
              <option value="1m">Past month</option>
              <option value="3m">Past 3 months</option>
              <option value="6m">Past 6 months</option>
              <option value="1y">Past year</option>
              <option value="custom">Custom…</option>
            </select>
          </label>
          <label>Limit
            <select data-ctl="limit">
              <option value="0">All</option>
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
              <option value="200">200</option>
              <option value="1000">1000</option>
              <option value="custom">Custom…</option>
            </select>
          </label>
          <label class="fs-custom-range" data-custom-range hidden>From
            <input data-ctl="rangeFrom" type="date" />
          </label>
          <label class="fs-custom-range" data-custom-range hidden>To
            <input data-ctl="rangeTo" type="date" />
          </label>
          <label class="fs-custom-limit" data-custom-limit hidden style="grid-column: 1 / -1;">Custom limit (videos)
            <input data-ctl="limitCustomValue" type="number" min="0" step="1" placeholder="e.g. 75" />
          </label>
        </div>
        <div class="fs-chips" data-chips>
          <button class="fs-chip fs-chip-ai" data-chip="hookType" type="button" hidden data-hooktype-chip>hook</button>
          <button class="fs-chip fs-chip-ai" data-chip="topic" type="button" hidden data-topic-chip>topic</button>
          <button class="fs-chip fs-chip-ai" data-chip="angle" type="button" hidden data-angle-chip>angle</button>
          <button class="fs-chip fs-chip-hashtag" data-chip="hashtag" type="button" hidden data-hashtag-chip>#tag</button>
          <button class="fs-chip fs-chip-hashtag" data-chip="keyword" type="button" hidden data-keyword-chip>kw</button>
          <button class="fs-chip fs-chip-niche" data-chip="niche" type="button" hidden data-niche-chip>niche</button>
          <button class="fs-chip fs-chip-format" data-chip="format" type="button" hidden data-format-chip>fmt</button>
        </div>
      </div>
      <details class="fs-stats-section" data-stats-section>
        <summary>
          <span class="fs-stats-summary-label">📊 Stats</span>
          <span class="fs-stats-summary-sub" data-stats-sub>—</span>
        </summary>
        <div class="fs-stats-body" data-stats-body></div>
      </details>
      <div class="fs-stats">
        <span data-stat="count">0 posts</span>
        <span data-stat="authors">0 authors</span>
      </div>
      <div class="fs-status" data-status>idle</div>
      <div class="fs-batch" data-batch hidden>
        <span class="fs-batch-count" data-batch-count>0 selected</span>
        <button class="fs-batch-link" data-act="batch-all" title="Select all visible rows">Select all visible</button>
        <button class="fs-batch-link" data-act="batch-none" title="Select none">Select none</button>
      </div>
      <div class="fs-list" data-list></div>
      <details class="fs-logs" data-logs-details>
        <summary>
          <span class="fs-logs-summary-label">Logs</span>
          <span class="fs-logs-summary-tools">
            <select class="fs-log-level" data-ctl="logLevel" title="Minimum log level">
              <option value="debug">debug</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
            </select>
            <button class="fs-icon-btn" data-act="export-logs" title="Export logs">Export</button>
            <button class="fs-icon-btn" data-act="export-library" title="Export entire library as JSON for offline analysis" data-export-library>Export library</button>
            <button class="fs-icon-btn" data-act="niche-cluster" title="Auto-cluster creators into niches via MiniLM embeddings (~30–60s on first run)" data-niche-cluster-trigger>⚙ Cluster niches</button>
            <span class="fs-niche-cluster-status" data-niche-cluster-status></span>
          </span>
        </summary>
        <div class="fs-log-panel" data-logs></div>
      </details>
      <div class="fs-footer">
        <button class="fs-icon-btn" data-act="collect">Collect all</button>
        <button class="fs-icon-btn" data-act="stop">Stop</button>
        <button class="fs-icon-btn fs-sync-btn" data-act="sync-webapp" data-conn="unknown" title="Sync collected posts to the webapp"><span class="fs-conn-dot" data-conn-dot></span> Sync</button>
        <button class="fs-icon-btn" data-act="bulk-tx-visible" data-bulk-tx-btn title="Transcribe every visible post that doesn't already have a transcript">📝 Bulk transcribe</button>
        <button class="fs-icon-btn fs-bulk-cancel" data-act="bulk-tx-visible-cancel" data-bulk-tx-cancel hidden title="Cancel bulk transcribe">Cancel</button>
        <span class="fs-bulk-status" data-sync-status hidden></span>
        <div class="fs-bulk-tx-status" data-bulk-tx-status hidden>
          <span class="fs-bulk-tx-counts" data-bulk-tx-counts></span>
          <span class="fs-bulk-tx-tier" data-bulk-tx-tier></span>
        </div>
      </div>
      <div class="fs-sounds-panel" data-sounds-panel hidden>
        <div class="fs-sounds-bar">
          <button class="fs-chip" data-sound-chip="originalsOnly" type="button" title="Show only original sounds">Original sounds only</button>
          <button class="fs-chip" data-sound-chip="musicOnly" type="button" title="Show only licensed music">Music only</button>
          <button class="fs-chip" data-sound-chip="minUses" type="button" title="Hide sounds with fewer than 3 uses">Min uses ≥ 3</button>
          <button class="fs-icon-btn" data-act="sounds-recompute" title="Recompute trending">⟳</button>
        </div>
        <div class="fs-sounds-active" data-sounds-active hidden>
          <span data-sounds-active-label></span>
          <button class="fs-icon-btn" data-act="sounds-clear-filter" title="Clear sound filter">×</button>
        </div>
        <div class="fs-sounds-list" data-sounds-list></div>
      </div>
      <div class="fs-signals-drawer" data-signals-panel hidden>
        <div class="fs-signals-head">
          <span class="fs-signals-title">🔔 Signals</span>
          <button class="fs-icon-btn" data-act="signals-rescan" title="Rescan all stored posts now">⟳</button>
          <button class="fs-icon-btn" data-act="signals-clear" title="Clear all signals">Clear</button>
          <button class="fs-icon-btn" data-act="signals-close" title="Close">×</button>
        </div>
        <div class="fs-signals-bar">
          <label class="fs-signals-ctl">Min similarity
            <input data-ctl="signalsMinSim" type="number" min="0" max="1" step="0.05" />
          </label>
          <label class="fs-signals-ctl">Min historical score
            <input data-ctl="signalsMinHistScore" type="number" min="1" step="0.5" />
          </label>
          <label class="fs-signals-ctl">Max age (days)
            <input data-ctl="signalsMaxAgeDays" type="number" min="0" step="1" />
          </label>
          <button class="fs-chip" data-signals-chip="unreadOnly" type="button" title="Show only unread signals">Unread only</button>
        </div>
        <div class="fs-signals-list" data-signals-list></div>
      </div>
      <div class="fs-niche-panel" data-niche-panel hidden>
        <div class="fs-niche-bar">
          <button class="fs-icon-btn" data-act="niche-add-current" data-niche-add-current title="Track the creator on this page">+ Add current profile</button>
          <button class="fs-icon-btn" data-act="niche-rescrape-stale" title="Re-scan all creators past their interval">Re-scan stale</button>
          <button class="fs-icon-btn" data-act="niche-cluster" title="Auto-cluster creators by caption embeddings (MiniLM)">⚙ Auto-cluster</button>
          <span class="fs-niche-cluster-status" data-niche-cluster-status></span>
        </div>
        <div class="fs-niche-add-row">
          <input class="fs-niche-input" data-niche-username type="text" placeholder="@username" autocomplete="off" />
          <input class="fs-niche-input fs-niche-niche" data-niche-niche type="text" placeholder="niche label (e.g. fitness)" autocomplete="off" />
          <button class="fs-icon-btn" data-act="niche-add-manual">Add</button>
        </div>
        <div class="fs-niche-batch" data-niche-batch hidden>
          <span class="fs-niche-batch-count" data-niche-batch-count>0 selected</span>
          <button class="fs-icon-btn" data-act="niche-compare" title="Compare 2–3 selected creators">Compare</button>
          <button class="fs-icon-btn" data-act="niche-batch-clear" title="Clear selection">Clear</button>
        </div>
        <div class="fs-niche-list" data-niche-list></div>
      </div>
      <div class="fs-settings-panel" data-settings-panel hidden>
        <details class="fs-set-section" open>
          <summary>Outlier Radar defaults</summary>
        <label class="fs-set-row">Min score (× author median)
          <input data-ctl="minScore" type="number" min="1" step="0.5" />
        </label>
        <label class="fs-set-row">Date range
          <select data-ctl="radarRange">
            <option value="all">All</option>
            <option value="1w">Past week</option>
            <option value="1m">Past month</option>
            <option value="3m">Past 3 months</option>
            <option value="6m">Past 6 months</option>
            <option value="1y">Past year</option>
          </select>
        </label>
        <label class="fs-set-row">Limit
          <select data-ctl="radarLimit">
            <option value="50">50</option>
            <option value="100">100</option>
            <option value="200">200</option>
            <option value="500">500</option>
            <option value="0">All</option>
          </select>
        </label>
        </details>
        <details class="fs-set-section">
          <summary>Signals (cross-creator hook reuse)</summary>
        <label class="fs-set-row">Notify on new signal
          <input data-ctl="signalsNotify" type="checkbox" />
        </label>
        <label class="fs-set-row">Min similarity
          <input data-ctl="signalsMinSim" type="number" min="0" max="1" step="0.05" />
        </label>
        <label class="fs-set-row">Min historical outlier score
          <input data-ctl="signalsMinHistScore" type="number" min="1" step="0.5" />
        </label>
        <label class="fs-set-row">Max age of new post (days)
          <input data-ctl="signalsMaxAgeDays" type="number" min="0" step="1" />
        </label>
        </details>
        <details class="fs-set-section">
          <summary>Bulk download</summary>
        <label class="fs-set-row">Bundle into a single ZIP (requires JSZip)
          <input data-ctl="bulkZip" type="checkbox" />
        </label>
        </details>
        <details class="fs-set-section">
          <summary>Free transcription (cloud)</summary>
        <label class="fs-set-row fs-set-row-wide">Groq API key
          <input data-ctl="groqApiKey" type="password" placeholder="gsk_…" autocomplete="off" spellcheck="false" />
        </label>
        <div class="fs-set-row">
          <span>Status</span>
          <span class="fs-tx-health" data-groq-health data-level="unknown">not checked</span>
          <button class="fs-icon-btn" data-act="groq-test" title="GET /openai/v1/models with this key">Test key</button>
        </div>
        <div class="fs-set-info">Get a free API key at <code>console.groq.com</code> — 2,000 transcriptions/day, no credit card required. The key is stored locally in this browser; transcription requests go straight from the extension to api.groq.com.</div>
        <label class="fs-set-row fs-set-row-wide">HuggingFace token
          <input data-ctl="hfApiKey" type="password" placeholder="hf_…" autocomplete="off" spellcheck="false" />
        </label>
        <div class="fs-set-row">
          <span>Status</span>
          <span class="fs-tx-health" data-hf-health data-level="unknown">not checked</span>
          <button class="fs-icon-btn" data-act="hf-test" title="GET /api/whoami-v2 with this token">Test key</button>
        </div>
        <label class="fs-set-row">Auto-fallback to HuggingFace when Groq is rate-limited
          <input data-ctl="hfFallbackOnRateLimit" type="checkbox" />
        </label>
        <div class="fs-set-info">Get a free token at <code>huggingface.co/settings/tokens</code> — used as fallback when Groq is rate-limited.</div>
        </details>
        <details class="fs-set-section">
          <summary>Transcription sidecar</summary>
        <label class="fs-set-row">Cascade mode
          <select data-ctl="transcribeMode">
            <option value="auto">auto (free → cloud → sidecar)</option>
            <option value="free-only">free-only (TikTok VTT / IG alt)</option>
            <option value="cloud-only">cloud-only (Groq + HF)</option>
            <option value="sidecar-only">sidecar-only (local Whisper)</option>
          </select>
        </label>
        <div class="fs-set-info">Force a specific tier for testing or debugging. "auto" runs the full cascade in order.</div>
        <label class="fs-set-row fs-set-row-wide">Sidecar URL
          <input data-ctl="transcribeUrl" type="url" placeholder="http://localhost:8787" autocomplete="off" />
        </label>
        <div class="fs-set-row">
          <span>Status</span>
          <span class="fs-tx-health" data-tx-health data-level="unknown">not checked</span>
          <button class="fs-icon-btn" data-act="tx-health" title="Re-check the sidecar /health endpoint">Check</button>
        </div>
        <div class="fs-set-info">Run <code>pip install -r requirements.txt &amp;&amp; python transcribe-server.py</code> in the <code>sidecar/</code> folder. Default port 8787.</div>
        </details>
        <details class="fs-set-section" open>
          <summary>AI provider</summary>
        <label class="fs-set-row">Provider
          <select data-ctl="aiProvider">
            <option value="groq">Groq (cloud, BYOK)</option>
            <option value="ollama">Ollama (local, Power Mode)</option>
          </select>
        </label>
        <div class="fs-set-info">Groq uses the same API key configured under <b>Free transcription (cloud)</b>. The key never leaves this browser — chat requests go straight from the extension to api.groq.com. Switch to Ollama if you prefer fully-local inference (no key, no network).</div>
        <div data-ai-groq-block>
          <label class="fs-set-row">Main model
            <select data-ctl="aiGroqModel"></select>
          </label>
          <label class="fs-set-row">Fast model (per-post batch)
            <select data-ctl="aiGroqFastModel"></select>
          </label>
          <div class="fs-set-row">
            <span>Status</span>
            <span class="fs-tx-health" data-ai-health data-level="unknown">not checked</span>
            <button class="fs-icon-btn" data-act="ai-health" title="Ping /openai/v1/models with this key">Check</button>
            <button class="fs-icon-btn" data-act="ai-groq-refresh" title="Re-fetch the Groq model list">Refresh models</button>
            <button class="fs-icon-btn" data-act="ai-cache-clear" title="Drop all cached LLM responses">Clear AI cache</button>
          </div>
          <div class="fs-set-info">No Groq key set yet? Paste one under <b>Free transcription (cloud)</b> above — the same key powers chat and Whisper.</div>
        </div>
        <details class="fs-set-section" data-ai-ollama-block>
          <summary>Power Mode (Ollama, local)</summary>
        <label class="fs-set-row fs-set-row-wide">Endpoint URL
          <input data-ctl="aiEndpoint" type="url" placeholder="http://localhost:11434" autocomplete="off" />
        </label>
        <label class="fs-set-row">Model
          <input data-ctl="aiModel" type="text" placeholder="gemma4" autocomplete="off" />
        </label>
        <label class="fs-set-row">Vision model
          <input data-ctl="aiVisionModel" type="text" placeholder="gemma3:12b" autocomplete="off" />
        </label>
        <label class="fs-set-row">Concurrency
          <input data-ctl="aiConcurrency" type="number" min="1" max="16" step="1" />
        </label>
        <div class="fs-set-info">Status shown above — single badge reflects whichever provider is active.</div>
        <div class="fs-set-info">Run <code>ollama serve</code> and <code>ollama pull gemma4</code> (or <code>gemma3</code>). Nothing leaves this machine.</div>
        </details>
        </details>
        <details class="fs-set-section">
          <summary>My voice (for repurpose)</summary>
        <label class="fs-set-row">My IG handle
          <input data-ctl="meUsername" type="text" placeholder="yourhandle" autocomplete="off" />
        </label>
        <div class="fs-set-info">When set, the ✍ Repurpose feature uses your own voice fingerprint as the system prompt instead of the source creator's. Generate it from the Niche tab → your row → “Regenerate voice”.</div>
        </details>
        <details class="fs-set-section">
          <summary>Storage</summary>
        <div class="fs-set-info" data-set-info>—</div>
        </details>
        <details class="fs-set-section">
          <summary>Outbound webhooks</summary>
        <label class="fs-set-row fs-set-row-wide">Generic webhook URL
          <input data-ctl="whGeneric" type="url" placeholder="https://webhook.site/…" />
        </label>
        <label class="fs-set-row fs-set-row-wide">Slack webhook URL
          <input data-ctl="whSlack" type="url" placeholder="https://hooks.slack.com/services/…" />
        </label>
        <label class="fs-set-row fs-set-row-wide">Discord webhook URL
          <input data-ctl="whDiscord" type="url" placeholder="https://discord.com/api/webhooks/…" />
        </label>
        <label class="fs-set-row">Auto-send delta on collect.end
          <input data-ctl="whAutoOnCollect" type="checkbox" />
        </label>
        <div class="fs-webhook-actions">
          <button class="fs-icon-btn" data-act="wh-test" title="POST a stub payload to all configured webhooks">Send test ping</button>
          <button class="fs-icon-btn" data-act="wh-send-view" title="POST current filtered view to Generic webhook">Send view to webhook</button>
          <button class="fs-icon-btn" data-act="wh-send-slack" title="Send top 5 of current view to Slack">Send top 5 to Slack</button>
          <button class="fs-icon-btn" data-act="wh-send-discord" title="Send top 5 of current view to Discord">Send top 5 to Discord</button>
          <button class="fs-icon-btn" data-act="wh-weekly-now" title="Run the weekly watchlist digest now (uses tracked creators)">Run weekly digest now</button>
        </div>
        <div class="fs-webhook-status" data-webhook-status data-level="info"></div>
        </details>
        <details class="fs-set-section">
          <summary>Direct sinks</summary>
        <div class="fs-sink-help">Push the current filtered view straight into a content-pipeline tool.</div>

        <details class="fs-sink" data-sink="sheets">
          <summary>📊 Google Sheets <span class="fs-sink-badge" data-sink-badge="sheets"></span></summary>
          <label class="fs-set-row">Enable
            <input data-sink-ctl="sheets.enabled" type="checkbox" />
          </label>
          <label class="fs-set-row fs-set-row-wide">Apps Script web-app URL
            <input data-sink-ctl="sheets.url" type="url" placeholder="https://script.google.com/macros/s/…/exec" />
          </label>
          <label class="fs-set-row">Auto-sync on collect.end
            <input data-sink-ctl="sheets.autoOnCollect" type="checkbox" />
          </label>
          <div class="fs-webhook-actions">
            <button class="fs-icon-btn" data-act="sink-test" data-sink="sheets">Test</button>
            <button class="fs-icon-btn" data-act="sink-sync" data-sink="sheets">Sync filtered view now</button>
          </div>
          <div class="fs-webhook-status" data-sink-status="sheets" data-level="info"></div>
        </details>

        <details class="fs-sink" data-sink="airtable">
          <summary>🗂 Airtable <span class="fs-sink-badge" data-sink-badge="airtable"></span></summary>
          <label class="fs-set-row">Enable
            <input data-sink-ctl="airtable.enabled" type="checkbox" />
          </label>
          <label class="fs-set-row fs-set-row-wide">Personal Access Token
            <input data-sink-ctl="airtable.token" type="password" placeholder="patXXXXXXXXXXXXXX.…" autocomplete="off" />
          </label>
          <label class="fs-set-row fs-set-row-wide">Base ID
            <input data-sink-ctl="airtable.baseId" type="text" placeholder="appXXXXXXXXXXXXXX" autocomplete="off" />
          </label>
          <label class="fs-set-row fs-set-row-wide">Table name
            <input data-sink-ctl="airtable.table" type="text" placeholder="Posts" autocomplete="off" />
          </label>
          <label class="fs-set-row">Auto-sync on collect.end
            <input data-sink-ctl="airtable.autoOnCollect" type="checkbox" />
          </label>
          <div class="fs-webhook-actions">
            <button class="fs-icon-btn" data-act="sink-test" data-sink="airtable">Test</button>
            <button class="fs-icon-btn" data-act="sink-sync" data-sink="airtable">Sync filtered view now</button>
          </div>
          <div class="fs-webhook-status" data-sink-status="airtable" data-level="info"></div>
        </details>

        <details class="fs-sink" data-sink="notion">
          <summary>📓 Notion <span class="fs-sink-badge" data-sink-badge="notion"></span></summary>
          <label class="fs-set-row">Enable
            <input data-sink-ctl="notion.enabled" type="checkbox" />
          </label>
          <label class="fs-set-row fs-set-row-wide">Integration token
            <input data-sink-ctl="notion.token" type="password" placeholder="secret_…" autocomplete="off" />
          </label>
          <label class="fs-set-row fs-set-row-wide">Database ID
            <input data-sink-ctl="notion.databaseId" type="text" placeholder="32 hex chars" autocomplete="off" />
          </label>
          <label class="fs-set-row">Auto-sync on collect.end
            <input data-sink-ctl="notion.autoOnCollect" type="checkbox" />
          </label>
          <div class="fs-webhook-actions">
            <button class="fs-icon-btn" data-act="sink-test" data-sink="notion">Test</button>
            <button class="fs-icon-btn" data-act="sink-sync" data-sink="notion">Sync filtered view now</button>
          </div>
          <div class="fs-webhook-status" data-sink-status="notion" data-level="info"></div>
        </details>
        </details>
      </div>
      <div class="fs-radar" data-radar hidden>
        <div class="fs-radar-head">
          <span class="fs-radar-title">📡 Outlier Radar</span>
          <span class="fs-radar-sub" data-radar-sub></span>
          <button class="fs-icon-btn" data-act="radar-refresh" title="Recompute">⟳</button>
          <button class="fs-icon-btn" data-act="radar-close" title="Close">×</button>
        </div>
        <div class="fs-radar-list" data-radar-list></div>
      </div>
    `;
    document.body.appendChild(root);
    els.root = root;
    initWebAppConnIndicator(root);
    els.title = root.querySelector("[data-title]");
    els.list = root.querySelector("[data-list]");
    els.count = root.querySelector('[data-stat="count"]');
    els.authors = root.querySelector('[data-stat="authors"]');
    els.status = root.querySelector("[data-status]");
    els.logPanel = root.querySelector("[data-logs]");
    els.search = root.querySelector('[data-ctl="q"]');
    els.batch = root.querySelector('[data-batch]');
    els.batchCount = root.querySelector('[data-batch-count]');
    els.chips = root.querySelector('[data-chips]');
    els.tabs = root.querySelector('[data-tabs]');
    els.soundsPanel = root.querySelector('[data-sounds-panel]');
    els.soundsList = root.querySelector('[data-sounds-list]');
    els.soundsActive = root.querySelector('[data-sounds-active]');
    els.soundsActiveLabel = root.querySelector('[data-sounds-active-label]');
    els.signalsPanel = root.querySelector('[data-signals-panel]');
    els.signalsBtn = root.querySelector('[data-signals-btn]');
    els.signalsList = root.querySelector('[data-signals-list]');
    els.signalsBadge = root.querySelector('[data-signals-badge]');
    els.nichePanel = root.querySelector('[data-niche-panel]');
    els.nicheList = root.querySelector('[data-niche-list]');
    els.nicheBatch = root.querySelector('[data-niche-batch]');
    els.nicheBatchCount = root.querySelector('[data-niche-batch-count]');
    els.nicheUsername = root.querySelector('[data-niche-username]');
    els.nicheNiche = root.querySelector('[data-niche-niche]');
    els.nicheAddCurrent = root.querySelector('[data-niche-add-current]');
    // querySelectorAll because we render the cluster trigger in two places now:
    // the Logs tools row (always-visible) and the hidden niche panel.
    els.nicheClusterStatus = root.querySelectorAll('[data-niche-cluster-status]');
    els.settingsPanel = root.querySelector('[data-settings-panel]');
    els.txHealth = root.querySelector('[data-tx-health]');
    els.groqHealth = root.querySelector('[data-groq-health]');
    els.hfHealth = root.querySelector('[data-hf-health]');
    els.aiHealth = root.querySelector('[data-ai-health]');
    els.aiGroqBlock = root.querySelector('[data-ai-groq-block]');
    els.aiOllamaBlock = root.querySelector('[data-ai-ollama-block]');
    els.aiGroqModel = root.querySelector('[data-ctl="aiGroqModel"]');
    els.aiGroqFastModel = root.querySelector('[data-ctl="aiGroqFastModel"]');
    els.aiProvider = root.querySelector('[data-ctl="aiProvider"]');
    els.setInfo = root.querySelector('[data-set-info]');
    els.webhookStatus = root.querySelector('[data-webhook-status]');
    els.radar = root.querySelector('[data-radar]');
    els.radarList = root.querySelector('[data-radar-list]');
    els.radarSub = root.querySelector('[data-radar-sub]');
    els.radarBtn = root.querySelector('[data-radar-btn]');
    els.reportBtn = root.querySelector('[data-report-btn]');
    els.pinBtn = root.querySelector('[data-pin-btn]');
    els.statsSection = root.querySelector('[data-stats-section]');
    els.statsBody = root.querySelector('[data-stats-body]');
    els.statsSub = root.querySelector('[data-stats-sub]');
    els.hashtagChip = root.querySelector('[data-hashtag-chip]');
    els.keywordChip = root.querySelector('[data-keyword-chip]');
    els.nicheChip = root.querySelector('[data-niche-chip]');
    els.formatChip = root.querySelector('[data-format-chip]');

    if (els.statsSection) {
      els.statsSection.open = !!state.statsSectionOpen;
      els.statsSection.addEventListener("toggle", () => {
        state.statsSectionOpen = els.statsSection.open;
        if (els.statsSection.open) renderStats();
      });
    }

    updateHeader();

    let qDebounce = null;
    const updateMetricVisibility = (sortVal) => {
      const lbl = root.querySelector("[data-metric-label]");
      if (!lbl) return;
      lbl.hidden = sortVal !== "outlier";
    };
    // Show the From/To date inputs only when range === "custom";
    // show the Custom limit number input only when state.limitCustom.
    const updateCustomFilterVisibility = () => {
      const showRange = state.range === "custom";
      root.querySelectorAll("[data-custom-range]").forEach((el) => { el.hidden = !showRange; });
      const lim = root.querySelector("[data-custom-limit]");
      if (lim) lim.hidden = !state.limitCustom;
    };
    const WEBHOOK_CTL_MAP = { whGeneric: "generic", whSlack: "slack", whDiscord: "discord", whAutoOnCollect: "autoOnCollect" };
    root.querySelectorAll("[data-ctl]").forEach((sel) => {
      const k = sel.dataset.ctl;
      if (k in WEBHOOK_CTL_MAP) {
        const wk = WEBHOOK_CTL_MAP[k];
        if (sel.type === "checkbox") sel.checked = !!state.webhooks[wk];
        else sel.value = String(state.webhooks[wk] || "");
        const evt = sel.type === "checkbox" ? "change" : "input";
        let whDebounce = null;
        sel.addEventListener(evt, () => {
          if (sel.type === "checkbox") state.webhooks[wk] = !!sel.checked;
          else state.webhooks[wk] = String(sel.value || "").trim();
          clearTimeout(whDebounce);
          whDebounce = setTimeout(() => { saveWebhookConfig(); }, 250);
        });
        return;
      }
      if (sel.type === "checkbox") sel.checked = !!state[k];
      else if (k === "hasFilter") {
        // Derive single-select value from the underlying booleans.
        sel.value = state.hasNote ? "note" : state.hasTranscript ? "transcript" : state.hasAi ? "ai" : "";
      } else if (k === "limit") {
        // The Limit select shows "custom" when the user is in custom mode;
        // otherwise it mirrors the numeric state.limit.
        sel.value = state.limitCustom ? "custom" : String(state.limit);
      } else if (k === "limitCustomValue") {
        sel.value = state.limitCustomValue ? String(state.limitCustomValue) : "";
      } else sel.value = String(state[k] ?? "");
      if (k === "transcribeUrl") {
        let txDebounce = null;
        sel.addEventListener("input", () => {
          state.transcribeUrl = String(sel.value || "").trim();
          clearTimeout(txDebounce);
          txDebounce = setTimeout(() => {
            saveTranscribeConfig();
            // Re-check health against the new URL.
            checkSidecarHealth().catch(() => {});
          }, 400);
        });
        return;
      }
      if (k === "transcribeMode") {
        sel.value = String(state.transcribeMode || "auto");
        sel.addEventListener("change", () => {
          const v = String(sel.value || "auto");
          state.transcribeMode = VALID_TRANSCRIBE_MODES.has(v) ? v : "auto";
          saveTranscribeConfig();
        });
        return;
      }
      if (k === "groqApiKey") {
        sel.value = String(state.transcriptCloud.groqApiKey || "");
        let groqDebounce = null;
        sel.addEventListener("input", () => {
          state.transcriptCloud.groqApiKey = String(sel.value || "").trim();
          // A new key invalidates the previous health probe AND the cached
          // Groq model list (since some keys may be limited to a subset).
          setGroqHealth(null, "not checked");
          state.ai.groq.modelsCache = { fetchedAt: 0, models: [] };
          // First key paste auto-flips provider to Groq for new installs.
          if (state.transcriptCloud.groqApiKey && state.ai.provider !== "groq" && !state.ai._providerExplicit) {
            state.ai.provider = "groq";
            applyProviderUi();
            saveAiConfig();
          }
          if (state.ai.provider === "groq") setAiHealth(null, "not checked");
          clearTimeout(groqDebounce);
          groqDebounce = setTimeout(() => {
            saveTranscriptCloudConfig();
            if (state.ai.provider === "groq") {
              refreshGroqModels().then(() => checkAiHealth()).catch(() => {});
            }
          }, 400);
        });
        return;
      }
      if (k === "aiProvider") {
        sel.value = String(state.ai.provider || "ollama");
        sel.addEventListener("change", () => {
          const v = String(sel.value || "ollama");
          state.ai.provider = (v === "groq" ? "groq" : "ollama");
          state.ai._providerExplicit = true;
          applyProviderUi();
          saveAiConfig();
          checkAiHealth().catch(() => {});
        });
        return;
      }
      if (k === "aiGroqModel" || k === "aiGroqFastModel") {
        const which = k === "aiGroqModel" ? "model" : "fastModel";
        sel.addEventListener("change", () => {
          state.ai.groq[which] = String(sel.value || "").trim() || (which === "model" ? "llama-3.3-70b-versatile" : "llama-3.1-8b-instant");
          saveAiConfig();
          if (state.ai.provider === "groq") checkAiHealth().catch(() => {});
        });
        return;
      }
      if (k === "hfApiKey") {
        sel.value = String(state.transcriptCloud.hfApiKey || "");
        let hfDebounce = null;
        sel.addEventListener("input", () => {
          state.transcriptCloud.hfApiKey = String(sel.value || "").trim();
          setHfHealth(null, "not checked");
          clearTimeout(hfDebounce);
          hfDebounce = setTimeout(() => { saveTranscriptCloudConfig(); }, 400);
        });
        return;
      }
      if (k === "hfFallbackOnRateLimit") {
        sel.checked = !!state.transcriptCloud.hfFallbackOnRateLimit;
        sel.addEventListener("change", () => {
          state.transcriptCloud.hfFallbackOnRateLimit = !!sel.checked;
          saveTranscriptCloudConfig();
        });
        return;
      }
      if (k === "meUsername") {
        sel.value = String(state.me.username || "");
        let meDebounce = null;
        sel.addEventListener("input", () => {
          state.me.username = String(sel.value || "").toLowerCase().replace(/^@/, "").trim();
          clearTimeout(meDebounce);
          meDebounce = setTimeout(() => { saveMeConfig(); }, 400);
        });
        return;
      }
      const AI_CTL_MAP = { aiEndpoint: "endpoint", aiModel: "model", aiVisionModel: "visionModel", aiConcurrency: "concurrency" };
      if (k in AI_CTL_MAP) {
        const ak = AI_CTL_MAP[k];
        sel.value = String(state.ai[ak] ?? "");
        let aiDebounce = null;
        const evt = sel.type === "number" ? "input" : "input";
        sel.addEventListener(evt, () => {
          const v = sel.value;
          if (sel.type === "number") {
            const n = Math.max(1, Math.min(16, Number(v) || 1));
            state.ai[ak] = n;
          } else {
            state.ai[ak] = String(v || "").trim();
          }
          clearTimeout(aiDebounce);
          aiDebounce = setTimeout(() => {
            saveAiConfig();
            if (ak === "endpoint") checkAiHealth().catch(() => {});
          }, 400);
        });
        return;
      }
      // Custom date-range inputs (visible only when state.range === "custom").
      if (k === "rangeFrom" || k === "rangeTo") {
        sel.addEventListener("change", () => {
          state[k] = String(sel.value || "");
          logInfo("filter.change", { key: k, to: state[k] });
          syncHash();
          render();
        });
        return;
      }
      // Custom Limit number input (visible only when state.limitCustom).
      if (k === "limitCustomValue") {
        let limDebounce = null;
        sel.addEventListener("input", () => {
          const n = Math.max(0, Math.floor(Number(sel.value) || 0));
          state.limitCustomValue = n;
          if (state.limitCustom) state.limit = n;
          clearTimeout(limDebounce);
          limDebounce = setTimeout(() => {
            logInfo("filter.change", { key: "limitCustomValue", to: n });
            syncHash();
            render();
          }, 150);
        });
        return;
      }
      if (k === "q") {
        sel.addEventListener("input", () => {
          state.q = sel.value;
          state.focusedIdx = -1;
          clearTimeout(qDebounce);
          qDebounce = setTimeout(() => {
            logInfo("filter.change", { key: "q", to: state.q });
            syncHash();
            render();
          }, 150);
        });
        return;
      }
      sel.addEventListener("change", () => {
        const old = state[k];
        const numericKeys = new Set(["limit", "radarLimit", "minScore", "signalsMinHistScore", "signalsMinSim", "signalsMaxAgeDays", "outlierThresh", "pipelineTopN"]);
        if (k === "sort") updateMetricVisibility(sel.value);
        if (sel.type === "checkbox") {
          state[k] = !!sel.checked;
        } else if (k === "statusFilter") {
          state[k] = sel.value || null;
        } else if (k === "hasFilter") {
          // Single-select drives the existing has* booleans so filtered() is unchanged.
          state.hasNote = sel.value === "note";
          state.hasTranscript = sel.value === "transcript";
          state.hasAi = sel.value === "ai";
          logInfo("filter.change", { key: "hasFilter", to: sel.value || null });
          syncHash(); render();
          return;
        } else if (k === "limit") {
          // "custom" toggles a typeable input; any other value is numeric.
          if (sel.value === "custom") {
            state.limitCustom = true;
            state.limit = state.limitCustomValue || 0;
          } else {
            state.limitCustom = false;
            state.limit = Number(sel.value) || 0;
          }
          updateCustomFilterVisibility();
          // Focus the typeable input for instant entry.
          if (state.limitCustom) {
            const inp = root.querySelector('[data-ctl="limitCustomValue"]');
            if (inp) setTimeout(() => inp.focus(), 0);
          }
        } else if (k === "range") {
          state.range = sel.value;
          updateCustomFilterVisibility();
        } else {
          state[k] = numericKeys.has(k) ? Number(sel.value) : sel.value;
        }
        if (k === "logLevel") {
          logInfo("loglevel.change", { from: old, to: state[k] });
          renderLog();
        } else if (k === "scope") {
          logInfo("filter.change", { key: k, from: old, to: state[k] });
          syncHash();
          // Switching to all-time should pull rows from IDB that may not be
          // in the in-memory Map yet (e.g. older sessions on this profile).
          rehydrateFromStore().catch((err) => logError("store.rehydrate.fail", err));
        } else if (k.startsWith("signals")) {
          logInfo("filter.change", { key: k, from: old, to: state[k] });
          // Mirror the new value across all controls bound to this key
          // (Signals bar + Settings tab share data-ctl names).
          root.querySelectorAll(`[data-ctl="${k}"]`).forEach((s) => {
            if (s === sel) return;
            if (s.type === "checkbox") s.checked = !!state[k];
            else s.value = String(state[k]);
          });
          if (state.signalsOpen) renderSignals();
        } else if (k === "pipelineTopN") {
          // ETA-only — don't trigger a full re-render or hash sync; just
          // refresh the footer ETA tag in place.
          renderPipelineEta();
        } else {
          logInfo("filter.change", { key: k, from: old, to: state[k] });
          syncHash();
          render();
        }
      });
    });

    updateMetricVisibility(state.sort);
    updateCustomFilterVisibility();

    // ---- Sink controls (data-sink-ctl="<sink>.<field>") ----
    root.querySelectorAll("[data-sink-ctl]").forEach((sel) => {
      const [sk, field] = String(sel.dataset.sinkCtl || "").split(".");
      if (!sk || !field || !state.sinks[sk]) return;
      const cur = state.sinks[sk][field];
      if (sel.type === "checkbox") sel.checked = !!cur;
      else sel.value = String(cur || "");
      const evt = sel.type === "checkbox" ? "change" : "input";
      let dbn = null;
      sel.addEventListener(evt, () => {
        if (sel.type === "checkbox") state.sinks[sk][field] = !!sel.checked;
        else state.sinks[sk][field] = String(sel.value || "").trim();
        clearTimeout(dbn);
        dbn = setTimeout(() => { saveSinkConfig(); updateSinkBadges(); }, 250);
      });
    });

    // Re-render the panel when the user opens the Logs section.

    const logsDetails = root.querySelector("[data-logs-details]");
    if (logsDetails) {
      logsDetails.addEventListener("toggle", () => {
        if (logsDetails.open) renderLog();
      });
    }

    root.addEventListener("click", (e) => {
      const t = e.target.closest("[data-act]");
      if (!t || !root.contains(t)) return;
      // Don't toggle <details> when clicking a button inside <summary>.
      if (t.closest("summary")) { e.preventDefault(); }
      const act = t.dataset.act;
      if (act === "collapse") root.classList.toggle("fs-collapsed");
      if (act === "stats-tag") {
        e.preventDefault();
        const tag = t.dataset.tag;
        if (tag) {
          state.hashtagFilter = state.hashtagFilter === tag ? null : tag;
          logInfo("filter.change", { key: "hashtagFilter", to: state.hashtagFilter });
          syncHash();
          render();
        }
      }
      if (act === "stats-keyword") {
        e.preventDefault();
        const kw = t.dataset.keyword;
        if (kw) {
          state.keywordFilter = state.keywordFilter === kw ? null : kw;
          logInfo("filter.change", { key: "keywordFilter", to: state.keywordFilter });
          syncHash();
          render();
        }
      }
      if (act === "stats-niche") {
        e.preventDefault();
        const niche = t.dataset.niche;
        if (niche) {
          state.nicheFilter = state.nicheFilter === niche ? null : niche;
          logInfo("filter.change", { key: "nicheFilter", to: state.nicheFilter });
          syncHash();
          render();
        }
      }
      if (act === "stats-format") {
        e.preventDefault();
        const fmt = t.dataset.format;
        if (fmt) {
          state.formatFilter = state.formatFilter === fmt ? null : fmt;
          logInfo("filter.change", { key: "formatFilter", to: state.formatFilter });
          syncHash();
          render();
        }
      }
      if (act === "stats-detect-formats") {
        e.preventDefault();
        runDetectFormats();
      }
      if (act === "stats-detect-visual-format") {
        e.preventDefault();
        // Cover-AI is per-post + slow; cap at top 20 by outlier score so
        // we don't burn ~minutes on huge scopes. The function already
        // filters to posts with cover URL + _score >= 1.5.
        analyzeCoversTopN(20);
      }
      if (act === "stats-cluster-niches") {
        e.preventDefault();
        labelNicheClusters();
      }
      if (act === "radar") { e.preventDefault(); toggleRadar(); }
      if (act === "radar-close") { e.preventDefault(); state.radar = false; updateView(); }
      if (act === "signals") {
        e.preventDefault();
        state.signalsOpen = !state.signalsOpen;
        logInfo("signals.toggle", { open: state.signalsOpen });
        updateView();
        if (state.signalsOpen) renderSignals();
      }
      if (act === "signals-close") {
        e.preventDefault();
        state.signalsOpen = false;
        updateView();
      }
      if (act === "radar-refresh") { e.preventDefault(); renderRadar(); }
      if (act === "sounds-recompute") {
        e.preventDefault();
        try {
          chrome.runtime.sendMessage({ type: "fs-bg", cmd: "audio-recompute" }, () => {
            // Reload after a short delay; recompute is async in the SW.
            setTimeout(() => { if (state.view === "sounds") renderSounds(); }, 1500);
          });
          logInfo("sounds.recompute.request");
        } catch (err) { logWarn("sounds.recompute.fail", err); }
      }
      if (act === "signals-rescan") {
        e.preventDefault();
        rescanAllSignals().catch((err) => logError("signals.rescan.fail", err));
      }
      if (act === "signals-clear") {
        e.preventDefault();
        if (window.__fsStore) {
          window.__fsStore.clearSignals()
            .then(() => { signalsCache.clear(); logInfo("signals.clear"); renderSignals(); updateSignalsBadge(); })
            .catch((err) => logError("signals.clear.fail", err));
        }
      }
      if (act === "signal-mark-read") {
        e.preventDefault(); e.stopPropagation();
        const id = t.dataset.id;
        if (id && window.__fsStore) {
          const cached = signalsCache.get(id);
          const next = !(cached?.read);
          window.__fsStore.markSignalRead(id, next)
            .then((row) => { if (row) signalsCache.set(id, row); renderSignals(); updateSignalsBadge(); })
            .catch((err) => logWarn("signals.markread.fail", err));
        }
      }
      if (act === "sounds-clear-filter") {
        e.preventDefault();
        state.audioId = null;
        logInfo("filter.change", { key: "audioId", to: null });
        renderSounds();
        render();
      }
      if (act === "niche-add-current") { e.preventDefault(); addCurrentCreator(); }
      if (act === "pin-creator") { e.preventDefault(); togglePinCurrentCreator(); }
      if (act === "niche-add-manual") { e.preventDefault(); addManualCreator(); }
      if (act === "niche-rescrape-stale") { e.preventDefault(); rescrapeStale(); }
      if (act === "niche-cluster") { e.preventDefault(); runClusterNiches(); }
      if (act === "niche-unpin") {
        e.preventDefault();
        const u = t.dataset.username;
        if (u) unpinCreatorNiche(u);
      }
      if (act === "niche-rescrape-one") {
        e.preventDefault();
        const u = t.dataset.username;
        if (u) rescrapeOne(u);
      }
      if (act === "niche-report" || act === "report") {
        e.preventDefault();
        const u = t.dataset.username || (pageScope.kind === "profile" ? pageScope.username : "");
        if (u) generateCreatorReport(u);
      }
      if (act === "niche-remove") {
        e.preventDefault();
        const u = t.dataset.username;
        if (u) removeCreator(u);
      }
      if (act === "niche-voice") {
        e.preventDefault();
        const u = t.dataset.username;
        if (u) regenerateVoiceForCreator(u);
      }
      if (act === "clear") {
        const purgeDb = !!e.shiftKey;
        logInfo("manual.refresh", { had: posts.size, purgeDb });
        posts.clear();
        sessionIds.clear();
        if (collector.running) {
          collector.abort = true;
          collector.reason = "manual-refresh";
        }
        setStatus("idle");
        if (purgeDb && window.__fsStore) {
          window.__fsStore.clearAll()
            .then(() => logInfo("store.cleared"))
            .catch((err) => logError("store.clear.fail", err));
          render();
        } else {
          // Re-fetch the persisted view for the current scope.
          rehydrateFromStore().catch((err) => logError("store.rehydrate.fail", err));
        }
      }
      if (act === "csv") { logInfo("export.csv", { rows: filtered().length }); exportCSV(); }
      if (act === "sync-webapp" || act === "batch-sync") {
        e.preventDefault();
        // If we know we're not connected, route the user to /connect instead
        // of firing a guaranteed-401.
        const btn = e.target.closest('[data-act="sync-webapp"]');
        if (btn && btn.getAttribute("data-conn") === "off") {
          fsSettingsReadStg([FS_SETTINGS_KEYS.appUrl]).then((stg) => {
            const appUrl = (stg[FS_SETTINGS_KEYS.appUrl] || FS_SETTINGS_DEFAULTS.appUrl).replace(/\/+$/, "");
            window.open(appUrl + "/connect", "_blank", "noopener");
          });
          setStatus("opening web app to connect…");
          return;
        }
        setStatus("syncing to web app…");
        const t0 = Date.now();
        logInfo("sync.webapp.start", {});
        // Read posts from the PAGE-origin IDB here in the content script
        // (the SW lives in chrome-extension origin and can't see this DB).
        // We pass the rows directly in the sync message.
        const totalKnown = (typeof filtered === "function" ? filtered().length : 0);
        console.groupCollapsed("%c[FeedSorter] sync \u2192 web app", "color:#16a34a;font-weight:600", "~" + totalKnown + " tracked posts");
        console.log("endpoint: POST /v1/posts/sync");
        // Guard against "Extension context invalidated" — thrown when the
        // extension was reloaded but this tab still has the old content
        // script. The fix is a tab refresh; surface that instead of an
        // ugly uncaught throw.
        if (!chrome.runtime || !chrome.runtime.id) {
          setStatus("reload this tab \u2014 extension was updated");
          logWarn("sync.webapp.fail", { err: "context-invalidated", hint: "refresh tab" });
          console.error("[FeedSorter] sync aborted: extension was reloaded — refresh this tab (Cmd+R) to re-inject the new content script.");
          console.groupEnd();
          return;
        }
        let sent = false;
        const sendIt = (postsToSend) => {
          console.log("sending", postsToSend.length, "posts to SW (sample):", postsToSend[0]);
          chrome.runtime.sendMessage({ type: "fs-bg", cmd: "api.sync-posts", posts: postsToSend }, (r) => {
          const ms = Date.now() - t0;
          if (chrome.runtime.lastError) {
            const msg = chrome.runtime.lastError.message;
            const ctxLost = /context invalidated|extension context/i.test(msg);
            setStatus(ctxLost ? "reload this tab \u2014 extension was updated" : ("sync failed: " + msg));
            logWarn("sync.webapp.fail", { err: msg, ctxLost });
            console.error("[FeedSorter] sync transport failed", msg, ctxLost ? "— refresh this tab." : "");
            console.groupEnd();
            return;
          }
          if (!r || !r.ok) {
            const err = (r && r.err) || "unknown";
            const hint = err === "not-signed-in" ? " — click the extension icon → Sign in" : "";
            setStatus("sync failed: " + err + hint);
            logWarn("sync.webapp.fail", { err, hint });
            console.error("[FeedSorter] sync rejected", { err, status: r && r.status, body: r && r.body });
            console.groupEnd();
            return;
          }
          setStatus(`synced ${r.inserted}/${r.total}` + (r.dropped ? ` (${r.dropped} dropped)` : ""));
          logInfo("sync.webapp.ok", { total: r.total, inserted: r.inserted, dropped: r.dropped, batches: r.batches, ms });
          console.log("%c\u2713 synced", "color:#16a34a", { total: r.total, inserted: r.inserted, dropped: r.dropped, batches: r.batches, ms });
          if (r.sample) console.log("first batch sample (1 post):", r.sample);
          console.groupEnd();
        });
          sent = true;
        };
        try {
          const storeRef = (typeof window !== "undefined" && window.__fsStore) || null;
          const readPosts = storeRef && typeof storeRef.getAll === "function"
            ? storeRef.getAll()
            : Promise.resolve([]);
          readPosts
            .then((rows) => {
              const all = Array.isArray(rows) ? rows : [];
              console.log("read from IDB", all.length, "posts; first id =", all[0] && all[0].id);
              if (all.length === 0) {
                setStatus("sync: no posts in store");
                logWarn("sync.webapp.empty", { knownVisible: totalKnown });
                console.warn("[FeedSorter] sync: store is empty (knownVisible=" + totalKnown + "). Are you on a page that has been collected?");
                console.groupEnd();
                return;
              }
              sendIt(all);
            })
            .catch((err) => {
              const msg = String(err && err.message || err);
              setStatus("sync: failed to read store: " + msg);
              logWarn("sync.webapp.fail", { err: msg, where: "store-read" });
              console.error("[FeedSorter] failed to read store", msg);
              console.groupEnd();
            });
        } catch (err) {
          const msg = String(err && err.message || err);
          setStatus("reload this tab \u2014 extension was updated");
          logWarn("sync.webapp.fail", { err: msg, threw: true });
          console.error("[FeedSorter] sync threw before send — refresh this tab.", msg);
          console.groupEnd();
        }
        void sent;
      }
      if (act === "export-logs") { exportLogs().catch((err) => logError("export.logs.fail", err)); }
      if (act === "export-library") { exportLibrary().catch((err) => logError("export.library.fail", err)); }
      if (act === "collect") startCollect("button");
      if (act === "stop") stopCollect("button");
      if (act === "share") {
        syncHash();
        const url = location.href;
        const done = () => { setStatus("link copied"); logInfo("share.copy", { url }); };
        const fail = (err) => { setStatus("copy failed — see console"); console.warn(url); logWarn("share.copy.fail", err); };
        try {
          if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(url).then(done).catch(fail);
          } else {
            const ta = document.createElement("textarea");
            ta.value = url; document.body.appendChild(ta); ta.select();
            document.execCommand("copy"); ta.remove(); done();
          }
        } catch (e) { fail(e); }
      }
      if (act === "help") showCheatSheet();
      if (act === "settings") showSettingsModal();
      if (act === "upgrade") {
        e.preventDefault();
        e.stopPropagation();
        const src = t.dataset.src || "unknown";
        logInfo("tier.upgrade.click", { src });
        fsSettingsReadStg([FS_SETTINGS_KEYS.appUrl]).then((stg) => {
          const base = stg[FS_SETTINGS_KEYS.appUrl] || FS_SETTINGS_DEFAULTS.appUrl;
          window.open(base.replace(/\/+$/, "") + "/billing", "_blank", "noopener");
        });
      }
      if (act === "close-help") hideCheatSheet();
      if (act === "download") {
        const id = t.dataset.id;
        const p = posts.get(id);
        if (p) {
          e.preventDefault();
          e.stopPropagation();
          downloadVideo(p);
        }
      }
      if (act === "audio-download") {
        const id = t.dataset.id;
        const p = posts.get(id);
        if (p) {
          e.preventDefault();
          e.stopPropagation();
          downloadAudio(p);
        }
      }
      if (act === "ai-pick") {
        e.preventDefault(); e.stopPropagation();
        const k = t.dataset.key, v = t.dataset.val;
        if (k === "hookType") state.hookTypeFilter = state.hookTypeFilter === v ? null : v;
        else if (k === "topic") state.topicFilter = state.topicFilter === v ? null : v;
        else if (k === "angle") state.angleFilter = state.angleFilter === v ? null : v;
        logInfo("filter.change", { key: k + "Filter", to: v });
        syncHash(); render();
      }
      if (act === "pattern-pick") {
        e.preventDefault();
        state.hookTypeFilter = t.dataset.hooktype || null;
        state.topicFilter = t.dataset.topic || null;
        state.view = "current";
        logInfo("filter.change", { key: "pattern", hookType: state.hookTypeFilter, topic: state.topicFilter });
        syncHash();
        updateView();
        render();
      }
      if (act === "ai-batch") {
        e.preventDefault();
        const n = Math.max(1, Number(t.dataset.n) || 10);
        analyzeTopN(n).catch((err) => logError("ai.batch.fail", err, { n }));
      }
      if (act === "ai-analyze") {
        e.preventDefault(); e.stopPropagation();
        const id = t.dataset.id;
        const p = posts.get(id);
        if (p) analyzeOneForUI(p);
      }
      if (act === "dx-analyze") {
        e.preventDefault(); e.stopPropagation();
        const id = t.dataset.id;
        const p = posts.get(id);
        if (p) diagnoseOneForUI(p).catch((err) => logError("diagnose.fail", err, { id }));
      }
      if (act === "dx-batch") {
        e.preventDefault();
        const n = Math.max(1, Number(t.dataset.n) || 10);
        diagnoseTopN(n).catch((err) => logError("diagnose.batch.fail", err, { n }));
      }
      if (act === "transcribe") {
        const id = t.dataset.id;
        const p = posts.get(id);
        if (p) {
          e.preventDefault();
          e.stopPropagation();
          // Open the drawer so the result is visible the moment it lands.
          if (state.expandedId !== id) { state.expandedId = id; render(); }
          transcribeOne(p).catch((err) => logError("transcribe.fail", err, { id }));
        }
      }
      if (act === "transcript-copy") {
        e.preventDefault(); e.stopPropagation();
        const id = t.dataset.id;
        const p = posts.get(id);
        if (p && p.transcript) {
          navigator.clipboard.writeText(p.transcript).then(
            () => setStatus("transcript copied"),
            (err) => logWarn("transcript.copy.fail", err),
          );
        }
      }
      if (act === "tx-health") { e.preventDefault(); checkSidecarHealth().catch((err) => logError("transcribe.health.fail", err)); }
      if (act === "groq-test") { e.preventDefault(); checkGroqHealth().catch((err) => logError("transcribe.groq.health.fail", err)); }
      if (act === "hf-test") { e.preventDefault(); checkHfHealth().catch((err) => logError("transcribe.hf.health.fail", err)); }
      if (act === "ai-health") { e.preventDefault(); checkAiHealth().catch((err) => logError("ai.health.fail", err)); }
      if (act === "ai-groq-refresh") { e.preventDefault(); refreshGroqModels({ force: true }).catch((err) => logError("ai.groq.refresh.fail", err)); }
      if (act === "ai-cache-clear") { e.preventDefault(); clearAiCache().catch((err) => logError("ai.cache.clear.fail", err)); }
      if (act === "bulk-run") {
        e.preventDefault();
        const which = state.bulkAction || "download";
        logInfo("bulk.run", { action: which, threshold: state.outlierThresh });
        if (which === "download") bulkDownloadOutliers().catch((err) => logError("bulk.outliers.fail", err));
        else if (which === "audio") bulkDownloadAudio().catch((err) => logError("bulk.audio.fail", err));
        else if (which === "transcribe") transcribeBulkOutliers().catch((err) => logError("transcribe.bulk.fail", err));
        else if (which === "rewrite") {
          // Rewrite uses the threshold as a min-score filter — take all
          // rows in view with score ≥ threshold (capped at 50).
          const N = Number(state.outlierThresh) || 3;
          const eligible = filtered().filter((p) => (p._score || 0) >= N).length;
          rewriteTopOutliers(Math.min(50, Math.max(1, eligible))).catch((err) => logError("rewrite.batch.fail", err));
        }
      }
      if (act === "bulk-cancel-any") {
        e.preventDefault();
        state.bulk.cancel = true;
        state.transcribeBulk.cancel = true;
        state.rewriteBatch.cancel = true;
        setStatus("cancelling batch…");
      }
      if (act === "bulk-tx-visible") {
        e.preventDefault();
        runBulkTranscribeVisible().catch((err) => logError("bulk.transcribe.fail", err));
      }
      if (act === "bulk-tx-visible-cancel") {
        e.preventDefault();
        state.bulkTx.cancel = true;
        setStatus("cancelling bulk transcribe…");
      }
      if (act === "batch-download") { e.preventDefault(); batchDownload(); }

      if (act === "batch-csv") {
        e.preventDefault();
        logInfo("export.csv", { rows: state.selected.size, selectedOnly: true });
        exportCSV({ selectedOnly: true });
      }
      if (act === "batch-copy") { e.preventDefault(); batchCopyUrls(); }
      if (act === "batch-compare") { e.preventDefault(); openComparePosts(); }
      if (act === "batch-clear") { e.preventDefault(); state.selected.clear(); render(); }
      if (act === "niche-compare") { e.preventDefault(); openCompareCreators(); }
      if (act === "niche-batch-clear") { e.preventDefault(); state.selectedCreators.clear(); renderNiche(); }
      if (act === "modal-close") { e.preventDefault(); closeModal(); }
      if (act === "rw-open") {
        e.preventDefault(); e.stopPropagation();
        const id = t.dataset.id;
        const p = posts.get(id);
        if (p) rewriteOneForUI(p);
      }
      if (act === "rw-tab") {
        e.preventDefault();
        _rwModalState.activeTab = t.dataset.platform;
        renderRewriteModalBody();
      }
      if (act === "rw-copy") {
        e.preventDefault();
        const platform = t.dataset.platform;
        const row = _rwModalState.bundle && _rwModalState.bundle.results[platform];
        const text = _rwCopyText(platform, row);
        if (text) {
          navigator.clipboard.writeText(text).then(
            () => setRewriteStatus(`copied ${platform}`),
            (err) => setRewriteStatus(`copy failed: ${String(err && err.message || err)}`),
          );
        }
      }
      if (act === "rw-regen") {
        e.preventDefault();
        const platform = t.dataset.platform;
        const nudgeEl = els.modal && els.modal.querySelector("[data-rw-nudge]");
        const nudge = nudgeEl ? nudgeEl.value : "";
        rewriteRegenPlatform(_rwModalState.postId, platform, nudge);
      }
      if (act === "rw-regen-all") {
        e.preventDefault();
        const p = posts.get(_rwModalState.postId);
        if (p) rewriteOneForUI(p);
      }

      if (act === "pipeline-run") {
        e.preventDefault();
        const inp = (els.root || document).querySelector('[data-ctl="pipelineTopN"]');
        const n = Math.max(1, Math.min(50, Number(inp && inp.value) || 10));
        runPipelineFromUI(n).catch((err) => logError("pipeline.fail", err));
      }
      if (act === "pl-cancel") { e.preventDefault(); cancelPipelineFromUI(); }
      if (act === "batch-all") { e.preventDefault(); selectAllVisible(); }
      if (act === "batch-none") { e.preventDefault(); state.selected.clear(); render(); }
      if (act === "pin") {
        e.preventDefault(); e.stopPropagation();
        const id = t.dataset.id;
        if (id) togglePin(id);
      }
      if (act === "expand") {
        e.preventDefault(); e.stopPropagation();
        const id = t.dataset.id;
        if (id) {
          state.expandedId = state.expandedId === id ? null : id;
          render();
        }
      }
      if (act === "wh-test") { e.preventDefault(); sendTestPing().catch((err) => logError("webhook.test.fail", err)); }
      if (act === "wh-send-view") { e.preventDefault(); sendViewToGeneric().catch((err) => logError("webhook.send-view.fail", err)); }
      if (act === "wh-send-slack") { e.preventDefault(); sendTopToSlack().catch((err) => logError("webhook.send-slack.fail", err)); }
      if (act === "wh-send-discord") { e.preventDefault(); sendTopToDiscord().catch((err) => logError("webhook.send-discord.fail", err)); }
      if (act === "sink-test") {
        e.preventDefault();
        const sk = t.dataset.sink;
        if (sk) runSinkTest(sk).catch((err) => logError(`sink.${sk}.test.fail`, err));
      }
      if (act === "sink-sync") {
        e.preventDefault();
        const sk = t.dataset.sink;
        if (sk) runSinkSync(sk, filtered()).catch((err) => logError(`sink.${sk}.sync.fail`, err));
      }
      if (act === "wh-weekly-now") {
        e.preventDefault();
        setWebhookStatus("running weekly digest…");
        try {
          chrome.runtime.sendMessage({ type: "fs-bg", cmd: "webhook-weekly-now" }, () => {
            setWebhookStatus("weekly digest dispatched (check webhook receiver)");
          });
        } catch (err) { logError("webhook.weekly.fail", err); setWebhookStatus("weekly trigger failed", "error"); }
      }
      if (act === "tag-remove") {
        e.preventDefault(); e.stopPropagation();
        const id = t.dataset.id;
        const tag = t.dataset.tag;
        if (id && tag) removeTag(id, tag);
      }
    });

    // Tab strip.
    if (els.tabs) {
      els.tabs.addEventListener("click", (e) => {
        const t = e.target.closest("[data-tab]");
        if (!t || !els.tabs.contains(t)) return;
        e.preventDefault();
        const v = t.dataset.tab;
        if (state.view === v) return;
        state.view = v;
        logInfo("view.change", { to: v });
        updateView();
      });
    }

    // Niche panel: change handlers for per-row inputs (niche/interval/auto).
    if (els.nichePanel) {
      els.nichePanel.addEventListener("change", (e) => {
        const row = e.target.closest("[data-creator-row]");
        if (!row) return;
        const u = row.dataset.creatorRow;
        if (!u) return;
        const cls = e.target.className;
        if (cls.includes("fs-creator-check")) {
          if (e.target.checked) state.selectedCreators.add(u);
          else state.selectedCreators.delete(u);
          logDebug("select.creator.toggle", { u, selected: e.target.checked, n: state.selectedCreators.size });
          updateNicheBatchUI();
        } else if (cls.includes("fs-creator-niche")) {
          updateCreator(u, { niche: e.target.value, _userNiche: true });
        } else if (cls.includes("fs-creator-interval")) {
          const n = Number(e.target.value);
          if (n > 0) updateCreator(u, { scrapeIntervalHrs: n });
        } else if (cls.includes("fs-creator-auto")) {
          updateCreator(u, { autoCollect: !!e.target.checked });
        }
      });
    }

    // Chip filters.
    if (els.chips) {
      els.chips.addEventListener("click", (e) => {
        const c = e.target.closest("[data-chip]");
        if (!c || !els.chips.contains(c)) return;
        e.preventDefault();
        const kind = c.dataset.chip;
        if (kind === "pinnedOnly") {
          state.pinnedOnly = !state.pinnedOnly;
          logInfo("filter.change", { key: "pinnedOnly", to: state.pinnedOnly });
        } else if (kind === "hasNote") {
          state.hasNote = !state.hasNote;
          logInfo("filter.change", { key: "hasNote", to: state.hasNote });
        } else if (kind === "hasTranscript") {
          state.hasTranscript = !state.hasTranscript;
          logInfo("filter.change", { key: "hasTranscript", to: state.hasTranscript });
        } else if (kind === "status") {
          const s = c.dataset.status;
          state.statusFilter = state.statusFilter === s ? null : s;
          logInfo("filter.change", { key: "statusFilter", to: state.statusFilter });
        } else if (kind === "hashtag") {
          state.hashtagFilter = null;
          logInfo("filter.change", { key: "hashtagFilter", to: null });
        } else if (kind === "keyword") {
          state.keywordFilter = null;
          logInfo("filter.change", { key: "keywordFilter", to: null });
        } else if (kind === "niche") {
          state.nicheFilter = null;
          logInfo("filter.change", { key: "nicheFilter", to: null });
        } else if (kind === "format") {
          state.formatFilter = null;
          logInfo("filter.change", { key: "formatFilter", to: null });
        } else if (kind === "hasAi") {
          state.hasAi = !state.hasAi;
          logInfo("filter.change", { key: "hasAi", to: state.hasAi });
        } else if (kind === "hookType") {
          state.hookTypeFilter = null;
          logInfo("filter.change", { key: "hookTypeFilter", to: null });
        } else if (kind === "topic") {
          state.topicFilter = null;
          logInfo("filter.change", { key: "topicFilter", to: null });
        } else if (kind === "angle") {
          state.angleFilter = null;
          logInfo("filter.change", { key: "angleFilter", to: null });
        }
        syncHash();
        render();
      });
    }

    // Signals tab: unread-only chip.
    if (els.signalsPanel) {
      els.signalsPanel.addEventListener("click", (e) => {
        const chip = e.target.closest("[data-signals-chip]");
        if (chip && els.signalsPanel.contains(chip)) {
          e.preventDefault();
          state.signalsUnreadOnly = !state.signalsUnreadOnly;
          chip.classList.toggle("fs-chip-active", state.signalsUnreadOnly);
          renderSignals();
        }
      });
    }

    // Sounds tab: chip toggles + row click filter.
    if (els.soundsPanel) {
      els.soundsPanel.addEventListener("click", (e) => {
        const chip = e.target.closest("[data-sound-chip]");
        if (chip && els.soundsPanel.contains(chip)) {
          e.preventDefault();
          const k = chip.dataset.soundChip;
          const key = "audio" + k[0].toUpperCase() + k.slice(1);
          state[key] = !state[key];
          logInfo("filter.change", { key, to: state[key] });
          renderSounds();
          return;
        }
        // Row click — set audio filter on Current tab. Ignore link clicks.
        if (e.target.closest("[data-sound-link]")) return;
        const row = e.target.closest("[data-sound-id]");
        if (!row || !els.soundsPanel.contains(row)) return;
        e.preventDefault();
        const id = row.dataset.soundId;
        if (!id) return;
        state.audioId = state.audioId === id ? null : id;
        logInfo("filter.change", { key: "audioId", to: state.audioId });
        renderSounds();
        // Switch to Current so the user immediately sees the filtered posts.
        if (state.audioId && state.view !== "current") {
          state.view = "current";
          updateView();
        }
        render();
      });
    }

    // Per-row delegated handlers for status select + note textarea + tag input.
    const onListChange = (e) => {
      const sel = e.target.closest(".fs-status-select");
      if (sel) {
        const id = sel.dataset.id;
        const v = sel.value || null;
        if (id) setStatus2(id, v);
        return;
      }
      // Checkbox toggling — works for both list + pinned list.
      const cb = e.target.closest(".fs-check");
      if (cb) {
        const id = cb.dataset.id;
        if (!id) return;
        if (cb.checked) state.selected.add(id);
        else state.selected.delete(id);
        logDebug("select.toggle", { id, selected: cb.checked, n: state.selected.size });
        renderBatchBar();
        // Sync the row visual state across both lists.
        const rows = (els.root || document).querySelectorAll(`.fs-row[data-row-id="${CSS.escape(id)}"]`);
        rows.forEach((r) => r.classList.toggle("fs-selected", cb.checked));
      }
    };
    const onListInput = (e) => {
      const ta = e.target.closest(".fs-note-input");
      if (ta) {
        const id = ta.dataset.id;
        if (id) queueMetaWrite(id, { note: ta.value }, 500);
        return;
      }
    };
    const onListKeydown = (e) => {
      const ti = e.target.closest(".fs-tag-input");
      if (!ti) return;
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        const id = ti.dataset.id;
        const v = (ti.value || "").trim().replace(/^#/, "");
        if (id && v) {
          addTag(id, v);
          ti.value = "";
        }
      } else if (e.key === "Backspace" && !ti.value) {
        const id = ti.dataset.id;
        const m = getMetaSync(id);
        if (id && m && m.tags.length) {
          removeTag(id, m.tags[m.tags.length - 1]);
        }
      }
    };
    els.list.addEventListener("change", onListChange);
    els.list.addEventListener("input", onListInput);
    els.list.addEventListener("keydown", onListKeydown);

    // Checkbox toggle (delegated). Don't trigger row hover/preview swap.
    els.list.addEventListener("change", (e) => {
      const cb = e.target.closest(".fs-check");
      if (!cb || !els.list.contains(cb)) return;
      const id = cb.dataset.id;
      if (!id) return;
      if (cb.checked) state.selected.add(id);
      else state.selected.delete(id);
      logDebug("select.toggle", { id, selected: cb.checked, n: state.selected.size });
      renderBatchBar();
      const row = cb.closest(".fs-row");
      if (row) row.classList.toggle("fs-selected", cb.checked);
    });
    els.list.addEventListener("click", (e) => {
      // Stop checkbox clicks from propagating to row link/anchor handlers.
      if (e.target.closest(".fs-check")) e.stopPropagation();
    });

    // drag
    const header = root.querySelector("[data-drag]");
    let dragging = null;
    header.addEventListener("mousedown", (e) => {
      if (e.target.closest("[data-act]")) return;
      const r = root.getBoundingClientRect();
      dragging = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      root.style.left = Math.max(0, e.clientX - dragging.dx) + "px";
      root.style.top = Math.max(0, e.clientY - dragging.dy) + "px";
      root.style.right = "auto";
    });
    window.addEventListener("mouseup", () => (dragging = null));

    // -------- hover-to-preview (delegated) --------
    let hoverTimer = null;
    let hoveredLink = null;
    const restoreImg = (link) => {
      const cover = link.dataset.cover || "";
      link.innerHTML = `<img class="fs-thumb" src="${escHTML(cover)}" referrerpolicy="no-referrer" loading="lazy" />`;
    };
    // Render the preview video inside a CLOSED shadow root so 3rd-party
    // browser extensions (video downloaders, transcribers) can't see the
    // <video> element and inject their own hover buttons over our row.
    const swapToVideo = (link, url) => {
      link.textContent = "";
      const host = document.createElement("span");
      host.dataset.fsVideoHost = "1";
      host.style.cssText = "display:block;line-height:0;";
      const root = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = ".v{width:56px;height:72px;object-fit:cover;border-radius:4px;background:#0f1018;display:block;pointer-events:none;}";
      const v = document.createElement("video");
      v.className = "v";
      v.src = url;
      v.autoplay = true; v.muted = true; v.loop = true; v.playsInline = true;
      v.preload = "metadata";
      v.setAttribute("controlslist", "nodownload noremoteplayback");
      v.disablePictureInPicture = true;
      v.disableRemotePlayback = true;
      root.appendChild(style);
      root.appendChild(v);
      link.appendChild(host);
    };
    els.list.addEventListener("mouseover", (e) => {
      const link = e.target.closest(".fs-thumb-link");
      if (!link || !els.list.contains(link)) return;
      if (link === hoveredLink) return;
      if (hoveredLink) { clearTimeout(hoverTimer); restoreImg(hoveredLink); }
      hoveredLink = link;
      const vurl = link.dataset.video;
      if (!vurl) return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        if (hoveredLink === link) swapToVideo(link, vurl);
      }, 300);
    });
    els.list.addEventListener("mouseout", (e) => {
      const link = e.target.closest(".fs-thumb-link");
      if (!link) return;
      if (link.contains(e.relatedTarget)) return;
      clearTimeout(hoverTimer);
      if (hoveredLink === link) {
        if (link.querySelector("[data-fs-video-host]")) restoreImg(link);
        hoveredLink = null;
      }
    });

    // -------- keyboard shortcuts --------
    document.addEventListener("keydown", (e) => {
      if (e.target && e.target.matches && e.target.matches("input,textarea,select")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const list = filtered();
      const setFocus = (idx) => {
        state.focusedIdx = Math.max(-1, Math.min(list.length - 1, idx));
        applyFocusClass();
      };
      switch (e.key) {
        case "j": setFocus((state.focusedIdx < 0 ? -1 : state.focusedIdx) + 1); e.preventDefault(); break;
        case "k": setFocus((state.focusedIdx <= 0 ? 1 : state.focusedIdx) - 1); e.preventDefault(); break;
        case "o": {
          const p = list[state.focusedIdx];
          if (p?.url) { window.open(p.url, "_blank", "noopener"); e.preventDefault(); }
          break;
        }
        case "d": {
          const p = list[state.focusedIdx];
          if (p) { downloadVideo(p); e.preventDefault(); }
          break;
        }
        case "x": {
          const p = list[state.focusedIdx];
          if (p) {
            if (state.selected.has(p.id)) state.selected.delete(p.id);
            else state.selected.add(p.id);
            logDebug("select.toggle", { id: p.id, selected: state.selected.has(p.id), n: state.selected.size, via: "keyboard" });
            render();
            e.preventDefault();
          }
          break;
        }
        case "p": {
          const p = list[state.focusedIdx];
          if (p) { togglePin(p.id); e.preventDefault(); }
          break;
        }
        case "c": startCollect("keyboard"); e.preventDefault(); break;
        case "s": stopCollect("keyboard"); e.preventDefault(); break;
        case "/": if (els.search) { els.search.focus(); els.search.select(); e.preventDefault(); } break;
        case "?": showCheatSheet(); e.preventDefault(); break;
        case "Escape":
          if (els.modal) { closeModal(); e.preventDefault(); }
          else if (els.cheat && !els.cheat.hidden) { hideCheatSheet(); e.preventDefault(); }
          else if (state.focusedIdx !== -1) { setFocus(-1); e.preventDefault(); }
          break;
      }
    });
  };

  const applyFocusClass = () => {
    if (!els.list) return;
    const rows = els.list.querySelectorAll(".fs-row");
    rows.forEach((r, i) => r.classList.toggle("fs-focused", i === state.focusedIdx));
    const cur = rows[state.focusedIdx];
    if (cur) cur.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const showCheatSheet = () => {
    if (els.cheat) { els.cheat.hidden = false; return; }
    const m = document.createElement("div");
    m.className = "fs-cheat";
    m.innerHTML = `
      <div class="fs-cheat-card">
        <div class="fs-cheat-head">
          <b>Keyboard shortcuts</b>
          <button class="fs-icon-btn" data-act="close-help">×</button>
        </div>
        <table>
          <tr><td><kbd>j</kbd> / <kbd>k</kbd></td><td>Next / previous row</td></tr>
          <tr><td><kbd>o</kbd></td><td>Open focused post</td></tr>
          <tr><td><kbd>d</kbd></td><td>Download focused video</td></tr>
          <tr><td><kbd>x</kbd></td><td>Toggle selection on focused row</td></tr>
          <tr><td><kbd>p</kbd></td><td>Pin / unpin focused row</td></tr>
          <tr><td><kbd>c</kbd></td><td>Collect all</td></tr>
          <tr><td><kbd>s</kbd></td><td>Stop collecting</td></tr>
          <tr><td><kbd>/</kbd></td><td>Focus search</td></tr>
          <tr><td><kbd>?</kbd></td><td>This help</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>Clear focus / close</td></tr>
        </table>
      </div>`;
    els.root.appendChild(m);
    els.cheat = m;
    m.addEventListener("click", (e) => { if (e.target === m) hideCheatSheet(); });
  };
  const hideCheatSheet = () => { if (els.cheat) els.cheat.hidden = true; };

  // -------- Settings modal (gear button next to ?) --------
  // Three sections: Connection (sign-in + tier), Settings (API URL, Web URL),
  // Dev (BYOK overrides for Groq / OpenAI / WhisperX URL). Settings are
  // persisted via SW message handlers `api.set-base` / `api.set-token` and
  // dev keys are written directly to `chrome.storage.local`.
  const FS_SETTINGS_KEYS = {
    apiBase: "fs.api.baseUrl",
    appUrl: "fs.app.url",
    groq: "fs.dev.groq_key",
    openai: "fs.dev.openai_key",
    whisperx: "fs.dev.whisperx_url",
  };
  const FS_SETTINGS_DEFAULTS = {
    apiBase: "http://localhost:8787",
    appUrl: "http://localhost:3000",
  };
  const fsSettingsSendBg = (cmd, payload) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(Object.assign({ type: "fs-bg", cmd }, payload || {}), (r) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, err: chrome.runtime.lastError.message });
        resolve(r || { ok: false });
      });
    } catch (err) {
      resolve({ ok: false, err: String(err && err.message || err) });
    }
  });
  const fsSettingsReadStg = (keys) => new Promise((resolve) => {
    try { chrome.storage.local.get(keys, resolve); } catch (_) { resolve({}); }
  });
  const fsSettingsWriteStg = (obj) => new Promise((resolve) => {
    try { chrome.storage.local.set(obj, resolve); } catch (_) { resolve(); }
  });
  const fsSettingsEscAttr = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const showSettingsModal = async () => {
    const stg = await fsSettingsReadStg([
      FS_SETTINGS_KEYS.apiBase, FS_SETTINGS_KEYS.appUrl,
      FS_SETTINGS_KEYS.groq, FS_SETTINGS_KEYS.openai, FS_SETTINGS_KEYS.whisperx,
    ]);
    const apiBase = stg[FS_SETTINGS_KEYS.apiBase] || FS_SETTINGS_DEFAULTS.apiBase;
    const appUrl = stg[FS_SETTINGS_KEYS.appUrl] || FS_SETTINGS_DEFAULTS.appUrl;
    const groq = stg[FS_SETTINGS_KEYS.groq] || "";
    const openaiKey = stg[FS_SETTINGS_KEYS.openai] || "";
    const whisperx = stg[FS_SETTINGS_KEYS.whisperx] || "";

    const m = openModal("Feed Sorter — Settings", `
      <div class="fs-settings">
        <div class="fs-settings-section" data-fs-conn>
          <div class="fs-settings-row">
            <span class="fs-conn-dot" data-fs-conn-dot data-state="unknown" style="width:10px;height:10px"></span>
            <div style="flex:1">
              <div data-fs-conn-status>Checking…</div>
              <div class="muted" data-fs-conn-email></div>
            </div>
            <span class="fs-tier-pill" data-fs-conn-tier hidden>free</span>
          </div>
          <div class="fs-settings-row">
            <button class="fs-icon-btn" data-act="fs-settings-signin">Sign in / Connect</button>
            <button class="fs-icon-btn" data-act="fs-settings-open-web">Open web app</button>
          </div>
        </div>

        <h4>Endpoints</h4>
        <label>API base URL</label>
        <input type="url" data-fs-input="apiBase" value="${fsSettingsEscAttr(apiBase)}" placeholder="http://localhost:8787">
        <div class="fs-help">Where the extension sends sync + transcribe.</div>
        <label>Web app URL</label>
        <input type="url" data-fs-input="appUrl" value="${fsSettingsEscAttr(appUrl)}" placeholder="http://localhost:3000">
        <div class="fs-help">Used by the &ldquo;Sign in / Connect&rdquo; button.</div>

        <h4>Dev keys <span class="muted">(stored in chrome.storage.local)</span></h4>
        <label>Groq API key (extraction LLM)</label>
        <input type="password" autocomplete="off" data-fs-input="groq" value="${fsSettingsEscAttr(groq)}" placeholder="gsk_…">
        <label>OpenAI API key (embeddings)</label>
        <input type="password" autocomplete="off" data-fs-input="openai" value="${fsSettingsEscAttr(openaiKey)}" placeholder="sk-…">
        <label>WhisperX URL (local sidecar)</label>
        <input type="url" data-fs-input="whisperx" value="${fsSettingsEscAttr(whisperx)}" placeholder="http://localhost:8788">
        <div class="fs-help">Leave blank to use Groq Whisper (server-side).</div>

        <div class="fs-settings-actions">
          <button class="fs-icon-btn fs-primary" data-act="fs-settings-save">Save</button>
          <button class="fs-icon-btn" data-act="fs-settings-clear">Clear dev keys</button>
          <span class="fs-help" data-fs-settings-status></span>
        </div>
      </div>
    `);

    const refreshConn = async () => {
      const cfg = await fsSettingsSendBg("api.config");
      const dot = m.querySelector("[data-fs-conn-dot]");
      const statusEl = m.querySelector("[data-fs-conn-status]");
      const emailEl = m.querySelector("[data-fs-conn-email]");
      const tierEl = m.querySelector("[data-fs-conn-tier]");
      if (!cfg || !cfg.token) {
        dot && dot.setAttribute("data-state", "off");
        statusEl.textContent = "Not signed in";
        emailEl.textContent = "";
        tierEl.hidden = true;
        return;
      }
      const me = await fsSettingsSendBg("api.request", { path: "/v1/me" });
      if (me.ok && me.body && me.body.id) {
        dot && dot.setAttribute("data-state", "on");
        statusEl.textContent = "Connected";
        emailEl.textContent = me.body.email || "";
        tierEl.textContent = me.body.tier || "free";
        tierEl.hidden = false;
        tierEl.classList.toggle("fs-tier-pro", me.body.tier === "pro" || me.body.tier === "studio");
      } else {
        dot && dot.setAttribute("data-state", "off");
        statusEl.textContent = me.status === 401 ? "Session expired" : "Reachable, not signed in";
        emailEl.textContent = me.err || "";
        tierEl.hidden = true;
      }
    };
    refreshConn();

    m.addEventListener("click", async (ev) => {
      const t = ev.target.closest("[data-act]");
      if (!t) return;
      const act = t.dataset.act;
      if (act === "modal-close") { closeModal(); return; }
      const status = m.querySelector("[data-fs-settings-status]");
      const v = (k) => m.querySelector(`[data-fs-input="${k}"]`).value.trim();
      if (act === "fs-settings-save") {
        const apiVal = v("apiBase") || FS_SETTINGS_DEFAULTS.apiBase;
        const appVal = v("appUrl") || FS_SETTINGS_DEFAULTS.appUrl;
        await fsSettingsWriteStg({
          [FS_SETTINGS_KEYS.apiBase]: apiVal,
          [FS_SETTINGS_KEYS.appUrl]: appVal,
          [FS_SETTINGS_KEYS.groq]: v("groq"),
          [FS_SETTINGS_KEYS.openai]: v("openai"),
          [FS_SETTINGS_KEYS.whisperx]: v("whisperx"),
        });
        await fsSettingsSendBg("api.set-base", { baseUrl: apiVal });
        status.textContent = "✓ saved";
        setTimeout(() => (status.textContent = ""), 2000);
        refreshConn();
      } else if (act === "fs-settings-clear") {
        if (!confirm("Clear stored Groq / OpenAI / WhisperX values?")) return;
        await fsSettingsWriteStg({
          [FS_SETTINGS_KEYS.groq]: "",
          [FS_SETTINGS_KEYS.openai]: "",
          [FS_SETTINGS_KEYS.whisperx]: "",
        });
        for (const k of ["groq", "openai", "whisperx"]) {
          const el = m.querySelector(`[data-fs-input="${k}"]`);
          if (el) el.value = "";
        }
        status.textContent = "✓ cleared";
        setTimeout(() => (status.textContent = ""), 2000);
      } else if (act === "fs-settings-signin") {
        const stored = await fsSettingsReadStg([FS_SETTINGS_KEYS.appUrl]);
        const target = (stored[FS_SETTINGS_KEYS.appUrl] || FS_SETTINGS_DEFAULTS.appUrl) + "/connect";
        window.open(target, "_blank", "noopener");
      } else if (act === "fs-settings-open-web") {
        const stored = await fsSettingsReadStg([FS_SETTINGS_KEYS.appUrl]);
        const target = stored[FS_SETTINGS_KEYS.appUrl] || FS_SETTINGS_DEFAULTS.appUrl;
        window.open(target, "_blank", "noopener");
      }
    });
  };

  // -------- Compare modal --------
  // Renders inside `.fs-root` so IG SPA navs that wipe document.body's other
  // children don't take it down. Esc / backdrop click / × button all close.

  const closeModal = () => {
    if (els.modal) {
      els.modal.remove();
      els.modal = null;
      logDebug("compare.close");
    }
  };

  const openModal = (titleHTML, bodyHTML) => {
    closeModal();
    const m = document.createElement("div");
    m.className = "fs-modal";
    m.innerHTML = `
      <div class="fs-modal-card" role="dialog" aria-modal="true">
        <div class="fs-modal-head">
          <b>${titleHTML}</b>
          <button class="fs-icon-btn" data-act="modal-close" aria-label="Close">×</button>
        </div>
        <div class="fs-modal-body">${bodyHTML}</div>
      </div>`;
    (els.root || document.body).appendChild(m);
    els.modal = m;
    m.addEventListener("click", (e) => { if (e.target === m) closeModal(); });
    return m;
  };

  // Classify the hook (caption first line) into a coarse type so we can
  // surface "different hookType" diffs in the compare modal.
  const hookTypeOf = (p) => {
    const h = (p.hook || extractHook(p.desc || "")).trim();
    if (!h) return "none";
    const raw = (p.desc || "").split("\n")[0].trim();
    if (/\?\s*$/.test(raw)) return "question";
    if (/^(how |why |what |when |where |who )/i.test(h)) return "how-to";
    if (/^\d+\b/.test(h)) return "list";
    if (/!\s*$/.test(raw)) return "exclamation";
    if (/^(stop |don.?t |never |avoid )/i.test(h)) return "warning";
    if (/^(i |my )/i.test(h)) return "personal";
    return "statement";
  };

  const HASHTAG_PARSE_RE = /#([\w_]+)/g;
  const hashtagsOf = (p) => {
    const out = [];
    const s = p.desc || "";
    let m;
    HASHTAG_PARSE_RE.lastIndex = 0;
    while ((m = HASHTAG_PARSE_RE.exec(s))) out.push(m[1]);
    return out;
  };

  // Compare 2–3 selected posts.
  const openComparePosts = () => {
    const sel = selectedPosts();
    if (sel.length < 2 || sel.length > 3) {
      setStatus(`select 2–3 posts to compare (have ${sel.length})`);
      logInfo("compare.posts.bad", { n: sel.length });
      return;
    }
    // Enrich with derived score so the modal shows the same _score the list does.
    const nowMs = Date.now();
    const enriched = computeOutliers(sel.map((p) => {
      const d = computeDerived(p, nowMs);
      const cpr = (p.comments || 0) / Math.max(p.likes || 0, 1) * 1000;
      const vph = vphSincePosted(p, nowMs);
      return { ...p, ...d, velocity: d.velocityViewsPerHr, cpr, vph };
    }), state.metric);

    // Same-author diff highlights: compare each post against the *max*
    // peer in the set on a few axes. Only meaningful when authors match.
    const allSameAuthor = enriched.every((p) => p.author && p.author === enriched[0].author);
    const capLens = enriched.map((p) => (p.desc || "").length);
    const maxCap = Math.max(...capLens, 1);
    const minCap = Math.min(...capLens.filter((x) => x > 0), maxCap);
    const scores = enriched.map((p) => p._score || 0);
    const maxScore = Math.max(...scores, 0);
    const hookTypes = enriched.map(hookTypeOf);
    const hookTypeSet = new Set(hookTypes);
    const formats = enriched.map(formatOf);
    const formatSet = new Set(formats);

    const cols = enriched.map((p, i) => {
      const tags = hashtagsOf(p);
      const dur = Math.round(p.videoDuration || 0);
      const ht = hookTypes[i];
      const fmt2 = formats[i];
      // Per-post diff badges (only meaningful if same author).
      const badges = [];
      if (allSameAuthor && enriched.length > 1) {
        const cl = capLens[i];
        if (cl > 0 && minCap > 0 && cl >= 2 * minCap && cl === maxCap) {
          const ratio = (cl / minCap).toFixed(1);
          badges.push(`<span class="fs-cmp-diff up">caption ${ratio}× longer</span>`);
        } else if (cl > 0 && cl === minCap && maxCap >= 2 * minCap) {
          const ratio = (maxCap / cl).toFixed(1);
          badges.push(`<span class="fs-cmp-diff down">caption ${ratio}× shorter</span>`);
        }
        if ((p._score || 0) === maxScore && maxScore > 0 && scores.filter((s) => s > 0).length >= 2) {
          badges.push(`<span class="fs-cmp-diff up">top score</span>`);
        }
        if (hookTypeSet.size > 1) {
          badges.push(`<span class="fs-cmp-diff neutral">hook: ${escHTML(ht)}</span>`);
        }
        if (formatSet.size > 1) {
          badges.push(`<span class="fs-cmp-diff neutral">${escHTML(fmt2)}</span>`);
        }
      }
      const audio = p.audio ? `${escHTML(p.audio.title || "audio")}${p.audio.artist ? " · " + escHTML(p.audio.artist) : ""}` : "—";
      const mediaHTML = p.videoUrl
        ? `<video src="${escHTML(p.videoUrl)}" muted loop playsinline preload="metadata" controls></video>`
        : `<img src="${escHTML(p.cover)}" referrerpolicy="no-referrer" />`;
      return `<div class="fs-cmp-col">
        <div class="fs-cmp-media">${mediaHTML}</div>
        <div class="fs-cmp-author"><a href="${escHTML(p.url)}" target="_blank" rel="noopener">@${escHTML(p.author || "unknown")}</a> ${badges.join(" ")}</div>
        <div class="fs-cmp-meta">${escHTML(fmt2)} · ${fmtDate(p.createTime)} · hook: ${escHTML(ht)}</div>
        <div class="fs-cmp-caption">${escHTML(p.desc || "(no caption)")}</div>
        <div class="fs-cmp-stats">
          <span class="k">Score</span><span class="v">${fmtScore(p._score || 0)}</span>
          <span class="k">Likes</span><span class="v">${fmt(p.likes || 0)}</span>
          <span class="k">Views</span><span class="v">${fmt(p.views || 0)}</span>
          <span class="k">Comments</span><span class="v">${fmt(p.comments || 0)}</span>
          <span class="k">CPR</span><span class="v">${(p.cpr || 0).toFixed(1)}</span>
          <span class="k">Velocity</span><span class="v">${p.velocityReady || p.snapshotCount > 1 || (p.snapshotCount > 0 && p.lastSeenAt > p.firstSeenAt) ? fmt(Math.round(p.velocityViewsPerHr || 0)) + "/hr" : "—"}</span>
          <span class="k">Duration</span><span class="v">${dur ? dur + "s" : "—"}</span>
          <span class="k">Caption len</span><span class="v">${capLens[i]}</span>
        </div>
        <div class="fs-cmp-meta">Audio: ${audio}</div>
        <div class="fs-cmp-tags">${tags.length ? tags.map((t) => `<span class="fs-cmp-tag">#${escHTML(t)}</span>`).join("") : '<span style="color:#a8a9b3;font-size:10.5px">no hashtags</span>'}</div>
      </div>`;
    }).join("");

    const subtitle = allSameAuthor
      ? `Same author · @${escHTML(enriched[0].author)} · ${enriched.length} posts`
      : `${enriched.length} posts · mixed authors`;
    const body = `
      <div style="color:#a8a9b3;margin-bottom:8px;font-size:11px">${subtitle}</div>
      <div class="fs-cmp-grid" style="--fs-cmp-n:${enriched.length}">${cols}</div>`;
    openModal(`Compare posts`, body);
    logInfo("compare.posts.open", { n: enriched.length, sameAuthor: allSameAuthor });
  };

  // Build an inline SVG time-series. ~80 LOC budget; pure DOM strings.
  // x = createTime (unix s), y = log10(likes+1). One color per profile;
  // dashed horizontal line per profile at its median log10(likes+1).
  const buildCompareChart = (series) => {
    const W = 720, H = 280;
    const pad = { l: 44, r: 12, t: 12, b: 28 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    let xs = [], ys = [];
    for (const s of series) for (const p of s.points) { xs.push(p.t); ys.push(p.y); }
    if (!xs.length) {
      return `<svg class="fs-cmp-chart" viewBox="0 0 ${W} ${H}"><text x="${W/2}" y="${H/2}" fill="#a8a9b3" text-anchor="middle" font-size="12">No data</text></svg>`;
    }
    const xMin = Math.min(...xs), xMax = Math.max(...xs);
    const yMin = 0, yMax = Math.max(...ys, 1);
    const sx = (t) => pad.l + ((t - xMin) / Math.max(xMax - xMin, 1)) * iw;
    const sy = (y) => pad.t + ih - ((y - yMin) / Math.max(yMax - yMin, 1)) * ih;
    // Y gridlines at every integer power of 10 within range.
    const grid = [];
    for (let v = Math.floor(yMin); v <= Math.ceil(yMax); v++) {
      const yy = sy(v);
      grid.push(`<line x1="${pad.l}" x2="${W - pad.r}" y1="${yy}" y2="${yy}" stroke="#2a2b38" stroke-width="1"/>`);
      grid.push(`<text x="${pad.l - 6}" y="${yy + 3}" fill="#a8a9b3" font-size="10" text-anchor="end">${Math.round(Math.pow(10, v)).toLocaleString()}</text>`);
    }
    // X axis: 4 evenly spaced date ticks.
    const xTicks = [];
    for (let i = 0; i <= 4; i++) {
      const t = xMin + ((xMax - xMin) * i) / 4;
      const xx = sx(t);
      xTicks.push(`<text x="${xx}" y="${H - 8}" fill="#a8a9b3" font-size="10" text-anchor="middle">${new Date(t * 1000).toLocaleDateString(undefined, { month: "short", year: "2-digit" })}</text>`);
      xTicks.push(`<line x1="${xx}" x2="${xx}" y1="${pad.t}" y2="${pad.t + ih}" stroke="#2a2b38" stroke-width="1"/>`);
    }
    const dotsAndLines = series.map((s) => {
      const dots = s.points.map((p) => `<circle cx="${sx(p.t).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="3" fill="${s.color}" opacity="0.85"><title>@${s.username}\n${new Date(p.t * 1000).toLocaleDateString()}\n${Math.round(Math.pow(10, p.y) - 1).toLocaleString()} likes</title></circle>`).join("");
      const med = s.medianY;
      const medLine = Number.isFinite(med)
        ? `<line x1="${pad.l}" x2="${W - pad.r}" y1="${sy(med).toFixed(1)}" y2="${sy(med).toFixed(1)}" stroke="${s.color}" stroke-width="1" stroke-dasharray="4 3" opacity="0.7"/>`
        : "";
      return medLine + dots;
    }).join("");
    return `<svg class="fs-cmp-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      ${grid.join("")}${xTicks.join("")}
      <text x="${pad.l - 36}" y="${pad.t + 10}" fill="#a8a9b3" font-size="10">likes</text>
      ${dotsAndLines}
    </svg>`;
  };

  const PALETTE = ["#6e8eff", "#ff8a65", "#9be8a4", "#f0a4f0", "#ffd28a"];

  const openCompareCreators = async () => {
    const usernames = [...state.selectedCreators];
    if (usernames.length < 2 || usernames.length > 3) {
      setStatus(`select 2–3 creators to compare (have ${usernames.length})`);
      logInfo("compare.creators.bad", { n: usernames.length });
      return;
    }
    if (!window.__fsStore) {
      setStatus("IDB not available");
      logWarn("compare.creators.no-store");
      return;
    }
    openModal("Compare creators", `<div style="color:#a8a9b3">Loading…</div>`);
    logInfo("compare.creators.open", { usernames });

    const series = [];
    for (let i = 0; i < usernames.length; i++) {
      const u = usernames[i];
      let rows = [];
      try { rows = await window.__fsStore.getByAuthor(u) || []; }
      catch (e) { logWarn("compare.creators.read.fail", { u, err: String(e) }); }
      const points = [];
      const fmts = { reel: 0, carousel: 0, single: 0 };
      const likeArr = [];
      for (const p of rows) {
        if (!p.createTime) continue;
        const likes = p.likes || 0;
        const y = Math.log10(likes + 1);
        points.push({ t: p.createTime, y });
        likeArr.push(likes);
        fmts[formatOf(p)] = (fmts[formatOf(p)] || 0) + 1;
      }
      likeArr.sort((a, b) => a - b);
      const med = likeArr.length ? likeArr[Math.floor(likeArr.length / 2)] : 0;
      const p90 = likeArr.length ? likeArr[Math.min(likeArr.length - 1, Math.floor(likeArr.length * 0.9))] : 0;
      const topFormat = Object.entries(fmts).sort((a, b) => b[1] - a[1])[0];
      series.push({
        username: u,
        color: PALETTE[i % PALETTE.length],
        points,
        count: rows.length,
        median: med,
        p90,
        medianY: likeArr.length ? Math.log10(med + 1) : NaN,
        topFormat: topFormat && topFormat[1] > 0 ? `${topFormat[0]} (${topFormat[1]})` : "—",
      });
    }

    const legend = series.map((s) => `<span class="fs-cmp-legend-item"><span class="fs-cmp-legend-dot" style="background:${s.color}"></span>@${escHTML(s.username)} (${s.count})</span>`).join("");
    const tableRows = series.map((s) => `<tr>
      <td><span class="fs-cmp-legend-dot" style="background:${s.color};margin-right:6px"></span>@${escHTML(s.username)}</td>
      <td class="num">${s.count}</td>
      <td class="num">${fmt(s.median)}</td>
      <td class="num">${fmt(s.p90)}</td>
      <td>${escHTML(s.topFormat)}</td>
    </tr>`).join("");

    if (!els.modal) return; // user closed while loading
    const body = els.modal.querySelector(".fs-modal-body");
    if (!body) return;
    body.innerHTML = `
      <div class="fs-cmp-chart-wrap">
        ${buildCompareChart(series)}
        <div class="fs-cmp-legend">${legend}</div>
      </div>
      <table class="fs-cmp-table">
        <thead><tr><th>Creator</th><th class="num">Posts</th><th class="num">Median likes</th><th class="num">P90 likes</th><th>Top format</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
      <div style="color:#a8a9b3;font-size:10.5px;margin-top:8px">x: post date · y: log scale (likes + 1) · dashed line: per-creator median</div>`;
  };

  const filtered = () => {
    let list = [...posts.values()];
    if (state.scope === "session") {
      list = list.filter((p) => sessionIds.has(p.id));
    }
    if (state.surface !== "all") {
      list = list.filter((p) => matchesSurface(p, state.surface));
    }
    if (state.audioId) {
      list = list.filter((p) => p.audio && p.audio.id === state.audioId);
    }
    list = applyRangeFilter(list);
    const q = (state.q || "").trim().toLowerCase();
    if (q) {
      list = list.filter((p) => {
        const m = getMetaSync(p.id);
        const tagHay = m && m.tags ? " " + m.tags.join(" ") : "";
        const noteHay = m && m.note ? " " + m.note : "";
        const txHay = p.transcript ? " " + p.transcript : "";
        const hay = ((p.desc || "") + " @" + (p.author || "") + tagHay + noteHay + txHay).toLowerCase();
        return hay.includes(q);
      });
    }
    if (state.pinnedOnly) {
      list = list.filter((p) => isPinned(p.id));
    }
    if (state.statusFilter) {
      list = list.filter((p) => statusOf(p.id) === state.statusFilter);
    }
    if (state.hasNote) {
      list = list.filter((p) => hasNote(p.id));
    }
    if (state.hasTranscript) {
      list = list.filter((p) => !!(p.transcript && p.transcript.trim()));
    }
    if (state.hashtagFilter) {
      const re = new RegExp("#" + state.hashtagFilter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w_])", "i");
      list = list.filter((p) => re.test(p.desc || ""));
    }
    if (state.keywordFilter) {
      // Whole-word, case-insensitive caption match. Used by the Stats
      // keyword chips as a lightweight "filter by niche term".
      const esc = state.keywordFilter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp("(?:^|[^\\w])" + esc + "(?![\\w])", "i");
      list = list.filter((p) => re.test(p.desc || ""));
    }
    if (state.nicheFilter) {
      list = list.filter((p) => p && p.niche === state.nicheFilter);
    }
    if (state.formatFilter) {
      list = list.filter((p) => p && p.format === state.formatFilter);
    }
    if (state.hasAi) list = list.filter((p) => !!(p.ai && p.ai.hook));
    if (state.hookTypeFilter) list = list.filter((p) => p.ai && p.ai.hookType === state.hookTypeFilter);
    if (state.topicFilter) list = list.filter((p) => p.ai && p.ai.topic === state.topicFilter);
    if (state.angleFilter) list = list.filter((p) => p.ai && p.ai.angle === state.angleFilter);
    // Enrich with derived fields so velocity/accelerating are available
    // to the sort, the outlier metric, the row line, and the CSV.
    const nowMs = Date.now();
    list = list.map((p) => {
      const d = computeDerived(p, nowMs);
      // Expose `velocity` as an alias so computeOutliers(list, "velocity")
      // reads it directly without special-casing the metric key.
      const cpr = (p.comments || 0) / Math.max(p.likes || 0, 1) * 1000;
      const vph = vphSincePosted(p, nowMs);
      return { ...p, ...d, velocity: d.velocityViewsPerHr, cpr, vph };
    });
    // On Explore the outlier score is not meaningful (no per-author
    // baseline available). Stamp _score=0 / _scoreBasis="none" instead
    // of mixing every creator's metric into one global median.
    if (pageScope.kind === "explore") {
      list = list.map((p) => ({ ...p, _score: 0, _scoreBasis: "none" }));
    } else {
      list = computeOutliers(list, state.metric);
    }
    const key = state.sort;
    // ---- Relevance sort helpers ----
    // Built-in sort key "relevance" combines formatScores (computed lazily
    // via __fsRelevance.scoreRelevanceFromPost), outlier (_score), velocity,
    // and optional niche match. Learning mode + format weights are kept in
    // state.relevancePrefs (settable from settings UI / onboarding later);
    // fall back to LEARNING_MODES.hybrid() when nothing is configured.
    const _getRelevancePrefs = () => {
      const lib = (typeof globalThis !== "undefined" && globalThis.__fsRelevance) || null;
      if (!lib) return {};
      if (state.relevancePrefs && typeof state.relevancePrefs === "object") {
        return state.relevancePrefs;
      }
      return lib.LEARNING_MODES.hybrid();
    };
    const _relevanceScoreOf = (p, prefs) => {
      const lib = (typeof globalThis !== "undefined" && globalThis.__fsRelevance) || null;
      if (!lib) return 0;
      // Memo on the post object so a single sort doesn't re-derive scores.
      if (p.__fsRelevance != null) return p.__fsRelevance;
      const r = lib.scoreRelevanceFromPost(p, prefs);
      p.__fsRelevance = r.score;
      p.__fsRelevanceReason = r.reason;
      return r.score;
    };
    const gKey = state.groupBy && state.groupBy !== "none" ? state.groupBy : null;
    const groupVal = (p) => {
      if (!gKey) return "";
      if (gKey === "status") return statusOf(p.id) || "\uffff";
      if (gKey === "hookType" || gKey === "topic" || gKey === "angle") {
        return (p.ai && p.ai[gKey]) || "\uffff";
      }
      if (gKey === "coverWinRate") {
        const s = p._score || 0;
        if (s >= 3) return "0";
        if (s >= 2) return "1";
        if (s >= 1) return "2";
        return "3";
      }
      return "";
    };
    list.sort((a, b) => {
      if (gKey) {
        const ga = groupVal(a), gb = groupVal(b);
        if (ga !== gb) return ga < gb ? -1 : 1;
      }
      if (key === "relevance") {
        // Pull learning-mode prefs from chrome.storage (set in settings, default
        // hybrid). Computed once per sort via the lazy getter below.
        const prefs = _getRelevancePrefs();
        const ar = _relevanceScoreOf(a, prefs);
        const br = _relevanceScoreOf(b, prefs);
        return br - ar;
      }
      if (key === "outlier") return (Number(b._score) || 0) - (Number(a._score) || 0);
      if (key === "recent") return (Number(b.createTime) || 0) - (Number(a.createTime) || 0);
      if (key === "velocity") return (Number(b.velocityViewsPerHr) || 0) - (Number(a.velocityViewsPerHr) || 0);
      if (key === "vph") return (Number(b.vph) || 0) - (Number(a.vph) || 0);
      if (key === "cpr") return (Number(b.cpr) || 0) - (Number(a.cpr) || 0);
      if (key === "status") {
        const sa = STATUS_RANK[statusOf(a.id)] || 99;
        const sb = STATUS_RANK[statusOf(b.id)] || 99;
        if (sa !== sb) return sa - sb;
        return (Number(b._score) || 0) - (Number(a._score) || 0);
      }
      if (key === "hookType" || key === "topic" || key === "angle") {
        const va = (a.ai && a.ai[key]) || "\uffff";
        const vb = (b.ai && b.ai[key]) || "\uffff";
        if (va !== vb) return va < vb ? -1 : 1;
        return (Number(b._score) || 0) - (Number(a._score) || 0);
      }
      return (Number(b[key]) || 0) - (Number(a[key]) || 0);
    });
    if (state.limit > 0) list = list.slice(0, state.limit);
    // Surface a deduped debug log proving the sort actually ran. The
    // dropdown change emits filter.change; this confirms the order.
    // Signature includes key+metric+count+top-3 ids so a re-render with
    // identical output stays silent.
    const sig = `${key}|${state.metric}|${list.length}|${(list[0]||{}).id||""}|${(list[1]||{}).id||""}|${(list[2]||{}).id||""}`;
    if (sig !== filtered._lastSig) {
      filtered._lastSig = sig;
      const top = list.slice(0, 3).map((p) => ({
        id: p.id,
        likes: p.likes || 0,
        views: p.views || 0,
        comments: p.comments || 0,
        velocity: Math.round(p.velocityViewsPerHr || 0),
        cpr: Number((p.cpr || 0).toFixed(2)),
        outlier: Number((p._score || 0).toFixed(2)),
        recent: p.createTime || 0,
      }));
      logDebug("sort.applied", { key, metric: state.metric, count: list.length, top });
    }
    return list;
  };

  const escHTML = (s) =>
    String(s || "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

  const setStatus = (s) => {
    if (els.status) els.status.textContent = s;
  };

  // Transient toast pinned to the overlay root. Auto-dismisses after `ms`.
  let _toastTimer = null;
  const showToast = (msg, ms = 1000) => {
    if (!els.root) return;
    let el = els.root.querySelector("[data-toast]");
    if (!el) {
      el = document.createElement("div");
      el.className = "fs-toast";
      el.dataset.toast = "";
      els.root.appendChild(el);
    }
    el.textContent = String(msg);
    el.classList.add("fs-toast-on");
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { el.classList.remove("fs-toast-on"); }, ms);
  };

  // Update the header pin-creator button: visible only on profile pages
  // (and not the Niche tab), with icon + title reflecting tracked state.
  const updatePinBtn = () => {
    if (!els.pinBtn) return;
    const profile = pageScope.kind === "profile" && !!pageScope.username;
    const onNiche = state.view === "niche";
    const show = profile && !onNiche;
    els.pinBtn.hidden = !show;
    if (!show) return;
    const pinned = !!creators.find((c) => c.username === pageScope.username);
    els.pinBtn.textContent = pinned ? "\uD83D\uDCCD" : "\uD83D\uDCCC";
    els.pinBtn.title = pinned
      ? "Already in watchlist \u2014 click to unpin"
      : "Pin creator to watchlist";
    els.pinBtn.classList.toggle("fs-pin-on", pinned);
    els.pinBtn.dataset.username = pageScope.username;
  };

  const togglePinCurrentCreator = async () => {
    if (pageScope.kind !== "profile" || !pageScope.username) return;
    const username = pageScope.username;
    const pinned = !!creators.find((c) => c.username === username);
    if (pinned) {
      await removeCreator(username);
      logInfo("watchlist.toggle", { username, pinned: false, platform: PLATFORM.platform });
      showToast(`Removed @${username} from watchlist`);
    } else {
      await upsertCreator(username);
      logInfo("watchlist.toggle", { username, pinned: true, platform: PLATFORM.platform });
      showToast(`Pinned @${username} to watchlist`);
    }
  };

  const renderLog = () => {
    if (!els.logPanel) return;
    const threshold = LOG_LEVELS[state.logLevel] || LOG_LEVELS.info;
    // Filter by level (still buffered + persisted; just hidden in panel).
    const visible = [];
    for (let i = LOG_BUF.length - 1; i >= 0 && visible.length < 60; i--) {
      const e = LOG_BUF[i];
      const lv = LOG_LEVELS[e.level] || LOG_LEVELS.info;
      if (lv >= threshold) visible.push(e);
    }
    els.logPanel.innerHTML = visible
      .map((e) => {
        const ts = new Date(e.t).toLocaleTimeString();
        const lvl = e.level || "info";
        const tag = LOG_LEVEL_TAG[lvl] || "I";
        const { t, event, level, ...rest } = e;
        return `<div class="fs-log-line fs-log-${lvl}"><span class="fs-log-ts">${ts}</span> <span class="fs-log-lvl">[${tag}]</span> <b>${escHTML(event)}</b> ${escHTML(JSON.stringify(rest))}</div>`;
      })
      .join("");
  };

  // -------- log export --------
  const exportLogs = async () => {
    // Drain pending writes so the IDB read is up-to-date.
    try { await flushPersist(); } catch {}
    const persisted = await readAllPersistedLogs();
    // Dedupe by (t + event + level). IDB rows are authoritative; only fall
    // back to in-memory entries that aren't represented in IDB yet.
    const seen = new Set();
    const out = [];
    const push = (e) => {
      if (!e || typeof e !== "object") return;
      const key = `${e.t}|${e.event}|${e.level || ""}`;
      if (seen.has(key)) return;
      seen.add(key);
      // Strip internal autoincrement key.
      const { _k, ...rest } = e;
      out.push(rest);
    };
    for (const e of (persisted || [])) push(e);
    for (const e of LOG_BUF) push(e);
    out.sort((a, b) => (a.t || 0) - (b.t || 0));
    const lines = out.map((e) => JSON.stringify(e)).join("\n");
    const blob = new Blob([lines + "\n"], { type: "application/x-ndjson" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    a.download = `fs-logs-${stamp}.jsonl`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    logInfo("export.logs", { entries: out.length, persisted: persisted?.length || 0, buffered: LOG_BUF.length });
  };
  window.__feedSorter.exportLogs = exportLogs;

  // Dump the entire library (posts + meta) as a single JSON file. Feeds
  // scripts/classify-test.mjs and any offline analysis. Transcripts and AI
  // fields live on the post row itself (see src/store.js:setPostTranscript /
  // setPostAi), so a flat getAll() already includes them — we only need to
  // merge in the separate `meta` store.
  const exportLibrary = async () => {
    const store = window.__fsStore;
    if (!store || typeof store.getAll !== "function") {
      setStatus("library export: store not ready");
      logWarn("export.library.skip", { reason: "no-store" });
      return;
    }
    const posts = await store.getAll();
    let metaRows = [];
    try { metaRows = (typeof store.getAllMeta === "function") ? (await store.getAllMeta()) || [] : []; } catch (e) { logWarn("export.library.meta.fail", e); }
    const metaById = new Map();
    for (const m of metaRows) {
      if (m && m.id) metaById.set(String(m.id), m);
    }
    const merged = posts.map((p) => {
      const m = metaById.get(String(p && p.id));
      return m ? { ...p, meta: m } : p;
    });
    const payload = {
      exportedAt: new Date().toISOString(),
      version: 1,
      platform: PLATFORM && PLATFORM.id || null,
      count: merged.length,
      posts: merged,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    a.download = `feed-sorter-library-${stamp}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1500);
    logInfo("library.export", { posts: merged.length, meta: metaRows.length });
    setStatus(`library exported (${merged.length} posts)`);
  };
  window.__feedSorter.exportLibrary = exportLibrary;

  // Refresh the Export-library button label with the live post count whenever
  // the settings panel is opened. Cheap — just a count(getAll()).
  const refreshLibraryExportCount = async () => {
    try {
      const btn = root && root.querySelector('[data-export-library]');
      if (!btn || !window.__fsStore || typeof window.__fsStore.getAll !== "function") return;
      const rows = await window.__fsStore.getAll();
      btn.textContent = `Export library (${rows.length})`;
    } catch (_) { /* non-fatal */ }
  };
  window.__feedSorter.refreshLibraryExportCount = refreshLibraryExportCount;
  // Best-effort initial paint shortly after mount.
  setTimeout(() => { refreshLibraryExportCount().catch(() => {}); }, 750);

  // -------- batch ops --------
  const renderBatchBar = () => {
    if (!els.batch) return;
    const n = state.selected.size;
    els.batch.hidden = n === 0;
    if (els.batchCount) els.batchCount.textContent = `${n} selected`;
    const cmpBtn = els.batch.querySelector('[data-act="batch-compare"]');
    if (cmpBtn) cmpBtn.disabled = !(n >= 2 && n <= 3);
  };

  const selectAllVisible = () => {
    const list = filtered();
    for (const p of list) state.selected.add(p.id);
    logInfo("select.all", { added: list.length, n: state.selected.size });
    render();
  };

  const selectedPosts = () => {
    const out = [];
    for (const id of state.selected) {
      const p = posts.get(id);
      if (p) out.push(p);
    }
    return out;
  };

  const batchDownload = async () => {
    const sel = selectedPosts();
    const targets = sel.filter((p) => p.videoUrl);
    const skipped = sel.length - targets.length;
    logInfo("batch.download.start", { total: sel.length, downloadable: targets.length, skipped });
    if (!targets.length) {
      setStatus("no videos in selection");
      return;
    }
    let ok = 0, fail = 0;
    for (let i = 0; i < targets.length; i++) {
      const p = targets[i];
      setStatus(`downloading ${i + 1}/${targets.length}…`);
      try {
        await downloadVideo(p);
        ok++;
      } catch (e) {
        fail++;
        logWarn("batch.download.item.fail", e, { id: p.id });
      }
      if (i < targets.length - 1) await sleep(800);
    }
    setStatus(`downloaded ${ok}/${targets.length}${skipped ? ` (${skipped} skipped)` : ""}${fail ? ` • ${fail} failed` : ""}`);
    logInfo("batch.download.end", { ok, fail, skipped });
  };

  const batchCopyUrls = async () => {
    const sel = selectedPosts();
    const urls = sel.map((p) => p.url).filter(Boolean);
    const text = urls.join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setStatus(`copied ${urls.length} URL${urls.length === 1 ? "" : "s"}`);
      logInfo("batch.copy.ok", { n: urls.length });
    } catch (e) {
      logWarn("batch.copy.fail", e, { n: urls.length });
      setStatus("copy failed — see console");
      console.warn(text);
    }
  };

  // -------- bulk outlier download --------
  // Sanitize a path segment so chrome.downloads accepts it. Disallows path
  // traversal and characters Chrome rejects (<>:"|?*\), strips leading dots.
  const sanitizeSeg = (s) => String(s || "")
    .replace(/[<>:"|?*\\\/]+/g, "_")
    .replace(/\.+$/g, "")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 80) || "untitled";
  const ymd = (ts) => {
    const d = ts ? new Date(ts * 1000) : new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const guessExt = (url) => {
    try {
      const u = new URL(url);
      const m = u.pathname.match(/\.(mp4|mov|m4v|webm)(?:$|[?#])/i);
      return m ? m[1].toLowerCase() : "mp4";
    } catch { return "mp4"; }
  };
  const setBulkStatus = (text, showCancel) => {
    const el = els.root && els.root.querySelector("[data-bulk-status]");
    const cancel = els.root && els.root.querySelector(".fs-bulk-cancel");
    if (el) { el.textContent = text || ""; el.hidden = !text; }
    if (cancel) cancel.hidden = !showCancel;
  };
  const bgDownload = (url, filename) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "fs-bg", cmd: "download", url, filename }, (resp) => {
        if (chrome.runtime.lastError) resolve({ ok: false, err: String(chrome.runtime.lastError.message) });
        else resolve(resp || { ok: false, err: "no-response" });
      });
    } catch (e) { resolve({ ok: false, err: String(e) }); }
  });

  const buildBatchMetaCSV = (rows) => {
    const header = [
      "author", "shortcode", "surface", "createDate", "score",
      "likes", "views", "comments", "velocityPerHr",
      "caption", "hashtags", "transcript", "accessibilityCaption",
      "audioId", "audioTitle", "audioArtist",
      "url", "videoUrl", "filename",
    ];
    const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const out = [header.join(",")];
    for (const r of rows) {
      const p = r.post;
      const tags = (p.desc || "").match(/#[\w\u00C0-\u024F\u1E00-\u1EFF]+/g) || [];
      const tx = p.transcript || p.captions || (p.audio && p.audio.transcript) || "";
      const au = p.audio || {};
      out.push([
        esc(p.author), esc(p.shortcode), esc(p.surface), ymd(p.createTime),
        (p._score || 0).toFixed(3),
        p.likes || 0, p.views || 0, p.comments || 0,
        (p.velocityViewsPerHr || 0).toFixed(2),
        esc(p.desc), esc(tags.join(" ")), esc(tx), esc(p.accessibilityCaption || ""),
        au.id || "", esc(au.title || ""), esc(au.artist || ""),
        esc(p.url), esc(p.videoUrl), esc(r.filename),
      ].join(","));
    }
    return out.join("\n");
  };

  const bulkDownloadOutliers = async () => {
    if (state.bulk.running) { setStatus("bulk download already running"); return; }
    const N = Number(state.outlierThresh) || 3;
    const list = filtered();
    const eligible = list.filter((p) => (p._score || 0) >= N && p.videoUrl);
    const skipped = list.length - eligible.length;
    logInfo("bulk.outliers.start", { thresh: N, eligible: eligible.length, totalView: list.length, skipped, scope: pageScope.kind });
    if (!eligible.length) { setStatus(`no videos in view with score ≥ ${N}×`); return; }

    // Folder layout per scope.
    const today = ymd();
    const explore = pageScope.kind !== "profile" || !pageScope.username;
    const baseFolder = explore
      ? `${PLATFORM_DOWNLOAD_FOLDER}/explore-${today}`
      : `${PLATFORM_DOWNLOAD_FOLDER}/${sanitizeSeg(pageScope.username)}`;

    // Pre-compute filenames so the meta CSV references the actual paths.
    const items = eligible.map((p) => {
      const ext = guessExt(p.videoUrl);
      const author = sanitizeSeg(p.author || "unknown");
      const sc = sanitizeSeg(p.shortcode || p.id);
      const date = ymd(p.createTime);
      const fname = explore
        ? `${baseFolder}/${author}-${sc}.${ext}`
        : `${baseFolder}/${date}_${sc}.${ext}`;
      return { post: p, filename: fname };
    });

    state.bulk = { running: true, cancel: false, done: 0, total: items.length, fail: 0 };
    setBulkStatus(`downloading 0/${items.length}…`, true);

    // Sidecar _meta.csv first, so it lands even if user cancels mid-run.
    try {
      const csvText = buildBatchMetaCSV(items);
      const dataUrl = "data:text/csv;charset=utf-8;base64," + btoa(unescape(encodeURIComponent(csvText)));
      const metaName = `${baseFolder}/_meta.csv`;
      const r = await bgDownload(dataUrl, metaName);
      if (!r.ok) logWarn("bulk.meta.fail", { err: r.err, filename: metaName });
      else logInfo("bulk.meta.ok", { filename: metaName, rows: items.length });
    } catch (e) { logWarn("bulk.meta.fail", e); }

    if (state.bulkZip && typeof window.JSZip !== "function") {
      logWarn("bulk.zip.unavailable", { hint: "Bundle JSZip as window.JSZip to enable zipped bulk downloads." });
    }
    const useZip = !!state.bulkZip && typeof window.JSZip === "function";
    let zip = null;
    if (useZip) zip = new window.JSZip();

    for (let i = 0; i < items.length; i++) {
      if (state.bulk.cancel) { logInfo("bulk.cancelled", { at: i, total: items.length }); break; }
      const { post: p, filename } = items[i];
      state.bulk.done = i;
      setBulkStatus(`downloading ${i + 1}/${items.length}…`, true);
      setStatus(`bulk: ${i + 1}/${items.length}`);
      try {
        if (useZip) {
          const resp = await fetch(p.videoUrl, { credentials: "omit" });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const blob = await resp.blob();
          zip.file(filename.replace(/^[^/]*\//, ""), blob);
          logInfo("bulk.item.zipped", { i: i + 1, n: items.length, bytes: blob.size, shortcode: p.shortcode });
        } else {
          const r = await bgDownload(p.videoUrl, filename);
          if (!r.ok) throw new Error(r.err || "download-failed");
          logInfo("bulk.item.ok", { i: i + 1, n: items.length, filename, shortcode: p.shortcode });
        }
      } catch (e) {
        state.bulk.fail++;
        logWarn("bulk.item.fail", e, { i: i + 1, n: items.length, shortcode: p.shortcode, url: p.videoUrl });
      }
      if (i < items.length - 1) await sleep(1000);
    }

    // Finalise ZIP (if enabled) as a single download.
    if (useZip && !state.bulk.cancel) {
      try {
        setBulkStatus("zipping…", false);
        const zipBlob = await zip.generateAsync({ type: "blob" });
        const zipName = `${baseFolder}.zip`;
        // Blob URLs from the page aren't reachable by the SW; use object URL
        // and trigger a same-context anchor download as a fallback path.
        const a = document.createElement("a");
        a.href = URL.createObjectURL(zipBlob);
        a.download = zipName.split("/").pop();
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1500);
        logInfo("bulk.zip.ok", { filename: zipName, bytes: zipBlob.size });
      } catch (e) {
        logWarn("bulk.zip.fail", e);
      }
    }

    const okCount = items.length - state.bulk.fail - (state.bulk.cancel ? items.length - state.bulk.done : 0);
    state.bulk.running = false;
    setBulkStatus("", false);
    const tag = state.bulk.cancel ? "cancelled" : "done";
    setStatus(`bulk ${tag}: ${okCount}/${items.length}${state.bulk.fail ? ` • ${state.bulk.fail} failed` : ""}${skipped ? ` (${skipped} below threshold or no video)` : ""}`);
    logInfo("bulk.outliers.end", { ok: okCount, fail: state.bulk.fail, cancelled: state.bulk.cancel, total: items.length, folder: baseFolder, useZip });
  };

  // Mirror of bulkDownloadOutliers but for audio.downloadUrl. Skips rows
  // with no audio URL (licensed IG music etc.). Reuses state.bulk so the
  // shared Cancel button works.
  const bulkDownloadAudio = async () => {
    if (state.bulk.running) { setStatus("bulk download already running"); return; }
    const N = Number(state.outlierThresh) || 3;
    const list = filtered();
    const eligible = list.filter((p) => (p._score || 0) >= N && p.audio && p.audio.downloadUrl);
    const skipped = list.length - eligible.length;
    logInfo("bulk.audio.start", { thresh: N, eligible: eligible.length, totalView: list.length, skipped });
    if (!eligible.length) { setStatus(`no rows in view with score ≥ ${N}× and downloadable audio`); return; }

    const today = ymd();
    const explore = pageScope.kind !== "profile" || !pageScope.username;
    const baseFolder = explore
      ? `${PLATFORM_DOWNLOAD_FOLDER}/explore-${today}/audio`
      : `${PLATFORM_DOWNLOAD_FOLDER}/${sanitizeSeg(pageScope.username)}/audio`;

    const items = eligible.map((p) => {
      const url = p.audio.downloadUrl;
      const ext = /\.mp3(\?|$)/i.test(url) ? "mp3" : (/\.m4a(\?|$)/i.test(url) ? "m4a" : "mp4");
      const author = sanitizeSeg(p.author || "unknown");
      const sc = sanitizeSeg(p.shortcode || p.id);
      return { post: p, filename: `${baseFolder}/${author}-${sc}-audio.${ext}`, url };
    });

    state.bulk = { running: true, cancel: false, done: 0, total: items.length, fail: 0 };
    setBulkStatus(`downloading audio 0/${items.length}…`, true);

    for (let i = 0; i < items.length; i++) {
      if (state.bulk.cancel) { logInfo("bulk.audio.cancelled", { at: i, total: items.length }); break; }
      const { post: p, filename, url } = items[i];
      state.bulk.done = i;
      setBulkStatus(`downloading audio ${i + 1}/${items.length}…`, true);
      setStatus(`bulk audio: ${i + 1}/${items.length}`);
      try {
        const r = await bgDownload(url, filename);
        if (!r.ok) throw new Error(r.err || "download-failed");
        logInfo("bulk.audio.ok", { i: i + 1, n: items.length, filename, shortcode: p.shortcode });
      } catch (e) {
        state.bulk.fail++;
        logWarn("bulk.audio.fail", e, { i: i + 1, n: items.length, shortcode: p.shortcode, url });
      }
      if (i < items.length - 1) await sleep(800);
    }

    const okCount = items.length - state.bulk.fail - (state.bulk.cancel ? items.length - state.bulk.done : 0);
    state.bulk.running = false;
    setBulkStatus("", false);
    const tag = state.bulk.cancel ? "cancelled" : "done";
    setStatus(`bulk audio ${tag}: ${okCount}/${items.length}${state.bulk.fail ? ` • ${state.bulk.fail} failed` : ""}${skipped ? ` (${skipped} skipped — below threshold or no audio URL)` : ""}`);
    logInfo("bulk.audio.end", { ok: okCount, fail: state.bulk.fail, cancelled: state.bulk.cancel, total: items.length });
  };

  // -------- transcription (faster-whisper sidecar) --------
  const fmtTs = (t) => {
    const s = Math.max(0, Math.floor(Number(t) || 0));
    const m = Math.floor(s / 60);
    const r = String(s % 60).padStart(2, "0");
    return `${m}:${r}`;
  };

  const TRANSCRIPT_SOURCE_LABELS = {
    "tiktok-vtt":   "TikTok auto-captions (ASR)",
    "ig-alt":       "Instagram alt text — describes cover, not audio",
    "groq-whisper": "Groq Whisper-Large-v3-Turbo (cloud, your key)",
    "hf-whisper":   "HuggingFace Whisper-Large-v3 (cloud, your key)",
    "whisper":      "Local Whisper",
  };
  const transcriptSourceClass = (src) => {
    if (src === "tiktok-vtt") return "fs-tx-source-vtt";
    if (src === "ig-alt") return "fs-tx-source-alt";
    if (src === "groq-whisper") return "fs-tx-source-groq";
    if (src === "hf-whisper") return "fs-tx-source-hf";
    return "fs-tx-source-whisper";
  };

  const renderTranscriptBlock = (p) => {
    const inflight = state.transcribeInflight.has(p.id);
    if (!p.transcript && !inflight) return "";
    if (inflight && !p.transcript) {
      return `<div class="fs-transcript fs-transcript-busy">
        <div class="fs-transcript-head">🎙️ Transcribing…</div>
      </div>`;
    }
    const segs = Array.isArray(p.transcriptSegments) ? p.transcriptSegments : [];
    const src = p.transcriptSource || "whisper";
    const srcLabel = TRANSCRIPT_SOURCE_LABELS[src] || src;
    const srcCls = transcriptSourceClass(src);
    const head = `<div class="fs-transcript-head">
        <span>🎙️ Transcript</span>
        ${p.transcriptLang ? `<span class="fs-transcript-lang">${escHTML(p.transcriptLang)}</span>` : ""}
        <span class="fs-transcript-meta">${(p.transcript || "").length} chars · ${segs.length} segs</span>
        <button class="fs-icon-btn fs-transcript-copy" data-act="transcript-copy" data-id="${escHTML(p.id)}" title="Copy transcript text">Copy</button>
      </div>
      <div class="fs-transcript-source ${srcCls}">Source: ${escHTML(srcLabel)}</div>`;
    if (segs.length) {
      const rows = segs.map((s) => `<div class="fs-transcript-row"><span class="fs-transcript-ts">[${fmtTs(s.start)} → ${fmtTs(s.end)}]</span> <span class="fs-transcript-tx">${escHTML(s.text || "")}</span></div>`).join("");
      return `<div class="fs-transcript">${head}<div class="fs-transcript-body">${rows}</div></div>`;
    }
    return `<div class="fs-transcript">${head}<div class="fs-transcript-body"><div class="fs-transcript-row">${escHTML(p.transcript)}</div></div></div>`;
  };

  const sidecarBase = () => String(state.transcribeUrl || "").trim().replace(/\/+$/, "");

  const sendBg = (cmd, extra) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: "fs-bg", cmd, ...extra }, (resp) => {
        const lerr = chrome.runtime.lastError;
        if (lerr || !resp) resolve({ ok: false, err: String(lerr?.message || "no-response") });
        else resolve(resp);
      });
    } catch (e) { resolve({ ok: false, err: String(e) }); }
  });

  const setTranscribeHealth = (ok, msg, body) => {
    state.transcribeStatus = {
      ok,
      msg: msg || "",
      model: (body && body.model) || "",
      checkedAt: Date.now(),
    };
    if (els.txHealth) {
      els.txHealth.textContent = msg || (ok ? "ok" : "unreachable");
      els.txHealth.dataset.level = ok ? "ok" : (ok === false ? "err" : "unknown");
    }
  };

  const checkSidecarHealth = async ({ silent = false } = {}) => {
    const base = sidecarBase();
    if (!base) { setTranscribeHealth(false, "no sidecar URL set"); return { ok: false }; }
    if (!silent) setTranscribeHealth(null, "checking…");
    const r = await sendBg("transcribe-health", { sidecarUrl: base });
    if (r.ok && r.body && r.body.ok) {
      const tag = r.body.loaded ? "ready" : "idle";
      setTranscribeHealth(true, `✔ ${tag} · ${r.body.model || "?"} · ${r.ms}ms`, r.body);
      logInfo("transcribe.health.ok", { model: r.body.model, loaded: r.body.loaded, ms: r.ms });
    } else {
      setTranscribeHealth(false, `✗ ${r.err || "unreachable"}`);
      logWarn("transcribe.health.fail", { err: r.err, status: r.status });
    }
    return r;
  };

  const persistTranscript = async (id, body) => {
    if (!window.__fsStore || !window.__fsStore.setPostTranscript) return null;
    try {
      const merged = await window.__fsStore.setPostTranscript(id, body);
      if (merged) {
        const prev = posts.get(id);
        if (prev) posts.set(id, { ...prev, ...merged });
      }
      return merged;
    } catch (e) {
      logWarn("transcribe.persist.fail", e, { id });
      return null;
    }
  };

  const transcribeOne = async (p, { quiet = false } = {}) => {
    if (!p || !p.id) return { ok: false, err: "no-post" };
    const hasFree = !!(p && (p.captionUrl || p.altText));
    if (!p.videoUrl && !hasFree) return { ok: false, err: "no-video-url" };
    const base = sidecarBase();
    const hasGroq = !!(state.transcriptCloud && state.transcriptCloud.groqApiKey);
    const hasHf = !!(state.transcriptCloud && state.transcriptCloud.hfApiKey);
    if (!base && !hasFree && !hasGroq && !hasHf) return { ok: false, err: "no-sidecar-url" };
    if (state.transcribeInflight.has(p.id)) return { ok: false, err: "already-running" };
    state.transcribeInflight.add(p.id);
    if (!quiet) setStatus(`transcribing ${p.shortcode || p.id}…`);
    logInfo("transcribe.start", { id: p.id, shortcode: p.shortcode, surface: p.surface });
    render();
    try {
      const r = await sendBg("transcribe", {
        sidecarUrl: base,
        videoUrl: p.videoUrl,
        groqApiKey: String((state.transcriptCloud && state.transcriptCloud.groqApiKey) || ""),
        hfApiKey: String((state.transcriptCloud && state.transcriptCloud.hfApiKey) || ""),
        hfFallbackOnRateLimit: !!(state.transcriptCloud && state.transcriptCloud.hfFallbackOnRateLimit),
        transcribeMode: String(state.transcribeMode || "auto"),
        id: p.id,
        shortcode: p.shortcode,
        post: {
          id: p.id,
          platform: p.platform,
          captionUrl: p.captionUrl || null,
          captionFormat: p.captionFormat || null,
          altText: p.altText || null,
          videoUrl: p.videoUrl || null,
        },
      });
      if (!r.ok || !r.body || !r.body.ok) {
        // Friendlier message for the BYOK rate-limit case — a retry usually works.
        const friendly = r.err === "groq-rate-limit"
          ? `Groq rate-limit hit— retry${r.retryAfter ? ` in ${r.retryAfter}s` : " in a moment"}`
          : r.err === "video too large"
            ? "video > 25 MB — Groq free tier limit; use the local sidecar"
            : `transcribe failed: ${r.err || "see log"}`;
        if (!quiet) setStatus(friendly);
        logWarn("transcribe.fail", { id: p.id, err: r.err, status: r.status, retryAfter: r.retryAfter });
        return { ok: false, err: r.err, retryAfter: r.retryAfter };
      }
      const merged = await persistTranscript(p.id, r.body);
      if (!quiet) setStatus(`transcribed: ${(r.body.text || "").length} chars in ${r.ms}ms`);
      logInfo("transcribe.ok", { id: p.id, chars: (r.body.text || "").length, segs: (r.body.segments || []).length, lang: r.body.language, ms: r.ms });
      return { ok: true, body: r.body, post: merged };
    } finally {
      state.transcribeInflight.delete(p.id);
      render();
    }
  };

  const setTxBulkStatus = (msg, busy) => {
    const el = els.root && els.root.querySelector("[data-tx-status]");
    const cancel = els.root && els.root.querySelector('[data-act="bulk-transcribe-cancel"]');
    if (el) { el.textContent = msg || ""; el.hidden = !msg; }
    if (cancel) cancel.hidden = !busy;
  };

  const transcribeBulkOutliers = async () => {
    if (state.transcribeBulk.running) { setStatus("transcribe batch already running"); return; }
    const N = Number(state.outlierThresh) || 3;
    const list = filtered();
    const eligible = list.filter((p) => (p._score || 0) >= N && p.videoUrl && !(p.transcript && p.transcript.trim()));
    const skipped = list.length - eligible.length;
    logInfo("transcribe.bulk.start", { thresh: N, eligible: eligible.length, totalView: list.length, skipped });
    if (!eligible.length) { setStatus(`no untranscribed videos in view with score ≥ ${N}×`); return; }
    // Health-check first so we fail fast.
    const h = await checkSidecarHealth({ silent: true });
    if (!h.ok || !h.body || !h.body.ok) {
      setStatus("sidecar unreachable — start transcribe-server.py first");
      return;
    }
    state.transcribeBulk = { running: true, cancel: false, done: 0, total: eligible.length, fail: 0 };
    setTxBulkStatus(`0/${eligible.length}…`, true);

    // Concurrency=2 worker pool. Sidecar is single-threaded inside whisper
    // but Flask handles two requests in parallel; this keeps the pipe full
    // without overwhelming the model.
    const CONCURRENCY = 2;
    let cursor = 0;
    const worker = async () => {
      while (!state.transcribeBulk.cancel) {
        const i = cursor++;
        if (i >= eligible.length) return;
        const p = eligible[i];
        try {
          const r = await transcribeOne(p, { quiet: true });
          if (!r.ok) state.transcribeBulk.fail++;
        } catch (e) {
          state.transcribeBulk.fail++;
          logWarn("transcribe.bulk.item.fail", e, { id: p.id });
        }
        state.transcribeBulk.done++;
        setTxBulkStatus(`${state.transcribeBulk.done}/${eligible.length}${state.transcribeBulk.fail ? ` · ${state.transcribeBulk.fail} failed` : ""}`, true);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    state.transcribeBulk.running = false;
    const tag = state.transcribeBulk.cancel ? "cancelled" : "done";
    const ok = state.transcribeBulk.done - state.transcribeBulk.fail;
    setTxBulkStatus("", false);
    setStatus(`transcribe ${tag}: ${ok}/${eligible.length}${state.transcribeBulk.fail ? ` · ${state.transcribeBulk.fail} failed` : ""}`);
    logInfo("transcribe.bulk.end", { ok, fail: state.transcribeBulk.fail, cancelled: state.transcribeBulk.cancel, total: eligible.length });
  };

  // ---- Visible-feed bulk transcribe (footer button) ----
  // Walks every row currently in `filtered()` view that has media but no
  // transcript, runs the full cascade per post (background.js handles tier
  // selection), and paces calls to <30 RPM via a token bucket so the Groq
  // free-tier rate limit can't be tripped.

  // True if a row has a non-empty transcript already.
  const _hasTx = (p) => !!(p && p.transcript && String(p.transcript).trim());
  // True if a row has any transcribable media.
  const _hasMedia = (p) => !!(p && (p.captionUrl || p.videoUrl));

  const visibleEligibleForBulkTx = () => {
    return filtered().filter((p) => !_hasTx(p) && _hasMedia(p));
  };

  const updateBulkTxButton = () => {
    const btn = els.root && els.root.querySelector("[data-bulk-tx-btn]");
    if (!btn) return;
    // Free tier: hot-swap the bulk-transcribe footer button for an upgrade
    // chip. The root click handler routes data-act="upgrade" to /billing.
    if (!proAccess()) {
      btn.textContent = "🔒 Pro — Bulk transcribe";
      btn.title = "Bulk transcription is a Pro feature — click to upgrade";
      btn.dataset.act = "upgrade";
      btn.dataset.src = "bulk-transcribe";
      btn.disabled = false;
      btn.classList.add("fs-upgrade-chip");
      return;
    }
    btn.classList.remove("fs-upgrade-chip");
    btn.dataset.act = "bulk-tx-visible";
    delete btn.dataset.src;
    btn.title = "Transcribe every visible post that doesn't already have a transcript";
    if (state.bulkTx.running) {
      btn.textContent = "📝 Transcribing…";
      btn.disabled = true;
      return;
    }
    const n = visibleEligibleForBulkTx().length;
    btn.textContent = `📝 Bulk transcribe (${n})`;
    btn.disabled = n === 0;
  };

  const renderBulkTxStatus = () => {
    const wrap = els.root && els.root.querySelector("[data-bulk-tx-status]");
    const counts = els.root && els.root.querySelector("[data-bulk-tx-counts]");
    const tier = els.root && els.root.querySelector("[data-bulk-tx-tier]");
    const cancel = els.root && els.root.querySelector("[data-bulk-tx-cancel]");
    if (!wrap) return;
    const s = state.bulkTx;
    if (!s.running && !s.last) { wrap.hidden = true; if (cancel) cancel.hidden = true; return; }
    wrap.hidden = false;
    if (counts) counts.textContent = `${s.done}/${s.total} done · ${s.skipped} skipped · ${s.failed} failed`;
    if (tier && s.last) {
      const last = s.last;
      if (last.ok) tier.textContent = `tier: ${last.source} · ${(last.ms / 1000).toFixed(1)}s · ✓`;
      else if (last.skipped) tier.textContent = `skipped (${last.reason || "—"})`;
      else tier.textContent = `failed: ${last.err || "—"}`;
    } else if (tier) {
      tier.textContent = "";
    }
    if (cancel) cancel.hidden = !s.running;
  };

  const runBulkTranscribeVisible = async () => {
    if (state.bulkTx.running) { setStatus("bulk transcribe already running"); return; }
    const lib = (typeof globalThis !== "undefined" && globalThis.__fsBulkTranscribe) || null;
    if (!lib || !lib.runBulkTranscribe) {
      setStatus("bulk transcribe module missing");
      logWarn("bulk.transcribe.missing");
      return;
    }
    const eligible = visibleEligibleForBulkTx();
    if (!eligible.length) { setStatus("no posts to transcribe"); return; }

    state.bulkTx = { running: true, cancel: false, done: 0, skipped: 0, failed: 0, total: eligible.length, last: null };
    updateBulkTxButton();
    renderBulkTxStatus();
    logInfo("bulk.transcribe.start", { total: eligible.length });

    // Bridge transcribeOne (whose error shape encodes 429 as `groq-rate-limit`)
    // to the canonical { ok, status, retryAfter, source } the bulk runner expects.
    const adapter = async (p) => {
      const r = await transcribeOne(p, { quiet: true });
      if (r && r.ok) {
        const src = (r.body && (r.body.source || r.body.engine)) || "unknown";
        return { ok: true, source: src, text: (r.body && r.body.text) || "" };
      }
      if (r && r.err === "groq-rate-limit") {
        return { ok: false, status: 429, retryAfter: Number(r.retryAfter) || 1 };
      }
      return { ok: false, err: (r && r.err) || "unknown" };
    };

    let summary;
    try {
      summary = await lib.runBulkTranscribe({
        posts: eligible,
        transcribe: adapter,
        concurrency: 2,
        log: (level, event, data) => {
          if (level === "warn") logWarn(event, data);
          else logInfo(event, data);
        },
        shouldCancel: () => state.bulkTx.cancel,
        onProgress: (snap) => {
          state.bulkTx.done = snap.done;
          state.bulkTx.skipped = snap.skipped;
          state.bulkTx.failed = snap.failed;
          state.bulkTx.last = snap.last;
          renderBulkTxStatus();
        },
        // Slight jitter (±250ms around 500) to avoid thundering-herd on retry.
        jitter: () => 500 + Math.floor(Math.random() * 250),
      });
    } catch (e) {
      logError("bulk.transcribe.fail", e);
      summary = { done: state.bulkTx.done, skipped: state.bulkTx.skipped, failed: state.bulkTx.failed, durationMs: 0, tierBreakdown: {} };
    }

    state.bulkTx.running = false;
    updateBulkTxButton();
    renderBulkTxStatus();
    // Re-render so new transcripts feed Stats keyword extraction.
    render();

    const tb = summary.tierBreakdown || {};
    const free = (tb["tiktok-vtt"] || 0) + (tb["ig-alt"] || 0);
    const groq = tb["groq-whisper"] || 0;
    const hf = tb["hf-whisper"] || 0;
    const sidecar = tb["whisper"] || 0;
    const parts = [];
    if (free) parts.push(`${free} free`);
    if (groq) parts.push(`${groq} Groq`);
    if (hf) parts.push(`${hf} HF`);
    if (sidecar) parts.push(`${sidecar} sidecar`);
    const tail = parts.length ? ` (${parts.join(", ")})` : "";
    const skipTail = summary.skipped ? ` · ${summary.skipped} skipped` : "";
    showToast(`Transcribed ${summary.done} posts${tail}${skipTail}`, 4000);
  };

  const TRANSCRIBE_KEY = "fs.transcribe";
  const VALID_TRANSCRIBE_MODES = new Set(["auto", "free-only", "cloud-only", "sidecar-only"]);
  const loadTranscribeConfig = async () => {
    try {
      const r = await chrome.storage.local.get(TRANSCRIBE_KEY);
      const cfg = r && r[TRANSCRIBE_KEY];
      if (cfg && typeof cfg === "object") {
        if (cfg.url) state.transcribeUrl = String(cfg.url);
        if (typeof cfg.mode === "string" && VALID_TRANSCRIBE_MODES.has(cfg.mode)) {
          state.transcribeMode = cfg.mode;
        }
      }
    } catch (e) { logWarn("transcribe.load.fail", e); }
  };
  const saveTranscribeConfig = async () => {
    try {
      await chrome.storage.local.set({ [TRANSCRIBE_KEY]: { url: state.transcribeUrl, mode: state.transcribeMode } });
      logInfo("transcribe.config.save", { url: state.transcribeUrl, mode: state.transcribeMode });
    } catch (e) { logWarn("transcribe.save.fail", e); }
  };

  // -------- Cloud BYOK transcription (Groq) settings + health --------
  const TRANSCRIBE_CLOUD_KEY = "fs:transcribeCloud";
  const loadTranscriptCloudConfig = async () => {
    try {
      const r = await chrome.storage.local.get(TRANSCRIBE_CLOUD_KEY);
      const cfg = r && r[TRANSCRIBE_CLOUD_KEY];
      if (cfg && typeof cfg === "object") {
        state.transcriptCloud = {
          groqApiKey: typeof cfg.groqApiKey === "string" ? cfg.groqApiKey : "",
          hfApiKey: typeof cfg.hfApiKey === "string" ? cfg.hfApiKey : "",
          hfFallbackOnRateLimit: !!cfg.hfFallbackOnRateLimit,
        };
      }
    } catch (e) { logWarn("transcribe.cloud.load.fail", e); }
  };
  const saveTranscriptCloudConfig = async () => {
    try {
      await chrome.storage.local.set({ [TRANSCRIBE_CLOUD_KEY]: { ...state.transcriptCloud } });
      // Don't log the key itself — just whether one is set.
      logInfo("transcribe.cloud.config.save", {
        groqKeySet: !!state.transcriptCloud.groqApiKey,
        hfKeySet: !!state.transcriptCloud.hfApiKey,
        hfFallback: !!state.transcriptCloud.hfFallbackOnRateLimit,
      });
    } catch (e) { logWarn("transcribe.cloud.save.fail", e); }
  };
  const setGroqHealth = (ok, msg) => {
    state.groqHealth = { ok, msg: msg || "", checkedAt: Date.now() };
    if (els.groqHealth) {
      els.groqHealth.textContent = msg || (ok ? "ok" : "unreachable");
      els.groqHealth.dataset.level = ok ? "ok" : (ok === false ? "err" : "unknown");
    }
  };
  const setHfHealth = (ok, msg) => {
    state.hfHealth = { ok, msg: msg || "", checkedAt: Date.now() };
    if (els.hfHealth) {
      els.hfHealth.textContent = msg || (ok ? "ok" : "unreachable");
      els.hfHealth.dataset.level = ok ? "ok" : (ok === false ? "err" : "unknown");
    }
  };
  const checkHfHealth = async () => {
    const key = String(state.transcriptCloud.hfApiKey || "").trim();
    if (!key) { setHfHealth(false, "no key set"); return { ok: false }; }
    setHfHealth(null, "checking…");
    const r = await sendBg("hf-test", { apiKey: key });
    if (r && r.ok) {
      setHfHealth(true, `✔ token valid · ${r.ms || 0}ms`);
      logInfo("transcribe.hf.health.ok", { ms: r.ms });
    } else {
      setHfHealth(false, `✗ ${(r && (r.err || (r.status ? `HTTP ${r.status}` : "unreachable"))) || "unreachable"}`);
      logWarn("transcribe.hf.health.fail", { err: r && r.err, status: r && r.status });
    }
    return r;
  };

  const checkGroqHealth = async () => {
    const key = String(state.transcriptCloud.groqApiKey || "").trim();
    if (!key) { setGroqHealth(false, "no key set"); return { ok: false }; }
    setGroqHealth(null, "checking…");
    const r = await sendBg("groq-test", { apiKey: key });
    if (r && r.ok) {
      setGroqHealth(true, `✔ key valid · ${r.ms || 0}ms`);
      logInfo("transcribe.groq.health.ok", { ms: r.ms });
    } else {
      setGroqHealth(false, `✗ ${(r && (r.err || (r.status ? `HTTP ${r.status}` : "unreachable"))) || "unreachable"}`);
      logWarn("transcribe.groq.health.fail", { err: r && r.err, status: r && r.status });
    }
    return r;
  };

  // -------- Local LLM (Ollama) settings + health --------
  const AI_KEY = "fs:ai";
  const loadAiConfig = async () => {
    try {
      const r = await chrome.storage.local.get(AI_KEY);
      const cfg = r && r[AI_KEY];
      if (cfg && typeof cfg === "object") {
        // Migration: existing installs without `provider` had only Ollama
        // configured — keep them on Ollama. New installs (no AI_KEY at all)
        // hit this branch never, and will land on the in-memory default of
        // "ollama" until they paste a Groq key (which auto-flips the toggle).
        const prov = cfg.provider === "groq" ? "groq" : "ollama";
        state.ai = {
          provider: prov,
          _providerExplicit: !!cfg.provider, // any saved provider == explicit
          endpoint: String(cfg.endpoint || state.ai.endpoint),
          model: String(cfg.model || state.ai.model),
          visionModel: String(cfg.visionModel || cfg.model || state.ai.visionModel),
          concurrency: Math.max(1, Math.min(16, Number(cfg.concurrency) || state.ai.concurrency)),
          groq: {
            model: String((cfg.groq && cfg.groq.model) || state.ai.groq.model),
            fastModel: String((cfg.groq && cfg.groq.fastModel) || state.ai.groq.fastModel),
            modelsCache: (cfg.groq && cfg.groq.modelsCache && typeof cfg.groq.modelsCache === "object")
              ? { fetchedAt: Number(cfg.groq.modelsCache.fetchedAt) || 0, models: Array.isArray(cfg.groq.modelsCache.models) ? cfg.groq.modelsCache.models : [] }
              : { fetchedAt: 0, models: [] },
          },
        };
      }
    } catch (e) { logWarn("ai.load.fail", e); }
  };
  const saveAiConfig = async () => {
    try {
      // Strip the in-memory `_providerExplicit` flag from the persisted blob.
      const { _providerExplicit, ...persist } = state.ai;
      await chrome.storage.local.set({ [AI_KEY]: persist });
      logInfo("ai.config.save", {
        provider: state.ai.provider,
        endpoint: state.ai.endpoint, model: state.ai.model,
        groqModel: state.ai.groq.model, groqFast: state.ai.groq.fastModel,
        conc: state.ai.concurrency,
      });
    } catch (e) { logWarn("ai.save.fail", e); }
  };

  // Toggle visibility of the Groq vs Ollama settings sub-blocks based on the
  // active provider. Called whenever the user flips the provider selector or
  // pastes a key that auto-promotes Groq.
  const applyProviderUi = () => {
    const prov = state.ai.provider || "ollama";
    if (els.aiProvider) els.aiProvider.value = prov;
    if (els.aiGroqBlock) els.aiGroqBlock.style.display = prov === "groq" ? "" : "none";
    // The Ollama block is a <details>; auto-collapse when Groq is active.
    if (els.aiOllamaBlock) {
      els.aiOllamaBlock.style.display = "";
      try { els.aiOllamaBlock.open = (prov === "ollama"); } catch { /* ignore */ }
    }
  };

  // Populate the Groq model dropdowns. We always include the user's current
  // selection (even if not in the list) so a manually-saved value survives a
  // model-list refresh that doesn't return it.
  const populateGroqDropdowns = (models) => {
    const all = Array.isArray(models) ? models.slice() : [];
    const ensure = (v) => { if (v && !all.includes(v)) all.push(v); };
    ensure(state.ai.groq.model);
    ensure(state.ai.groq.fastModel);
    ensure("llama-3.3-70b-versatile");
    ensure("llama-3.1-8b-instant");
    const fill = (el, current) => {
      if (!el) return;
      el.innerHTML = "";
      // Filter out non-chat models (whisper, embeddings) when we can detect.
      const chatModels = all.filter((m) => !/whisper|embed|guard/i.test(m));
      const list = chatModels.length ? chatModels : all;
      for (const m of list) {
        const opt = document.createElement("option");
        opt.value = m;
        opt.textContent = m;
        if (m === current) opt.selected = true;
        el.appendChild(opt);
      }
      if (current && !list.includes(current)) {
        const opt = document.createElement("option");
        opt.value = current; opt.textContent = current; opt.selected = true;
        el.appendChild(opt);
      }
    };
    fill(els.aiGroqModel, state.ai.groq.model);
    fill(els.aiGroqFastModel, state.ai.groq.fastModel);
  };

  // Fetch Groq's /openai/v1/models with a 1h cache. No-op (returns the cache)
  // when the cache is fresh or no key is set.
  const GROQ_MODELS_CACHE_MS = 60 * 60 * 1000;
  let groqModelsInflight = null;
  const refreshGroqModels = async ({ force = false } = {}) => {
    const key = String((state.transcriptCloud && state.transcriptCloud.groqApiKey) || "").trim();
    if (!key) {
      populateGroqDropdowns([]);
      return { ok: false, err: "no-key" };
    }
    const cache = state.ai.groq.modelsCache || { fetchedAt: 0, models: [] };
    const fresh = !force && (Date.now() - cache.fetchedAt) < GROQ_MODELS_CACHE_MS && cache.models.length;
    if (fresh) {
      populateGroqDropdowns(cache.models);
      return { ok: true, models: cache.models, cached: true };
    }
    if (groqModelsInflight) return groqModelsInflight;
    groqModelsInflight = (async () => {
      try {
        const resp = await fetch("https://api.groq.com/openai/v1/models", {
          method: "GET",
          headers: { "Authorization": `Bearer ${key}` },
        });
        if (!resp.ok) {
          logWarn("ai.groq.models.fail", { status: resp.status });
          populateGroqDropdowns(cache.models || []);
          return { ok: false, status: resp.status };
        }
        const raw = await resp.json();
        const models = Array.isArray(raw && raw.data)
          ? raw.data.map((m) => (m && typeof m.id === "string" ? m.id : null)).filter(Boolean)
          : [];
        state.ai.groq.modelsCache = { fetchedAt: Date.now(), models };
        saveAiConfig().catch(() => {});
        populateGroqDropdowns(models);
        logInfo("ai.groq.models.ok", { count: models.length });
        return { ok: true, models };
      } catch (e) {
        logWarn("ai.groq.models.fail", e);
        populateGroqDropdowns(cache.models || []);
        return { ok: false, err: String(e && e.message || e) };
      } finally {
        groqModelsInflight = null;
      }
    })();
    return groqModelsInflight;
  };

  // -------- "Me" username (rewrite voice source) --------
  const ME_KEY = "fs:me";
  const loadMeConfig = async () => {
    try {
      const r = await chrome.storage.local.get(ME_KEY);
      const cfg = r && r[ME_KEY];
      if (cfg && typeof cfg === "object" && typeof cfg.username === "string") {
        state.me.username = String(cfg.username || "").toLowerCase().replace(/^@/, "").trim();
      }
    } catch (e) { logWarn("me.load.fail", e); }
  };
  const saveMeConfig = async () => {
    try {
      await chrome.storage.local.set({ [ME_KEY]: { username: state.me.username } });
      logInfo("me.config.save", { username: state.me.username });
    } catch (e) { logWarn("me.save.fail", e); }
  };
  const setAiHealth = (ok, msg, models) => {
    state.aiHealth = { ok, msg: msg || "", models: Array.isArray(models) ? models : [], checkedAt: Date.now() };
    if (els.aiHealth) {
      els.aiHealth.textContent = msg || (ok ? "ok" : "unreachable");
      els.aiHealth.dataset.level = ok ? "ok" : (ok === false ? "err" : "unknown");
      if (Array.isArray(models) && models.length) {
        els.aiHealth.title = `models: ${models.join(", ")}`;
      } else {
        els.aiHealth.title = "";
      }
    }
  };
  // Centralized provider injection. Every `chat()` callsite passes the
  // logical model (e.g. state.ai.model = "gemma4") — we rewrite the payload
  // here so callers stay provider-agnostic. For Groq, the model is replaced
  // with the configured main/fast model based on `kind`.
  const FAST_KINDS_AI = new Set(["hook", "topic", "hookType", "per-post-analysis", "niche-label"]);
  const aiInjectPayload = (payload) => {
    const p = { ...(payload || {}) };
    const provider = state.ai.provider || "ollama";
    if (provider === "groq") {
      p.provider = "groq";
      p.apiKey = String((state.transcriptCloud && state.transcriptCloud.groqApiKey) || "").trim();
      p.model = state.ai.groq.model || "llama-3.3-70b-versatile";
      p.fastModel = state.ai.groq.fastModel || "llama-3.1-8b-instant";
    } else {
      p.provider = "ollama";
      p.endpoint = state.ai.endpoint;
      // Caller-provided `model` (e.g. visionModel for image kinds) wins.
    }
    return p;
  };
  // Install the wrapper as soon as the bridge is available. Idempotent —
  // marks the wrapped fn so reload-during-dev doesn't double-wrap.
  const installLlmProviderWrapper = () => {
    if (!window.__fsLlm || !window.__fsLlm.chat) return false;
    if (window.__fsLlm.chat.__fsWrapped) return true;
    const orig = window.__fsLlm.chat.bind(window.__fsLlm);
    const wrapped = (payload) => orig(aiInjectPayload(payload));
    wrapped.__fsWrapped = true;
    window.__fsLlm.chat = wrapped;
    return true;
  };
  if (!installLlmProviderWrapper()) {
    // Bridge may not have loaded yet — retry on next tick.
    setTimeout(installLlmProviderWrapper, 0);
  }

  const checkAiHealth = async () => {
    if (!window.__fsLlm) {
      setAiHealth(false, "✗ llm-bridge unavailable");
      return { ok: false, err: "llm-bridge unavailable" };
    }
    const provider = state.ai.provider || "ollama";
    setAiHealth(null, "checking…");
    try {
      let body;
      if (provider === "groq") {
        const apiKey = String((state.transcriptCloud && state.transcriptCloud.groqApiKey) || "").trim();
        if (!apiKey) {
          setAiHealth(false, "✗ no Groq key set");
          logWarn("ai.health.fail", { provider, err: "no-key" });
          return { ok: false, err: "no-key" };
        }
        body = await window.__fsLlm.healthCheck({ provider: "groq", apiKey });
      } else {
        body = await window.__fsLlm.healthCheck({ provider: "ollama", endpoint: state.ai.endpoint });
      }
      const models = (body && body.models) || [];
      const want = provider === "groq" ? state.ai.groq.model : state.ai.model;
      const has = models.some((m) => m === want || m.startsWith(want + ":"));
      const note = has ? "" : ` · ${want} not available`;
      const label = provider === "groq" ? "Groq" : "Ollama";
      setAiHealth(true, `${label} · ${want} ✓${note}`, models);
      logInfo("ai.health.ok", { provider, models: models.length, model: want, hasModel: has });
      return { ok: true, body };
    } catch (e) {
      const label = provider === "groq" ? "Groq" : "Ollama";
      setAiHealth(false, `${label} · ✗ ${String(e && e.message || e).slice(0, 80)}`);
      logWarn("ai.health.fail", { provider, err: String(e && e.message || e) });
      return { ok: false, err: String(e && e.message || e) };
    }
  };
  const clearAiCache = async () => {
    try {
      const r = await (window.__fsLlm ? window.__fsLlm.clearCache() : Promise.reject(new Error("llm-bridge unavailable")));
      const n = (r && r.cleared) || 0;
      setStatus(`AI cache cleared (${n} entr${n === 1 ? "y" : "ies"})`);
      logInfo("ai.cache.cleared", { entries: n });
    } catch (e) {
      setStatus(`cache clear failed: ${String(e && e.message || e)}`);
      logWarn("ai.cache.clear.fail", e);
    }
  };

  // -------- Per-post LLM analysis (hook + topic) --------
  // Mirrors src/analysis/post-analysis.js — keep schemas/prompts in sync.
  // Calls the SW-resident bridge (window.__fsLlm.chat), which provides the
  // (model, promptHash) cache contract from background.js.
  const HOOK_TYPES = ["question", "contrarian", "listicle", "curiosity-gap", "stat-drop", "story-open", "other"];
  const HOOK_SCHEMA = {
    type: "object",
    properties: {
      hook: { type: "string" },
      hookType: { type: "string", enum: HOOK_TYPES },
    },
    required: ["hook", "hookType"],
  };
  const TOPIC_SCHEMA = {
    type: "object",
    properties: {
      topic: { type: "string" },
      angle: { type: "string" },
    },
    required: ["topic", "angle"],
  };
  const HOOK_SYSTEM = [
    "You analyze short-form social-media posts and extract the HOOK.",
    "Return strict JSON matching the schema. No commentary, no markdown.",
    "Rules:",
    "- 'hook' MUST be ≤12 words, verbatim or lightly normalized.",
    "- 'hookType' MUST be one of: question, contrarian, listicle, curiosity-gap, stat-drop, story-open, other.",
  ].join("\n");
  const TOPIC_SYSTEM = [
    "You analyze short-form social-media posts and extract TOPIC + ANGLE.",
    "Return strict JSON matching the schema. No commentary, no markdown.",
    "- 'topic' is the subject in 1–3 lowercase words.",
    "- 'angle' is the treatment in 1–4 lowercase words (e.g. myth-busting, how-to, before/after, rant, tutorial, storytime).",
  ].join("\n");
  const buildAiUser = (p) => {
    const desc = String((p && p.desc) || "").trim();
    const segs = Array.isArray(p && p.transcriptSegments) ? p.transcriptSegments : null;
    const head = segs ? segs.slice(0, 3).map((s) => String(s && s.text || "").trim()).filter(Boolean) : [];
    const out = [`CAPTION:\n${desc || "(no caption)"}`];
    if (head.length) out.push(`TRANSCRIPT (first ${head.length} segments):\n${head.join(" ")}`);
    return out.join("\n\n");
  };
  // Tiny djb2 (matches src/lib/llm.js promptHash on canonical objects).
  const aiCanon = (v) => {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(aiCanon).join(",") + "]";
    const k = Object.keys(v).sort();
    return "{" + k.map((kk) => JSON.stringify(kk) + ":" + aiCanon(v[kk])).join(",") + "}";
  };
  const aiHash = (payload) => {
    const s = aiCanon(payload);
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
    return ((h >>> 0).toString(16)).padStart(8, "0");
  };
  const descHashOf = (p) => aiHash({
    desc: String((p && p.desc) || "").trim(),
    segs: Array.isArray(p && p.transcriptSegments)
      ? p.transcriptSegments.slice(0, 3).map((s) => String(s && s.text || "").trim())
      : [],
  });
  const sanitizeHookType = (t) => HOOK_TYPES.includes(String(t)) ? String(t) : "other";
  const trimWords = (s, max) => String(s || "").trim().split(/\s+/).filter(Boolean).slice(0, max).join(" ");

  // Status: { running, done, total, fail }
  state.aiBatch = { running: false, cancel: false, done: 0, total: 0, fail: 0 };

  const setAiStatus = () => {
    const b = state.aiBatch;
    if (b.running) setStatus(`analyzing ${b.done}/${b.total}…`);
  };

  const analyzeOne = async (p, { force = false } = {}) => {
    if (!p || !p.id) return null;
    if (!window.__fsLlm) {
      logWarn("ai.analyze.skip", { id: p.id, reason: "bridge-unavailable" });
      return null;
    }
    const dh = descHashOf(p);
    if (!force && p.ai && p.ai.descHash === dh && p.ai.hook) {
      logDebug("ai.analyze.skip", { id: p.id, reason: "cache-fresh" });
      return p.ai;
    }
    const model = String(state.ai && state.ai.model || "gemma4");
    const userContent = buildAiUser(p);
    const hookMessages = [
      { role: "system", content: HOOK_SYSTEM },
      { role: "user", content: userContent },
    ];
    const topicMessages = [
      { role: "system", content: TOPIC_SYSTEM },
      { role: "user", content: userContent },
    ];
    logInfo("ai.analyze.start", { id: p.id, model });
    try {
      const [hookR, topicR] = await Promise.all([
        window.__fsLlm.chat({
          model, messages: hookMessages, schema: HOOK_SCHEMA,
          kind: "hook", postId: p.id, options: { temperature: 0.1 },
        }),
        window.__fsLlm.chat({
          model, messages: topicMessages, schema: TOPIC_SCHEMA,
          kind: "topic", postId: p.id, options: { temperature: 0.1 },
        }),
      ]);
      const hj = hookR && hookR.json;
      const tj = topicR && topicR.json;
      if (!hj || !tj) throw new Error("missing JSON in chat response");
      const ai = {
        hook: trimWords(hj.hook, 12),
        hookType: sanitizeHookType(hj.hookType),
        topic: String(tj.topic || "").toLowerCase().trim(),
        angle: String(tj.angle || "").toLowerCase().trim(),
        analyzedAt: Date.now(),
        model,
        descHash: dh,
      };
      // Merge into in-memory + IDB.
      const merged = { ...p, ai };
      posts.set(p.id, merged);
      if (window.__fsStore && window.__fsStore.setPostAi) {
        try { await window.__fsStore.setPostAi(p.id, ai); }
        catch (e) { logWarn("ai.analyze.persist.fail", e, { id: p.id }); }
      }
      logInfo("ai.analyze.ok", {
        id: p.id, hookType: ai.hookType, topic: ai.topic, angle: ai.angle,
        cachedHook: !!hookR.cached, cachedTopic: !!topicR.cached,
      });
      return ai;
    } catch (e) {
      logWarn("ai.analyze.fail", e, { id: p.id });
      throw e;
    }
  };

  const analyzeOneForUI = async (p) => {
    try {
      await analyzeOne(p, { force: !!(p.ai && p.ai.descHash) });
      render();
    } catch (e) {
      setStatus(`analyze failed: ${String(e && e.message || e).slice(0, 80)}`);
    }
  };

  const analyzeTopN = async (n) => {
    if (state.aiBatch.running) { setStatus("analyze batch already running"); return; }
    const list = filtered().filter((p) => (p._score || 0) >= 1.5);
    const targets = list.slice(0, Math.max(1, n | 0));
    if (!targets.length) {
      setStatus("no posts with score ≥ 1.5 in current view");
      return;
    }
    const conc = Math.max(1, Math.min(8, Number(state.ai && state.ai.concurrency) || 2));
    state.aiBatch = { running: true, cancel: false, done: 0, total: targets.length, fail: 0 };
    setAiStatus();
    logInfo("ai.batch.start", { total: targets.length, concurrency: conc });
    const queue = targets.slice();
    const worker = async () => {
      while (queue.length && !state.aiBatch.cancel) {
        const p = queue.shift();
        try { await analyzeOne(p); }
        catch { state.aiBatch.fail++; }
        state.aiBatch.done++;
        setAiStatus();
      }
    };
    const workers = Array.from({ length: Math.min(conc, targets.length) }, worker);
    await Promise.all(workers);
    const b = state.aiBatch;
    state.aiBatch.running = false;
    setStatus(`analyze done · ${b.done - b.fail}/${b.total} ok${b.fail ? ` · ${b.fail} failed` : ""}`);
    logInfo("ai.batch.end", { done: b.done, fail: b.fail, total: b.total });
    render();
  };

  // -------- Per-post outlier diagnosis (multimodal Gemma) --------
  // Mirrors src/analysis/diagnose.js — keep schema/prompt in sync.
  // ONE chat call: cover image (base64) + caption + transcript + score vs.
  // creator's median for the same format.
  const DIAGNOSIS_SCHEMA = {
    type: "object",
    properties: {
      hookStrength: { type: "number", minimum: 1, maximum: 10 },
      visualHookStrength: { type: "number", minimum: 1, maximum: 10 },
      topicNovelty: { type: "number", minimum: 1, maximum: 10 },
      emotionalDriver: { type: "string" },
      structuralPattern: { type: "string" },
      hypothesis: { type: "string" },
    },
    required: [
      "hookStrength", "visualHookStrength", "topicNovelty",
      "emotionalDriver", "structuralPattern", "hypothesis",
    ],
  };
  const DIAGNOSE_SYSTEM = [
    "You are a short-form-video performance analyst.",
    "You are shown the COVER FRAME of a post plus its caption, transcript,",
    "and quantitative score versus the creator's own baseline. Explain WHY",
    "this post overperformed (or underperformed). Return strict JSON matching",
    "the schema. No commentary. No markdown fences.",
    "",
    "Score rubrics (1=weak, 10=exceptional):",
    "  hookStrength       — opening TEXT hook (caption + first transcript line).",
    "  visualHookStrength — COVER FRAME as a stop-the-scroll image (face, eye",
    "                       contact, bold text overlay, contrast, novelty).",
    "  topicNovelty       — how fresh the topic+angle feels in this niche.",
    "",
    "  emotionalDriver    — dominant emotion (e.g. 'envy', 'awe', 'vindication').",
    "  structuralPattern  — format pattern in 1–4 words (e.g. 'before/after",
    "                       reveal', 'POV reaction', 'numbered listicle').",
    "  hypothesis         — ≤80 words, ONE concrete sentence. MUST reference at",
    "                       least one VISIBLE element of the cover (face,",
    "                       expression, text overlay, prop, color, framing).",
    "                       Generic answers are unacceptable.",
    "Do not all-cluster scores at 5 — calibrate against the score-vs-median",
    "signal in the user message.",
  ].join("\n");

  const dxFormatOf = (p) => {
    if (!p) return "single";
    if (p.isReel || p.mediaType === 2) return "reel";
    if (p.mediaType === 8 || (p.carouselCount || 0) > 1) return "carousel";
    return "single";
  };
  const dxMedian = (xs) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const dxCohortMedian = (post, metric = "likes") => {
    const fmt = dxFormatOf(post);
    const author = post.author || "";
    if (!author) return 0;
    const vals = [];
    for (const c of posts.values()) {
      if (!c || c.author !== author) continue;
      if (dxFormatOf(c) !== fmt) continue;
      const v = Number(c[metric]) || 0;
      if (v > 0) vals.push(v);
    }
    return dxMedian(vals);
  };
  const dxBlobToB64 = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error || new Error("FileReader failed"));
    r.onload = () => {
      const s = String(r.result || "");
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    r.readAsDataURL(blob);
  });
  const dxFetchCoverB64 = async (url) => {
    const resp = await fetch(url, { credentials: "omit" });
    if (!resp.ok) {
      const e = new Error(`cover fetch HTTP ${resp.status}`);
      e.name = "CoverFetchError";
      throw e;
    }
    return dxBlobToB64(await resp.blob());
  };
  const dxClampInt = (v, lo, hi, fb) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fb;
    return Math.max(lo, Math.min(hi, Math.round(n)));
  };
  const dxTrimWords = (s, max) => String(s || "").trim().split(/\s+/).filter(Boolean).slice(0, max).join(" ");

  const dxBuildUser = (post, creatorMedian, metric) => {
    const desc = String(post.desc || "").trim();
    const transcript = String(post.transcript || "").trim();
    const score = Number(post._score) || 0;
    const basis = String(post._scoreBasis || "");
    const v = Number(post[metric]) || 0;
    const fmt = dxFormatOf(post);
    const lines = [];
    lines.push(`AUTHOR: @${post.author || "(unknown)"}`);
    lines.push(`FORMAT: ${fmt}${post.surface ? ` · surface=${post.surface}` : ""}`);
    lines.push(`OUTLIER SCORE: ${score ? score.toFixed(2) + "x" : "n/a"}${basis ? ` (basis=${basis})` : ""}`);
    if (creatorMedian > 0) {
      const ratio = v > 0 ? (v / creatorMedian).toFixed(2) : "n/a";
      lines.push(`CREATOR'S MEDIAN ${metric.toUpperCase()} FOR ${fmt.toUpperCase()}: ${Math.round(creatorMedian)} · this post: ${Math.round(v)} (${ratio}×)`);
    } else if (v > 0) {
      lines.push(`THIS POST'S ${metric.toUpperCase()}: ${Math.round(v)}`);
    }
    lines.push("");
    lines.push(`CAPTION:\n${desc || "(no caption)"}`);
    if (transcript) {
      const t = transcript.length > 1200 ? transcript.slice(0, 1200) + "…" : transcript;
      lines.push(""); lines.push(`TRANSCRIPT:\n${t}`);
    }
    return lines.join("\n");
  };

  state.dxBatch = { running: false, cancel: false, done: 0, total: 0, fail: 0 };
  state.dxInflight = new Set();

  const diagnoseOne = async (p) => {
    if (!p || !p.id) return null;
    if (!window.__fsLlm) {
      logWarn("diagnose.skip", { id: p.id, reason: "bridge-unavailable" });
      throw new Error("LLM bridge unavailable");
    }
    if (!p.cover) {
      const e = new Error("no cover image to diagnose");
      e.name = "CoverFetchError";
      throw e;
    }
    const model = String((state.ai && state.ai.visionModel) || (state.ai && state.ai.model) || "gemma4");
    state.dxInflight.add(p.id);
    logInfo("diagnose.start", { id: p.id, model, cover: p.cover.slice(0, 80) });
    let coverB64;
    try {
      coverB64 = await dxFetchCoverB64(p.cover);
    } catch (e) {
      state.dxInflight.delete(p.id);
      logWarn("diagnose.cover.fail", e, { id: p.id });
      throw e;
    }
    const median = dxCohortMedian(p, state.metric || "likes");
    const userContent = dxBuildUser(p, median, state.metric || "likes");
    try {
      const resp = await window.__fsLlm.chat({
        model,
        messages: [
          { role: "system", content: DIAGNOSE_SYSTEM },
          { role: "user", content: userContent },
        ],
        schema: DIAGNOSIS_SCHEMA,
        images: [coverB64],
        kind: "diagnose",
        postId: p.id,
        options: { temperature: 0.2 },
      });
      if (!resp || !resp.json) {
        const e = new Error("model returned no JSON — pull a multimodal Gemma (e.g. gemma3:12b)");
        e.name = "DiagnosisSchemaError";
        throw e;
      }
      const j = resp.json;
      const diagnosis = {
        hookStrength: dxClampInt(j.hookStrength, 1, 10, 5),
        visualHookStrength: dxClampInt(j.visualHookStrength, 1, 10, 5),
        topicNovelty: dxClampInt(j.topicNovelty, 1, 10, 5),
        emotionalDriver: String(j.emotionalDriver || "").trim().slice(0, 80),
        structuralPattern: String(j.structuralPattern || "").trim().slice(0, 80),
        hypothesis: dxTrimWords(j.hypothesis, 80),
        analyzedAt: Date.now(),
        model: resp.model || model,
      };
      for (const k of ["emotionalDriver", "structuralPattern", "hypothesis"]) {
        if (!diagnosis[k]) {
          const e = new Error(`model returned empty '${k}' — pull a multimodal Gemma (e.g. gemma3:12b)`);
          e.name = "DiagnosisSchemaError";
          throw e;
        }
      }
      const merged = { ...p, diagnosis };
      posts.set(p.id, merged);
      if (window.__fsStore && window.__fsStore.setPostDiagnosis) {
        try { await window.__fsStore.setPostDiagnosis(p.id, diagnosis); }
        catch (e) { logWarn("diagnose.persist.fail", e, { id: p.id }); }
      }
      logInfo("diagnose.ok", {
        id: p.id, hook: diagnosis.hookStrength, visual: diagnosis.visualHookStrength,
        novelty: diagnosis.topicNovelty, emo: diagnosis.emotionalDriver,
      });
      return diagnosis;
    } catch (e) {
      logWarn("diagnose.fail", e, { id: p.id });
      throw e;
    } finally {
      state.dxInflight.delete(p.id);
    }
  };

  const diagnoseOneForUI = async (p) => {
    if (state.expandedId !== p.id) { state.expandedId = p.id; render(); }
    render();
    try {
      await diagnoseOne(p);
      render();
    } catch (e) {
      const msg = String(e && e.message || e).slice(0, 120);
      setStatus(`diagnose failed: ${msg}`);
      render();
    }
  };

  const diagnoseTopN = async (n) => {
    if (state.dxBatch.running) { setStatus("diagnose batch already running"); return; }
    const list = filtered().filter((p) => (p._score || 0) >= 3 && p.cover);
    const targets = list.slice(0, Math.max(1, n | 0));
    if (!targets.length) { setStatus("no posts with score ≥ 3 in current view"); return; }
    state.dxBatch = { running: true, cancel: false, done: 0, total: targets.length, fail: 0 };
    setStatus(`diagnosing 0/${targets.length}…`);
    logInfo("diagnose.batch.start", { total: targets.length });
    for (const p of targets) {
      if (state.dxBatch.cancel) break;
      try { await diagnoseOne(p); }
      catch { state.dxBatch.fail++; }
      state.dxBatch.done++;
      setStatus(`diagnosing ${state.dxBatch.done}/${state.dxBatch.total}…`);
      render();
    }
    const b = state.dxBatch;
    state.dxBatch.running = false;
    setStatus(`diagnose done · ${b.done - b.fail}/${b.total} ok${b.fail ? ` · ${b.fail} failed (see logs)` : ""}`);
    logInfo("diagnose.batch.end", { done: b.done, fail: b.fail, total: b.total });
    render();
  };

  // -------- Per-post cover-image vision classification --------
  // Mirrors src/analysis/cover-analysis.js — keep schema in sync.
  // ONE chat call per cover: image (base64) + structured-output schema for
  // low-level features (faces, text overlay, composition). Cheap-ish vs
  // diagnose because the prompt is small. Concurrency=1 (vision is heavy
  // locally). Cache key includes the cover URL so repeats are free.
  const COVER_EXPRESSIONS = ["happy", "serious", "surprised", "neutral", "other", "none"];
  const COVER_COMPOSITIONS = ["closeup", "wide", "split", "text-heavy", "product", "other"];
  const COVER_SCHEMA = {
    type: "object",
    properties: {
      hasFace: { type: "boolean" },
      faceCount: { type: "integer", minimum: 0 },
      expression: { type: "string", enum: COVER_EXPRESSIONS },
      hasTextOverlay: { type: "boolean" },
      textContent: { type: ["string", "null"] },
      dominantColor: { type: "string" },
      composition: { type: "string", enum: COVER_COMPOSITIONS },
    },
    required: [
      "hasFace", "faceCount", "expression",
      "hasTextOverlay", "textContent", "dominantColor", "composition",
    ],
  };
  const COVER_SYSTEM = [
    "You are a cover-image classifier for short-form-video thumbnails.",
    "You are shown ONE cover frame. Return strict JSON matching the schema.",
    "No commentary, no markdown fences.",
    "",
    "Field rules:",
    "  hasFace          — true if at least one human face is clearly visible.",
    "  faceCount        — integer count of distinct faces (0 if hasFace=false).",
    "  expression       — dominant facial expression of the most prominent face:",
    "                     'happy' | 'serious' | 'surprised' | 'neutral' |",
    "                     'other' | 'none' (use 'none' when no face).",
    "  hasTextOverlay   — true if there is significant graphic text burned into",
    "                     the image (NOT the IG caption — the cover itself).",
    "  textContent      — verbatim text overlay (≤80 chars) or null when absent.",
    "  dominantColor    — single short color name (e.g. 'red', 'navy', 'beige').",
    "  composition      — 'closeup' | 'wide' | 'split' | 'text-heavy' | 'product' | 'other'.",
  ].join("\n");

  const cvOneOf = (v, allowed, fb) => {
    const s = String(v || "").toLowerCase().trim();
    return allowed.includes(s) ? s : fb;
  };
  // Module-level cache `${model}:${promptHash}` (with cover URL).
  const coverAiCache = new Map();

  state.cvBatch = { running: false, cancel: false, done: 0, total: 0, fail: 0 };
  state.cvInflight = new Set();

  const analyzeCoverOne = async (p) => {
    if (!p || !p.id) return null;
    if (!window.__fsLlm) {
      logWarn("cover.skip", { id: p.id, reason: "bridge-unavailable" });
      throw new Error("LLM bridge unavailable");
    }
    if (!p.cover) {
      const e = new Error("no cover image to analyze");
      e.name = "CoverFetchError";
      throw e;
    }
    const model = String((state.ai && state.ai.visionModel) || (state.ai && state.ai.model) || "gemma4");
    // Cache key includes cover URL — same rule as task c7de9bca.
    const messages = [
      { role: "system", content: COVER_SYSTEM },
      { role: "user", content: "Classify the cover frame attached to this message." },
    ];
    const cacheKey = `${model}:${(window.__fsLlmHash ? window.__fsLlmHash({ messages, schema: COVER_SCHEMA, cover: p.cover }) : (model + ":" + p.cover))}`;
    if (coverAiCache.has(cacheKey)) {
      const cached = coverAiCache.get(cacheKey);
      // Derive the visualFormat rollup (talking-head / info-card / ...) for
      // the in-memory row so the FORMATS chip section updates immediately,
      // not just after the next rehydrate. setPostCoverAi also re-derives
      // it on the IDB side so IDB stays canonical.
      const visualFormat = (globalThis.__fsVisualFormat && typeof globalThis.__fsVisualFormat.deriveVisualFormat === "function")
        ? globalThis.__fsVisualFormat.deriveVisualFormat(cached)
        : (p.visualFormat ?? null);
      const merged = { ...p, cover_ai: cached, visualFormat };
      posts.set(p.id, merged);
      if (window.__fsStore && window.__fsStore.setPostCoverAi) {
        try { await window.__fsStore.setPostCoverAi(p.id, cached); } catch (e) { logWarn("cover.persist.fail", e, { id: p.id }); }
      }
      logInfo("cover.cached", { id: p.id, visualFormat });
      return cached;
    }
    state.cvInflight.add(p.id);
    logInfo("cover.start", { id: p.id, model, cover: p.cover.slice(0, 80) });
    let coverB64;
    try {
      coverB64 = await dxFetchCoverB64(p.cover);
    } catch (e) {
      state.cvInflight.delete(p.id);
      logWarn("cover.fetch.fail", e, { id: p.id });
      throw e;
    }
    try {
      const resp = await window.__fsLlm.chat({
        model,
        messages,
        schema: COVER_SCHEMA,
        images: [coverB64],
        kind: "cover",
        postId: p.id,
        options: { temperature: 0.1 },
      });
      if (!resp || !resp.json) {
        const e = new Error("model returned no JSON — pull a multimodal Gemma (e.g. gemma3:12b)");
        e.name = "CoverSchemaError";
        throw e;
      }
      const j = resp.json;
      const hasFace = !!j.hasFace;
      const faceCount = dxClampInt(j.faceCount, 0, 50, hasFace ? 1 : 0);
      const hasTextOverlay = !!j.hasTextOverlay;
      let textContent = null;
      if (hasTextOverlay && typeof j.textContent === "string") {
        const t = j.textContent.trim();
        if (t) textContent = t.slice(0, 80);
      }
      const coverAi = {
        hasFace,
        faceCount: hasFace ? Math.max(1, faceCount) : 0,
        expression: hasFace
          ? cvOneOf(j.expression, COVER_EXPRESSIONS, "neutral")
          : "none",
        hasTextOverlay,
        textContent,
        dominantColor: String(j.dominantColor || "").trim().slice(0, 24).toLowerCase() || "unknown",
        composition: cvOneOf(j.composition, COVER_COMPOSITIONS, "other"),
        analyzedAt: Date.now(),
        model: resp.model || model,
      };
      coverAiCache.set(cacheKey, coverAi);
      const visualFormat = (globalThis.__fsVisualFormat && typeof globalThis.__fsVisualFormat.deriveVisualFormat === "function")
        ? globalThis.__fsVisualFormat.deriveVisualFormat(coverAi)
        : null;
      const merged = { ...p, cover_ai: coverAi, visualFormat };
      posts.set(p.id, merged);
      if (window.__fsStore && window.__fsStore.setPostCoverAi) {
        try { await window.__fsStore.setPostCoverAi(p.id, coverAi); }
        catch (e) { logWarn("cover.persist.fail", e, { id: p.id }); }
      }
      logInfo("cover.ok", {
        id: p.id, hasFace, faceCount: coverAi.faceCount, expr: coverAi.expression,
        textOv: hasTextOverlay, comp: coverAi.composition, color: coverAi.dominantColor,
        visualFormat,
      });
      return coverAi;
    } catch (e) {
      logWarn("cover.fail", e, { id: p.id });
      throw e;
    } finally {
      state.cvInflight.delete(p.id);
    }
  };

  // "Analyze covers of top N" — gated `_score >= 1.5`. Concurrency 1.
  const analyzeCoversTopN = async (n) => {
    if (state.cvBatch.running) { setStatus("cover batch already running"); return; }
    const list = filtered().filter((p) => (p._score || 0) >= 1.5 && p.cover);
    const targets = list.slice(0, Math.max(1, n | 0));
    if (!targets.length) { setStatus("no posts with score ≥ 1.5 in current view"); return; }
    state.cvBatch = { running: true, cancel: false, done: 0, total: targets.length, fail: 0 };
    setStatus(`analyzing covers 0/${targets.length}…`);
    logInfo("cover.batch.start", { total: targets.length });
    for (const p of targets) {
      if (state.cvBatch.cancel) break;
      try { await analyzeCoverOne(p); }
      catch { state.cvBatch.fail++; }
      state.cvBatch.done++;
      setStatus(`analyzing covers ${state.cvBatch.done}/${state.cvBatch.total}…`);
      render();
    }
    const cb = state.cvBatch;
    state.cvBatch.running = false;
    setStatus(`covers done · ${cb.done - cb.fail}/${cb.total} ok${cb.fail ? ` · ${cb.fail} failed (see logs)` : ""}`);
    logInfo("cover.batch.end", { done: cb.done, fail: cb.fail, total: cb.total });
    render();
  };

  // -------- Voice fingerprint (per-creator style profile) --------
  // Mirrors src/analysis/voice-fingerprint.js — keep schema/prompts in sync.
  // Reads top-N posts from IDB, computes a per-author _score (likes /
  // author-median-likes), filters by minScore=1.5, calls Gemma once with a
  // structured-output schema, and persists to the `voice` IDB store.
  const VOICE_SCHEMA = {
    type: "object",
    properties: {
      tone: { type: "string" },
      avgSentenceLen: { type: "number" },
      signatureWords: { type: "array", items: { type: "string" } },
      emojiRate: { type: "number" },
      openerPatterns: { type: "array", items: { type: "string" } },
      closerPatterns: { type: "array", items: { type: "string" } },
      CTAStyle: { type: "string" },
    },
    required: ["tone", "avgSentenceLen", "signatureWords", "emojiRate", "openerPatterns", "closerPatterns", "CTAStyle"],
  };
  const VOICE_SYSTEM = [
    "You are a voice-and-style profiler for short-form social-media creators.",
    "You will be given the creator's TOP posts (caption + transcript). Your job",
    "is to extract a reusable VOICE FINGERPRINT — patterns that another writer",
    "could follow to produce posts that sound like this creator.",
    "Return strict JSON matching the schema. No commentary, no markdown fences.",
    "Rules:",
    "- Be concrete. 'casual' is useless; 'wry, deadpan, hyper-confident' is useful.",
    "- 'signatureWords' must come from the actual posts — verbatim words/phrases",
    "  the creator reuses, not generic vocabulary.",
    "- 'openerPatterns' and 'closerPatterns' are TEMPLATES — keep variable bits",
    "  in [BRACKETS] (e.g. 'Stop [VERB]ing your [NOUN]', '[NUMBER] reasons …').",
    "- Numeric fields are NUMBERS, not strings.",
  ].join("\n");
  const voiceTrunc = (s, n) => {
    const t = String(s || "").trim();
    return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
  };
  const buildVoicePrompt = (postsArr, truncChars = 500) => {
    return postsArr.map((p, i) => {
      const cap = voiceTrunc(p.desc, truncChars);
      const tx = voiceTrunc(p.transcript, truncChars);
      const stats = [
        typeof p._score === "number" ? `score=${p._score.toFixed(2)}` : null,
        typeof p.likes === "number" ? `likes=${p.likes}` : null,
        typeof p.views === "number" && p.views ? `views=${p.views}` : null,
      ].filter(Boolean).join(" ");
      const lines = [`--- POST ${i + 1}${stats ? " (" + stats + ")" : ""} ---`];
      lines.push(`CAPTION: ${cap || "(none)"}`);
      if (tx) lines.push(`TRANSCRIPT: ${tx}`);
      return lines.join("\n");
    }).join("\n\n");
  };
  const voiceClamp = (v, lo, hi, fb) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fb;
    return Math.max(lo, Math.min(hi, n));
  };
  const voiceDedupe = (arr, max) => {
    const seen = new Set(); const out = [];
    for (const v of Array.isArray(arr) ? arr : []) {
      const s = String(v || "").trim();
      if (!s) continue;
      const k = s.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k); out.push(s);
      if (out.length >= max) break;
    }
    return out;
  };
  const normalizeVoiceJson = (j) => ({
    tone: String((j && j.tone) || "").toLowerCase().trim().slice(0, 80),
    avgSentenceLen: Math.round(voiceClamp(j && j.avgSentenceLen, 1, 80, 12)),
    signatureWords: voiceDedupe(j && j.signatureWords, 20),
    emojiRate: Math.round(voiceClamp(j && j.emojiRate, 0, 100, 0) * 100) / 100,
    openerPatterns: voiceDedupe(j && j.openerPatterns, 8),
    closerPatterns: voiceDedupe(j && j.closerPatterns, 6),
    CTAStyle: String((j && j.CTAStyle) || "").trim().slice(0, 200),
  });
  // Reusable system-prompt builder — mirrors buildSystemPrompt() in the ESM
  // module. Exposed on window.__fsVoice so the rewrite generator (next task)
  // can grab it without re-importing.
  const buildVoiceSystemPrompt = (voice) => {
    if (!voice || typeof voice !== "object") throw new Error("buildVoiceSystemPrompt: voice required");
    const list = (arr) => (Array.isArray(arr) && arr.length)
      ? arr.map((s) => `  - ${s}`).join("\n")
      : "  (none)";
    return [
      `You are writing in the voice of @${voice.username || "(unknown)"}.`,
      "Match their voice EXACTLY. Do not invent your own style.",
      "",
      `TONE: ${voice.tone || "(unspecified)"}`,
      `AVERAGE SENTENCE LENGTH: ~${voice.avgSentenceLen || 12} words.`,
      `EMOJI RATE: ${voice.emojiRate || 0} per 100 words.`,
      `CTA STYLE: ${voice.CTAStyle || "(unspecified)"}`,
      "",
      "SIGNATURE WORDS / PHRASES (reuse these naturally; do not force every one):",
      list(voice.signatureWords),
      "",
      "OPENER PATTERNS (pick one and instantiate the [BRACKETS]):",
      list(voice.openerPatterns),
      "",
      "CLOSER PATTERNS (pick one):",
      list(voice.closerPatterns),
      "",
      "Rules:",
      "- Stay within ~2× the average sentence length.",
      "- Do not break character to explain that you're an AI.",
      "- Do not output markdown fences or commentary — only the rewritten post.",
    ].join("\n");
  };
  window.__fsVoice = { buildSystemPrompt: buildVoiceSystemPrompt };

  // -------- Repurpose / rewrite (mirrors src/analysis/rewrite.js) --------
  // Kept in-line so the content script doesn't need to dynamic-import an
  // ESM module (MV3 content scripts can't reliably do that). The module is
  // tested in isolation; this mirror just calls the same shapes.

  const REWRITE_PLATFORMS = ["tiktok", "yt_shorts", "x", "linkedin"];

  const REWRITE_SCHEMAS = {
    tiktok: {
      type: "object",
      properties: {
        hook: { type: "string" },
        script: { type: "string" },
        hashtags: { type: "array", items: { type: "string" } },
        cta: { type: "string" },
      },
      required: ["hook", "script", "hashtags", "cta"],
    },
    yt_shorts: {
      type: "object",
      properties: {
        hook: { type: "string" },
        script: { type: "string" },
        onScreenText: {
          type: "array",
          items: {
            type: "object",
            properties: { tStart: { type: "number" }, text: { type: "string" } },
            required: ["tStart", "text"],
          },
        },
        cta: { type: "string" },
      },
      required: ["hook", "script", "onScreenText", "cta"],
    },
    x: {
      type: "object",
      properties: {
        single: { type: "string" },
        thread: { type: "array", items: { type: "string" } },
      },
      required: ["single", "thread"],
    },
    linkedin: {
      type: "object",
      properties: {
        post: { type: "string" },
        hashtags: { type: "array", items: { type: "string" } },
      },
      required: ["post", "hashtags"],
    },
  };

  const REWRITE_LABELS = {
    tiktok: "TikTok",
    yt_shorts: "YouTube Shorts",
    x: "X (Twitter)",
    linkedin: "LinkedIn",
  };

  const REWRITE_CONSTRAINTS = {
    tiktok: [
      "Vertical short-form video script.",
      "Length: 30\u201360 seconds when read aloud (\u224880\u2013160 words).",
      "Hook MUST land in the first 1.5 seconds \u2014 front-load the payoff.",
      "Include 1\u20132 hashtags, no more.",
      "End with one explicit CTA (save, follow, comment).",
    ].join("\n"),
    yt_shorts: [
      "Vertical short-form video script.",
      "Length: 30\u201350 seconds (\u224870\u2013130 words).",
      "Hook MUST land in the first 1 second.",
      "Provide on-screen text suggestions every 3\u20135 seconds across the entire duration.",
      "Use retention-optimized pattern interrupts every 5\u20138 seconds.",
      "End with one explicit CTA (subscribe, comment, save).",
    ].join("\n"),
    x: [
      "Two variants required.",
      "`single`: ONE standalone tweet, \u2264280 characters total. No hashtags unless essential.",
      "`thread`: 2\u20135 tweets, each \u2264280 characters. Tweet 1 is the hook. Tweet N is the CTA.",
      "Be punchy. Short sentences.",
    ].join("\n"),
    linkedin: [
      "Long-form post.",
      "Length: 200\u2013400 words.",
      "Professional, thoughtful tone \u2014 no hype.",
      "Use short paragraphs (1\u20133 sentences) with empty lines between them.",
      "1\u20133 thoughtful hashtags, returned WITHOUT the leading #.",
      "CTA MUST be framed as an open-ended question at the end.",
    ].join("\n"),
  };

  const REPURPOSE_NEUTRAL_SYSTEM = [
    "You are a senior social-media editor.",
    "You repurpose a source post into a polished version for a SPECIFIC platform.",
    "You preserve the source's substance, claims, and key examples.",
    "You DO NOT invent facts not present in the source caption or transcript.",
    "Match the platform's native conventions (length, tone, structure).",
    "Return strict JSON matching the schema. No markdown fences, no commentary.",
  ].join("\n");

  const buildRewriteSystem = (voice) => {
    if (voice && typeof voice === "object") {
      return [
        buildVoiceSystemPrompt(voice),
        "",
        "When repurposing for a target platform, FIRST follow the voice rules above,",
        "THEN obey the platform constraints in the user message. If the two conflict,",
        "voice wins on word choice / tone, platform wins on length / structure.",
        "Return strict JSON matching the schema. No markdown fences, no commentary.",
      ].join("\n");
    }
    return REPURPOSE_NEUTRAL_SYSTEM;
  };

  const _rwTrunc = (s, n) => {
    const t = String(s || "").trim();
    if (!t) return "";
    return t.length > n ? t.slice(0, n - 1).trimEnd() + "\u2026" : t;
  };

  const buildRewriteUser = (post, platform, nudge) => {
    const ai = (post && post.ai) || {};
    const author = String((post && post.author) || "").trim();
    const caption = _rwTrunc(post && post.desc, 1200);
    const transcript = _rwTrunc(post && post.transcript, 2000);
    const lines = [
      `TARGET PLATFORM: ${REWRITE_LABELS[platform]}`,
      "",
      "PLATFORM CONSTRAINTS (obey strictly):",
      REWRITE_CONSTRAINTS[platform],
      "",
      "--- SOURCE POST ---",
      author ? `AUTHOR: @${author}` : null,
      `CAPTION: ${caption || "(none)"}`,
      transcript ? `TRANSCRIPT: ${transcript}` : null,
      ai.hookType ? `SOURCE HOOK TYPE: ${ai.hookType}` : null,
      ai.hook ? `SOURCE HOOK LINE: ${ai.hook}` : null,
      ai.topic ? `SOURCE TOPIC: ${ai.topic}` : null,
      ai.angle ? `SOURCE ANGLE: ${ai.angle}` : null,
      "--- END SOURCE ---",
    ];
    const n = String(nudge || "").trim();
    if (n) lines.push("", `EDITORIAL NUDGE (apply on top of constraints): ${_rwTrunc(n, 300)}`);
    lines.push("", `Now produce the rewrite for ${REWRITE_LABELS[platform]}. Return strict JSON matching the schema.`);
    return lines.filter((l) => l !== null).join("\n");
  };

  // Resolve the user's OWN voice fingerprint (the one designated as "me").
  // Falls back to null → neutral system prompt.
  const getMyVoice = async () => {
    const u = String(state.me && state.me.username || "").toLowerCase().trim();
    if (!u) return null;
    if (!window.__fsStore || !window.__fsStore.getVoice) return null;
    try { return (await window.__fsStore.getVoice(u)) || null; }
    catch (e) { logWarn("rewrite.voice.fetch.fail", e, { username: u }); return null; }
  };

  // Run all 4 platforms sequentially for one post. Returns the bundle.
  const rewriteOne = async (post, { platforms = REWRITE_PLATFORMS, nudge = "", onPlatform = null } = {}) => {
    if (!post || !post.id) throw new Error("rewriteOne: post required");
    if (!window.__fsLlm) throw new Error("rewriteOne: LLM bridge unavailable");
    const voice = await getMyVoice();
    const system = { role: "system", content: buildRewriteSystem(voice) };
    const model = String(state.ai && state.ai.model || "gemma4");
    const out = {
      postId: String(post.id), model, generatedAt: 0,
      usedVoice: !!voice, voiceUsername: voice ? voice.username : null,
      results: {}, errors: {},
    };
    for (const platform of platforms) {
      if (!REWRITE_PLATFORMS.includes(platform)) continue;
      if (onPlatform) { try { onPlatform({ platform, status: "start" }); } catch {} }
      const messages = [system, { role: "user", content: buildRewriteUser(post, platform, nudge) }];
      try {
        const t0 = Date.now();
        logInfo("rewrite.platform.start", { id: post.id, platform, model, usedVoice: out.usedVoice });
        const r = await window.__fsLlm.chat({
          model, messages, schema: REWRITE_SCHEMAS[platform],
          kind: `rewrite:${platform}`, postId: post.id,
          options: { temperature: 0.7 },
        });
        const durationMs = Date.now() - t0;
        if (!r || !r.json) throw new Error("chat returned no JSON");
        const row = {
          postId: String(post.id), platform, model,
          generatedAt: Date.now(),
          usedVoice: out.usedVoice, voiceUsername: out.voiceUsername,
          nudge: nudge || "", data: r.json, raw: r.text || null,
          warnings: [], durationMs,
        };
        out.results[platform] = row;
        if (window.__fsStore && window.__fsStore.putRewrite) {
          try { await window.__fsStore.putRewrite(row); }
          catch (e) { logWarn("rewrite.persist.fail", e, { id: post.id, platform }); }
        }
        logInfo("rewrite.platform.ok", { id: post.id, platform, durationMs });
        if (onPlatform) { try { onPlatform({ platform, status: "ok", result: row }); } catch {} }
      } catch (e) {
        const errMsg = String((e && e.message) || e);
        out.errors[platform] = errMsg;
        logWarn("rewrite.platform.fail", e, { id: post.id, platform });
        if (onPlatform) { try { onPlatform({ platform, status: "fail", err: errMsg }); } catch {} }
      }
    }
    out.generatedAt = Date.now();
    return out;
  };

  // -------- Repurpose modal (4 tabs) --------
  const _rwRenderResultHTML = (platform, row) => {
    if (!row) {
      return `<div class="fs-rw-empty">Generating\u2026</div>`;
    }
    if (row.__error) {
      return `<div class="fs-rw-empty fs-rw-err">Failed: ${escHTML(row.__error)}</div>`;
    }
    const d = row.data || {};
    if (platform === "tiktok") {
      const tags = (Array.isArray(d.hashtags) ? d.hashtags : []).map((t) => "#" + String(t).replace(/^#/, "")).join(" ");
      return `<div class="fs-rw-block"><div class="fs-rw-label">Hook</div><div class="fs-rw-text">${escHTML(d.hook || "")}</div></div>
        <div class="fs-rw-block"><div class="fs-rw-label">Script</div><div class="fs-rw-text fs-rw-multi">${escHTML(d.script || "")}</div></div>
        <div class="fs-rw-block"><div class="fs-rw-label">CTA</div><div class="fs-rw-text">${escHTML(d.cta || "")}</div></div>
        <div class="fs-rw-block"><div class="fs-rw-label">Hashtags</div><div class="fs-rw-text">${escHTML(tags)}</div></div>`;
    }
    if (platform === "yt_shorts") {
      const ost = (Array.isArray(d.onScreenText) ? d.onScreenText : []).map(
        (t) => `<li>t=${Number(t.tStart) || 0}s \u2014 ${escHTML(t.text || "")}</li>`
      ).join("");
      return `<div class="fs-rw-block"><div class="fs-rw-label">Hook</div><div class="fs-rw-text">${escHTML(d.hook || "")}</div></div>
        <div class="fs-rw-block"><div class="fs-rw-label">Script</div><div class="fs-rw-text fs-rw-multi">${escHTML(d.script || "")}</div></div>
        <div class="fs-rw-block"><div class="fs-rw-label">On-screen text</div><ul class="fs-rw-ost">${ost}</ul></div>
        <div class="fs-rw-block"><div class="fs-rw-label">CTA</div><div class="fs-rw-text">${escHTML(d.cta || "")}</div></div>`;
    }
    if (platform === "x") {
      const len = (s) => String(s || "").length;
      const thread = (Array.isArray(d.thread) ? d.thread : []).map((t, i) =>
        `<li><span class="fs-rw-cnt">${len(t)}/280</span> ${escHTML(t)}</li>`
      ).join("");
      return `<div class="fs-rw-block"><div class="fs-rw-label">Single <span class="fs-rw-cnt">${len(d.single)}/280</span></div><div class="fs-rw-text fs-rw-multi">${escHTML(d.single || "")}</div></div>
        <div class="fs-rw-block"><div class="fs-rw-label">Thread</div><ol class="fs-rw-thread">${thread}</ol></div>`;
    }
    if (platform === "linkedin") {
      const tags = (Array.isArray(d.hashtags) ? d.hashtags : []).map((t) => "#" + String(t).replace(/^#/, "")).join(" ");
      const wc = String(d.post || "").trim().split(/\s+/).filter(Boolean).length;
      return `<div class="fs-rw-block"><div class="fs-rw-label">Post <span class="fs-rw-cnt">${wc} words</span></div><div class="fs-rw-text fs-rw-multi">${escHTML(d.post || "")}</div></div>
        <div class="fs-rw-block"><div class="fs-rw-label">Hashtags</div><div class="fs-rw-text">${escHTML(tags)}</div></div>`;
    }
    return "";
  };

  const _rwCopyText = (platform, row) => {
    if (!row || !row.data) return "";
    const d = row.data;
    if (platform === "tiktok") {
      const tags = (Array.isArray(d.hashtags) ? d.hashtags : []).map((t) => "#" + String(t).replace(/^#/, "")).join(" ");
      return `${d.hook || ""}\n\n${d.script || ""}\n\n${d.cta || ""}\n\n${tags}`.trim();
    }
    if (platform === "yt_shorts") {
      const ost = (Array.isArray(d.onScreenText) ? d.onScreenText : []).map((t) => `[t=${t.tStart}s] ${t.text}`).join("\n");
      return `${d.hook || ""}\n\n${d.script || ""}\n\nON-SCREEN:\n${ost}\n\n${d.cta || ""}`.trim();
    }
    if (platform === "x") {
      return `SINGLE:\n${d.single || ""}\n\nTHREAD:\n${(Array.isArray(d.thread) ? d.thread : []).map((t, i) => `${i + 1}. ${t}`).join("\n")}`.trim();
    }
    if (platform === "linkedin") {
      const tags = (Array.isArray(d.hashtags) ? d.hashtags : []).map((t) => "#" + String(t).replace(/^#/, "")).join(" ");
      return `${d.post || ""}\n\n${tags}`.trim();
    }
    return "";
  };

  // Per-modal in-memory bundle so tab switches don't lose results.
  const _rwModalState = { postId: null, bundle: null, activeTab: "tiktok" };

  const renderRewriteModalBody = () => {
    if (!els.modal) return;
    const body = els.modal.querySelector(".fs-modal-body");
    if (!body) return;
    const post = posts.get(_rwModalState.postId);
    if (!post) { body.innerHTML = `<div class="fs-rw-empty">Post not found</div>`; return; }
    const bundle = _rwModalState.bundle || { results: {}, errors: {} };
    const tabs = REWRITE_PLATFORMS.map((p) => {
      const has = !!bundle.results[p];
      const fail = !!bundle.errors[p];
      const cls = `fs-rw-tab${_rwModalState.activeTab === p ? " fs-rw-tab-active" : ""}${has ? " fs-rw-tab-done" : ""}${fail ? " fs-rw-tab-fail" : ""}`;
      return `<button class="${cls}" data-act="rw-tab" data-platform="${p}">${REWRITE_LABELS[p]}${has ? " \u2713" : (fail ? " \u2717" : "")}</button>`;
    }).join("");
    const active = _rwModalState.activeTab;
    let activeRow = bundle.results[active];
    if (!activeRow && bundle.errors[active]) activeRow = { __error: bundle.errors[active] };
    const voiceLine = bundle.usedVoice
      ? `Voice: @${escHTML(bundle.voiceUsername || "")}`
      : `Voice: <span class="fs-rw-warn">neutral (set \u201cMe\u201d in Settings to use your voice)</span>`;
    body.innerHTML = `
      <div class="fs-rw-head">
        <div class="fs-rw-tabs">${tabs}</div>
        <div class="fs-rw-meta">${voiceLine} \u00b7 model: ${escHTML(bundle.model || state.ai.model)}</div>
      </div>
      <div class="fs-rw-content" data-rw-content>${_rwRenderResultHTML(active, activeRow)}</div>
      <div class="fs-rw-controls">
        <button class="fs-icon-btn" data-act="rw-copy" data-platform="${active}" ${activeRow && activeRow.data ? "" : "disabled"}>Copy</button>
        <input class="fs-rw-nudge" data-rw-nudge type="text" placeholder="Regenerate nudge (e.g. &quot;more aggressive hook&quot;, &quot;shorter&quot;)" />
        <button class="fs-icon-btn" data-act="rw-regen" data-platform="${active}">Regenerate</button>
        <button class="fs-icon-btn" data-act="rw-regen-all">Regenerate ALL</button>
      </div>
      <div class="fs-rw-status" data-rw-status></div>
    `;
  };

  const setRewriteStatus = (msg) => {
    if (!els.modal) return;
    const s = els.modal.querySelector("[data-rw-status]");
    if (s) s.textContent = String(msg || "");
  };

  const rewriteOneForUI = async (post) => {
    if (!post) return;
    if (state.rewriteInflight.has(post.id)) { setStatus(`repurpose already running for this post`); return; }
    _rwModalState.postId = post.id;
    _rwModalState.bundle = { results: {}, errors: {}, usedVoice: false, voiceUsername: null, model: state.ai.model };
    _rwModalState.activeTab = "tiktok";
    openModal(`\u270d Repurpose \u2014 @${escHTML(post.author || "unknown")}`, "");
    renderRewriteModalBody();
    state.rewriteInflight.add(post.id);
    render(); // refresh row button busy state
    try {
      setRewriteStatus("generating tiktok\u2026");
      const bundle = await rewriteOne(post, {
        platforms: REWRITE_PLATFORMS,
        onPlatform: ({ platform, status, result, err }) => {
          if (status === "start") setRewriteStatus(`generating ${platform}\u2026`);
          if (status === "ok") {
            _rwModalState.bundle.results[platform] = result;
            _rwModalState.bundle.usedVoice = result.usedVoice;
            _rwModalState.bundle.voiceUsername = result.voiceUsername;
            renderRewriteModalBody();
          }
          if (status === "fail") {
            _rwModalState.bundle.errors[platform] = err;
            renderRewriteModalBody();
          }
        },
      });
      _rwModalState.bundle = { ...bundle };
      const okCount = Object.keys(bundle.results).length;
      const failCount = Object.keys(bundle.errors).length;
      setRewriteStatus(`done \u00b7 ${okCount} ok, ${failCount} failed`);
      logInfo("rewrite.bundle.ok", { id: post.id, ok: okCount, fail: failCount });
    } catch (e) {
      setRewriteStatus(`error: ${String(e && e.message || e).slice(0, 120)}`);
      logError("rewrite.bundle.fail", e, { id: post.id });
    } finally {
      state.rewriteInflight.delete(post.id);
      render();
    }
  };

  // Regenerate one platform (with optional nudge).
  const rewriteRegenPlatform = async (postId, platform, nudge) => {
    const post = posts.get(postId);
    if (!post) return;
    if (!REWRITE_PLATFORMS.includes(platform)) return;
    setRewriteStatus(`regenerating ${platform}\u2026`);
    delete _rwModalState.bundle.errors[platform];
    _rwModalState.bundle.results[platform] = null;
    renderRewriteModalBody();
    try {
      const r = await rewriteOne(post, { platforms: [platform], nudge });
      if (r.results[platform]) {
        _rwModalState.bundle.results[platform] = r.results[platform];
        _rwModalState.bundle.usedVoice = r.usedVoice;
        _rwModalState.bundle.voiceUsername = r.voiceUsername;
      }
      if (r.errors[platform]) _rwModalState.bundle.errors[platform] = r.errors[platform];
      renderRewriteModalBody();
      setRewriteStatus(`${platform}: ${r.results[platform] ? "ok" : "failed"}`);
    } catch (e) {
      setRewriteStatus(`regen failed: ${String(e && e.message || e).slice(0, 120)}`);
    }
  };

  // -------- Bulk repurpose (top N outliers → markdown export) --------
  const renderRewriteBatchMarkdown = (items, date) => {
    const fmtTags = (tags) => (Array.isArray(tags) ? tags : [])
      .map((t) => "#" + String(t || "").replace(/^#/, "").trim())
      .filter((s) => s.length > 1).join(" ");
    const sections = items.map(({ post, bundle }) => {
      const lines = [];
      const score = typeof post._score === "number" ? `${post._score.toFixed(2)}\u00d7` : "n/a";
      lines.push(`## @${post.author || "(unknown)"} \u2014 ${score}`);
      if (post.url) lines.push(`<${post.url}>`);
      lines.push("");
      if (post.desc) {
        lines.push("**Original caption:**");
        lines.push("> " + String(post.desc).replace(/\n/g, "\n> "));
        lines.push("");
      }
      for (const platform of REWRITE_PLATFORMS) {
        const r = bundle.results[platform];
        lines.push(`### ${REWRITE_LABELS[platform]}`);
        if (!r) { lines.push(`_Failed: ${bundle.errors[platform] || "no result"}_`, ""); continue; }
        const d = r.data || {};
        if (platform === "tiktok") {
          lines.push(`**Hook:** ${d.hook || ""}`, "", "**Script:**", d.script || "", "", `**CTA:** ${d.cta || ""}`);
          const t = fmtTags(d.hashtags); if (t) lines.push(`**Hashtags:** ${t}`);
        } else if (platform === "yt_shorts") {
          lines.push(`**Hook:** ${d.hook || ""}`, "", "**Script:**", d.script || "", "", "**On-screen text:**");
          for (const t of (Array.isArray(d.onScreenText) ? d.onScreenText : [])) lines.push(`- t=${t.tStart}s \u2014 ${t.text}`);
          lines.push("", `**CTA:** ${d.cta || ""}`);
        } else if (platform === "x") {
          lines.push("**Single:**", "> " + String(d.single || "").replace(/\n/g, "\n> "), "", "**Thread:**");
          (Array.isArray(d.thread) ? d.thread : []).forEach((t, i) => lines.push(`${i + 1}. ${t}`));
        } else if (platform === "linkedin") {
          lines.push(d.post || "");
          const t = fmtTags(d.hashtags); if (t) lines.push("", `**Hashtags:** ${t}`);
        }
        lines.push("");
      }
      return lines.join("\n");
    });
    const head = `# Repurpose batch \u2014 ${date.toISOString().slice(0, 10)}\n\n${items.length} post${items.length === 1 ? "" : "s"} \u00b7 ${REWRITE_PLATFORMS.length} platforms each\n\n---\n\n`;
    return head + sections.join("\n---\n\n");
  };

  const rewriteTopOutliers = async (n) => {
    if (state.rewriteBatch.running) { setStatus("repurpose batch already running"); return; }
    const list = filtered().filter((p) => (p._score || 0) >= 1.5);
    const targets = list.slice(0, Math.max(1, n | 0));
    if (!targets.length) { setStatus("no posts with score \u2265 1.5 in current view"); return; }
    state.rewriteBatch = { running: true, cancel: false, done: 0, total: targets.length, fail: 0 };
    setStatus(`repurposing 0/${targets.length}\u2026`);
    logInfo("rewrite.batch.start", { total: targets.length });
    const items = [];
    for (const post of targets) {
      if (state.rewriteBatch.cancel) break;
      try {
        const bundle = await rewriteOne(post, { platforms: REWRITE_PLATFORMS });
        items.push({ post, bundle });
      } catch (e) {
        state.rewriteBatch.fail++;
        items.push({ post, bundle: { results: {}, errors: { _batch: String(e && e.message || e) } } });
      }
      state.rewriteBatch.done++;
      setStatus(`repurposing ${state.rewriteBatch.done}/${state.rewriteBatch.total}\u2026`);
    }
    state.rewriteBatch.running = false;
    const md = renderRewriteBatchMarkdown(items, new Date());
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `repurpose-batch-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    setStatus(`repurpose batch done \u00b7 ${items.length} posts \u00b7 ${state.rewriteBatch.fail} failed`);
    logInfo("rewrite.batch.done", { total: items.length, fail: state.rewriteBatch.fail });
  };

  // -------- Repurpose PIPELINE (full multi-platform content packs) --------
  // Headline feature: download → transcribe → diagnose → rewrite → readme,
  // all running locally, persisted as files, with resume support per step.
  // Orchestrator lives in src/lib/pipeline-runtime.js (mirror of src/pipeline.js).

  state.pipeline = {
    running: false,
    abortCtrl: null,
    minScore: 2,
    count: 10,
    avgPerPostMs: 0,        // moving average for ETA
    samples: 0,             // count of samples folded into the moving avg
    health: { ollama: null, whisper: null, checkedAt: 0 },
    progress: { idx: 0, total: 0, postId: null, step: null, platform: null },
    items: [],              // live list of per-post status rows
  };

  const PIPELINE_AVG_KEY = "fs.pipeline.avg";
  const loadPipelineAvg = async () => {
    try {
      const r = await chrome.storage.local.get([PIPELINE_AVG_KEY]);
      const v = r && r[PIPELINE_AVG_KEY];
      if (v && typeof v.ms === "number") {
        state.pipeline.avgPerPostMs = v.ms;
        state.pipeline.samples = Number(v.n) || 0;
      }
    } catch (e) { logWarn("pipeline.avg.load.fail", e); }
  };
  const savePipelineAvg = async () => {
    try {
      await chrome.storage.local.set({
        [PIPELINE_AVG_KEY]: { ms: state.pipeline.avgPerPostMs, n: state.pipeline.samples },
      });
    } catch (e) { logWarn("pipeline.avg.save.fail", e); }
  };
  loadPipelineAvg();

  // Format a duration in ms as "~3m 20s" / "~45s" for the ETA tag.
  const fmtEta = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `~${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `~${m}m ${r}s` : `~${m}m`;
  };

  // Adapter: download a video to the user's downloads folder via the SW.
  // Returns { filename, bytes? }. We don't read the bytes back — chrome.downloads
  // owns the file once it lands.
  const pipelineDownload = async ({ post, filename }) => {
    if (!post.videoUrl) {
      const e = new Error("no video URL on post");
      e.name = "DownloadError";
      throw e;
    }
    const r = await bgDownload(post.videoUrl, filename);
    if (!r.ok) throw new Error(`download failed: ${r.err || "unknown"}`);
    return { filename, downloadId: r.id };
  };

  // Adapter: write a text artifact (transcript, diagnosis, rewrites, README)
  // by data-URL piped through chrome.downloads. Same folder root as the video.
  const pipelineWriteFile = async ({ path, content }) => {
    const dataUrl = "data:text/markdown;charset=utf-8;base64," +
      btoa(unescape(encodeURIComponent(String(content || ""))));
    const r = await bgDownload(dataUrl, path);
    if (!r.ok) throw new Error(`writeFile failed: ${r.err || "unknown"}`);
    return { path, downloadId: r.id };
  };

  // Adapter: transcribe via the local sidecar. Re-uses transcribeOne so the
  // sentinel/inflight bookkeeping stays identical to the standalone button.
  const pipelineTranscribe = async ({ post }) => {
    if (post.transcript && (post.transcriptSegments || []).length) {
      return {
        text: post.transcript,
        segments: post.transcriptSegments || [],
        language: post.transcriptLang || "",
        model: post.transcriptModel || "",
      };
    }
    const r = await transcribeOne(post, { quiet: true });
    if (!r || !r.ok) throw new Error(`transcribe failed: ${(r && r.err) || "unknown"}`);
    const merged = posts.get(post.id) || post;
    return {
      text: merged.transcript || (r.body && r.body.text) || "",
      segments: merged.transcriptSegments || (r.body && r.body.segments) || [],
      language: merged.transcriptLang || (r.body && r.body.language) || "",
      model: merged.transcriptModel || (r.body && r.body.model) || "",
    };
  };

  const pipelineDiagnose = async ({ post }) => {
    const merged = posts.get(post.id) || post;
    if (merged.diagnosis) return merged.diagnosis;
    return await diagnoseOne(merged);
  };

  const pipelineRewrite = async ({ post, platforms, onPlatform }) => {
    const merged = posts.get(post.id) || post;
    return await rewriteOne(merged, { platforms, onPlatform });
  };

  // Adapter: combined health probe (Ollama /api/tags + Whisper /health).
  const pipelineHealth = async () => {
    const out = { ollama: { ok: false }, whisper: { ok: false } };
    try {
      const h = window.__fsLlm
        ? await window.__fsLlm.healthCheck(state.ai.endpoint)
        : null;
      if (h && h.ok) {
        out.ollama = { ok: true, models: h.models || [], model: state.ai.model };
      } else {
        out.ollama = { ok: false, err: (h && h.err) || "bridge unavailable" };
      }
    } catch (e) { out.ollama = { ok: false, err: String(e && e.message || e) }; }
    try {
      const base = sidecarBase();
      const r = await sendBg("transcribe-health", { sidecarUrl: base });
      if (r && r.ok && r.body && r.body.ok) {
        out.whisper = { ok: true, model: r.body.model || "" };
      } else {
        out.whisper = { ok: false, err: (r && r.err) || "unreachable" };
      }
    } catch (e) { out.whisper = { ok: false, err: String(e && e.message || e) }; }
    state.pipeline.health = { ...out, checkedAt: Date.now() };
    return out;
  };

  // Adapter: IDB sentinel store for resume. Wraps the new pipeline_steps store.
  const pipelineStoreAdapter = {
    getStep: (id, step) => (window.__fsStore && window.__fsStore.getPipelineStep)
      ? window.__fsStore.getPipelineStep(id, step) : null,
    putStep: (id, step, payload) => (window.__fsStore && window.__fsStore.putPipelineStep)
      ? window.__fsStore.putPipelineStep(id, step, payload) : null,
  };

  // ---------------- Pipeline modal ----------------
  const PIPELINE_STEP_LABELS = {
    download: "Download",
    transcribe: "Transcribe",
    diagnose: "Diagnose",
    rewrite: "Rewrite",
    readme: "README",
  };

  const renderPipelineStatusPanel = () => {
    const h = state.pipeline.health;
    const ok = (k) => h[k] && h[k].ok ? "✓" : (h[k] === null ? "…" : "✗");
    const ollama = h.ollama && h.ollama.ok
      ? `✓ Ollama (${escHTML(h.ollama.model || "?")})`
      : `✗ Ollama${h.ollama ? " — " + escHTML(h.ollama.err || "down") : ""}`;
    const whisper = h.whisper && h.whisper.ok
      ? `✓ Whisper (${escHTML(h.whisper.model || "?")})`
      : `✗ Whisper${h.whisper ? " — " + escHTML(h.whisper.err || "down") : ""}`;
    return `<div class="fs-pl-sys">
      <span class="fs-pl-sys-row" data-ok="${h.ollama && h.ollama.ok ? "1" : "0"}">${ollama}</span>
      <span class="fs-pl-sys-row" data-ok="${h.whisper && h.whisper.ok ? "1" : "0"}">${whisper}</span>
    </div>`;
  };

  const renderPipelineItemRow = (item, _i) => {
    const p = item.post;
    const steps = STEPS_FOR_UI.map((s) => {
      const status = item.statusByStep[s] || "pending";
      const sym = status === "ok" ? "✓" : status === "running" ? "•" : status === "skip" ? "↻" : status === "fail" ? "✗" : "·";
      return `<span class="fs-pl-step" data-status="${status}" title="${escHTML(PIPELINE_STEP_LABELS[s] || s)}: ${status}">${sym} ${escHTML(PIPELINE_STEP_LABELS[s] || s)}</span>`;
    }).join("");
    const platforms = (item.platforms || []).map((pl) => {
      const st = item.platformStatus[pl] || "pending";
      const sym = st === "ok" ? "✓" : st === "running" ? "•" : st === "fail" ? "✗" : "·";
      return `<span class="fs-pl-pf" data-status="${st}">${sym} ${pl}</span>`;
    }).join("");
    const score = typeof p._score === "number" ? `${p._score.toFixed(2)}×` : "n/a";
    return `<div class="fs-pl-item" data-status="${item.overall}">
      <div class="fs-pl-item-head">
        <b>@${escHTML(p.author || "unknown")}</b>
        <span class="fs-pl-score">${score}</span>
        <span class="fs-pl-folder" title="${escHTML(item.folder || "")}">${escHTML((item.folder || "").split("/").pop())}</span>
      </div>
      <div class="fs-pl-steps">${steps}</div>
      <div class="fs-pl-platforms">${platforms}</div>
      ${item.error ? `<div class="fs-pl-err">${escHTML(item.error)}</div>` : ""}
    </div>`;
  };

  const STEPS_FOR_UI = ["download", "transcribe", "diagnose", "rewrite", "readme"];

  const renderPipelineModalBody = () => {
    if (!els.modal) return;
    const body = els.modal.querySelector(".fs-modal-body");
    if (!body) return;
    const pl = state.pipeline;
    const remaining = Math.max(0, pl.progress.total - pl.progress.idx);
    const eta = (pl.avgPerPostMs && remaining)
      ? `· ETA ${fmtEta(remaining * pl.avgPerPostMs)}`
      : "";
    const cancelBtn = pl.running
      ? `<button class="fs-icon-btn" data-act="pl-cancel">Cancel</button>`
      : `<button class="fs-icon-btn" data-act="modal-close">Close</button>`;
    const itemsHtml = pl.items.length
      ? pl.items.map(renderPipelineItemRow).join("")
      : `<div class="fs-pl-empty">Waiting to start…</div>`;
    body.innerHTML = `
      <div class="fs-pl-head">
        ${renderPipelineStatusPanel()}
        <div class="fs-pl-meta">
          <span><b>${pl.progress.idx}</b> / ${pl.progress.total} posts ${eta}</span>
          ${cancelBtn}
        </div>
      </div>
      <div class="fs-pl-items">${itemsHtml}</div>
    `;
  };

  const ensurePipelineItem = (postId) => {
    let item = state.pipeline.items.find((x) => x.post && x.post.id === postId);
    if (!item) {
      const post = posts.get(postId) || { id: postId };
      item = {
        post, folder: "",
        statusByStep: {}, platformStatus: {}, platforms: [],
        overall: "pending", error: "",
      };
      state.pipeline.items.push(item);
    }
    return item;
  };

  const onPipelineEvent = (evt) => {
    const pl = state.pipeline;
    if (evt.type === "health.ok") {
      pl.health = { ollama: evt.ollama, whisper: evt.whisper, checkedAt: Date.now() };
    }
    if (evt.type === "batch.start") {
      pl.progress = { idx: 0, total: evt.total, postId: null, step: null, platform: null };
      pl.items = [];
      logInfo("pipeline.batch.start", { total: evt.total, minScore: evt.minScore, platforms: evt.platforms });
    }
    if (evt.type === "post.start") {
      const item = ensurePipelineItem(evt.postId);
      item.folder = evt.folder;
      item.platforms = REWRITE_PLATFORMS.slice();
      item.overall = "running";
      pl.progress.idx = evt.index;
      pl.progress.postId = evt.postId;
      logInfo("pipeline.post.start", { id: evt.postId, idx: evt.index, total: evt.total });
    }
    if (evt.type === "step.start") {
      const item = ensurePipelineItem(evt.postId);
      item.statusByStep[evt.step] = "running";
      pl.progress.step = evt.step;
    }
    if (evt.type === "step.skip") {
      const item = ensurePipelineItem(evt.postId);
      item.statusByStep[evt.step] = "skip";
      logInfo("pipeline.step.skip", { id: evt.postId, step: evt.step });
    }
    if (evt.type === "step.ok") {
      const item = ensurePipelineItem(evt.postId);
      item.statusByStep[evt.step] = "ok";
      logInfo("pipeline.step.ok", { id: evt.postId, step: evt.step, ms: evt.durationMs });
    }
    if (evt.type === "step.fail") {
      const item = ensurePipelineItem(evt.postId);
      item.statusByStep[evt.step] = "fail";
      item.error = `${evt.step}: ${evt.err}`;
      logWarn("pipeline.step.fail", { id: evt.postId, step: evt.step, err: evt.err });
    }
    if (evt.type === "rewrite.platform") {
      const item = ensurePipelineItem(evt.postId);
      const st = evt.status === "ok" ? "ok" : evt.status === "start" ? "running" : "fail";
      item.platformStatus[evt.platform] = st;
      pl.progress.platform = evt.platform;
    }
    if (evt.type === "post.ok") {
      const item = ensurePipelineItem(evt.postId);
      item.overall = "ok";
      // Fold this post's duration into the moving average for ETA.
      const n = pl.samples + 1;
      pl.avgPerPostMs = Math.round((pl.avgPerPostMs * pl.samples + evt.durationMs) / n);
      pl.samples = n;
      savePipelineAvg();
      logInfo("pipeline.post.ok", { id: evt.postId, ms: evt.durationMs, avgMs: pl.avgPerPostMs });
    }
    if (evt.type === "post.fail") {
      const item = ensurePipelineItem(evt.postId);
      item.overall = "fail";
      item.error = item.error || evt.err;
    }
    if (evt.type === "post.aborted") {
      const item = ensurePipelineItem(evt.postId);
      item.overall = "aborted";
    }
    if (evt.type === "batch.end") {
      logInfo("pipeline.batch.end", {
        completed: evt.completed, failed: evt.failed, skipped: evt.skipped,
        ok: evt.ok, aborted: evt.aborted, ms: evt.durationMs,
      });
    }
    renderPipelineModalBody();
  };

  const runPipelineFromUI = async (n) => {
    if (state.pipeline.running) { setStatus("pipeline already running"); return; }
    if (!window.__fsPipeline) { setStatus("pipeline runtime unavailable"); return; }
    const minScore = Number(state.pipeline.minScore) || 2;
    const list = filtered();
    const ranked = list.filter((p) => (p._score || 0) >= minScore && p.videoUrl);
    const targets = ranked.slice(0, Math.max(1, n | 0));
    if (!targets.length) {
      setStatus(`no posts in view with score ≥ ${minScore}× and a video URL`);
      return;
    }
    state.pipeline.running = true;
    state.pipeline.abortCtrl = new AbortController();
    state.pipeline.items = [];
    state.pipeline.progress = { idx: 0, total: targets.length, postId: null, step: null, platform: null };
    state.pipeline.health = { ollama: null, whisper: null, checkedAt: 0 };
    const myVoice = await getMyVoice().catch(() => null);
    openModal(
      `✨ Repurpose pipeline — ${targets.length} post${targets.length === 1 ? "" : "s"}`,
      "",
    );
    renderPipelineModalBody();
    setStatus(`pipeline starting (${targets.length} posts)…`);
    try {
      const result = await window.__fsPipeline.runRepurposePipeline({
        posts: targets,
        minScore,
        count: targets.length,
        platforms: REWRITE_PLATFORMS,
        date: new Date(),
        signal: state.pipeline.abortCtrl.signal,
        adapters: {
          download: pipelineDownload,
          writeFile: pipelineWriteFile,
          transcribe: pipelineTranscribe,
          diagnose: pipelineDiagnose,
          rewrite: pipelineRewrite,
          health: pipelineHealth,
          store: pipelineStoreAdapter,
          voice: myVoice,
        },
        onEvent: onPipelineEvent,
      });
      const tag = result.aborted ? "cancelled" : (result.failed ? "done with failures" : "done");
      setStatus(`pipeline ${tag}: ${result.completed} ok, ${result.failed} failed${result.skipped ? `, ${result.skipped} resumed steps` : ""}`);
    } catch (e) {
      const msg = String(e && e.message || e);
      setStatus(`pipeline error: ${msg.slice(0, 160)}`);
      logError("pipeline.fail", e);
      // Surface health errors prominently in the modal.
      const body = els.modal && els.modal.querySelector(".fs-modal-body");
      if (body) body.insertAdjacentHTML("afterbegin", `<div class="fs-pl-fatal">⚠ ${escHTML(msg)}</div>`);
    } finally {
      state.pipeline.running = false;
      state.pipeline.abortCtrl = null;
      renderPipelineModalBody();
    }
  };

  const cancelPipelineFromUI = () => {
    const ctrl = state.pipeline.abortCtrl;
    if (ctrl) {
      try { ctrl.abort(); } catch {}
      setStatus("pipeline cancelling…");
      logInfo("pipeline.cancel.requested");
    }
  };

  // Footer ETA tag — reflects current top-N input × moving-avg per-post ms.
  const renderPipelineEta = () => {
    const eta = els.root && els.root.querySelector("[data-pl-eta]");
    if (!eta) return;
    const inp = els.root.querySelector('[data-ctl="pipelineTopN"]');
    const n = Math.max(1, Math.min(50, Number(inp && inp.value) || 10));
    const avg = state.pipeline.avgPerPostMs;
    if (state.pipeline.running) {
      const remaining = Math.max(0, state.pipeline.progress.total - state.pipeline.progress.idx);
      eta.textContent = avg && remaining ? `running · ETA ${fmtEta(remaining * avg)}` : `running…`;
      eta.hidden = false;
    } else if (avg) {
      eta.textContent = `ETA ${fmtEta(n * avg)}`;
      eta.hidden = false;
    } else {
      eta.textContent = "";
      eta.hidden = true;
    }
  };

  // Compute per-author median likes — used both as the _score basis for
  // the post selection AND for picking the example post in the preview.
  const medianOf = (nums) => {
    const pos = nums.filter((n) => n > 0).sort((a, b) => a - b);
    if (!pos.length) return 0;
    const m = Math.floor(pos.length / 2);
    return pos.length % 2 ? pos[m] : (pos[m - 1] + pos[m]) / 2;
  };
  const enrichWithScore = (postsArr) => {
    const med = medianOf(postsArr.map((p) => p.likes || 0));
    return postsArr.map((p) => ({
      ...p,
      _score: med > 0 ? (p.likes || 0) / med : 0,
    }));
  };

  const regenerateVoiceForCreator = async (username) => {
    const u = String(username || "").toLowerCase().trim();
    if (!u) return null;
    if (!window.__fsLlm) { setStatus("LLM bridge unavailable"); return null; }
    if (!window.__fsStore || !window.__fsStore.putVoice) { setStatus("IDB voice store unavailable"); return null; }
    if (voiceInflight.has(u)) { setStatus(`voice regen already running for @${u}`); return null; }
    voiceInflight.add(u);
    renderNiche();
    const t0 = Date.now();
    try {
      const all = await window.__fsStore.getByAuthor(u);
      const enriched = enrichWithScore(all || []);
      const candidates = enriched
        .filter((p) => (p._score || 0) >= 1.5)
        .sort((a, b) => (b._score || 0) - (a._score || 0))
        .slice(0, 20);
      if (!candidates.length) {
        setStatus(`@${u}: no posts ≥ 1.5× baseline — collect more first`);
        logWarn("voice.regen.no-source", { username: u, total: all ? all.length : 0 });
        return null;
      }
      const userContent = buildVoicePrompt(candidates, 500);
      const messages = [
        { role: "system", content: VOICE_SYSTEM },
        { role: "user", content: userContent },
      ];
      const model = String(state.ai && state.ai.model || "gemma4");
      logInfo("voice.regen.start", { username: u, sourcePosts: candidates.length, model });
      setStatus(`voice: profiling @${u} from ${candidates.length} posts…`);
      const r = await window.__fsLlm.chat({
        model, messages, schema: VOICE_SCHEMA,
        kind: "voice-fingerprint",
        options: { temperature: 0.2 },
      });
      if (!r || !r.json) throw new Error("chat returned no JSON");
      const v = normalizeVoiceJson(r.json);
      const row = {
        username: u,
        ...v,
        generatedAt: Date.now(),
        sourcePostCount: candidates.length,
        model,
      };
      await window.__fsStore.putVoice(row);
      voiceCache.by.set(u, row);
      const durationMs = Date.now() - t0;
      logInfo("voice.regenerated", { username: u, sourcePosts: candidates.length, durationMs });
      setStatus(`voice ready for @${u} · ${candidates.length} posts · ${(durationMs / 1000).toFixed(1)}s`);
      // Pick the highest-scoring post that has a non-empty caption to show in the preview.
      const example = candidates.find((p) => (p.desc || "").trim().length >= 20) || candidates[0];
      openVoicePreview(row, example).catch((e) => logWarn("voice.preview.fail", e));
      return row;
    } catch (e) {
      logWarn("voice.regen.fail", e, { username: u });
      setStatus(`voice regen failed: ${String(e && e.message || e).slice(0, 80)}`);
      return null;
    } finally {
      voiceInflight.delete(u);
      renderNiche();
    }
  };

  // Sanity-check UX: rewrite the same example post twice — once with the
  // voice fingerprint as system prompt, once with a generic system prompt —
  // and render side-by-side so the user can validate fidelity.
  const REWRITE_NEUTRAL_SYSTEM = [
    "You are a social-media copywriter. Rewrite the post below to be more",
    "engaging and concise while preserving its meaning. Output only the",
    "rewritten post — no commentary, no markdown fences.",
  ].join("\n");

  const oneRewrite = async (systemPrompt, post, model) => {
    const user = `ORIGINAL POST CAPTION:\n${(post.desc || "(no caption)").trim()}`;
    const r = await window.__fsLlm.chat({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: user },
      ],
      kind: "voice-preview",
      options: { temperature: 0.7 },
    });
    return String((r && r.text) || "").trim();
  };

  const openVoicePreview = async (voice, example) => {
    const u = voice.username;
    const dl = (label, items) => `<div class="fs-voice-meta-row"><b>${label}:</b> ${items && items.length ? items.map((s) => `<code>${escHTML(s)}</code>`).join(" \u00b7 ") : "<span style='color:#a8a9b3'>(none)</span>"}</div>`;
    const summaryHTML = `
      <div class="fs-voice-summary">
        <div class="fs-voice-meta-row"><b>Tone:</b> ${escHTML(voice.tone || "—")} · <b>Avg sentence:</b> ~${voice.avgSentenceLen} words · <b>Emoji rate:</b> ${voice.emojiRate}/100w</div>
        <div class="fs-voice-meta-row"><b>CTA:</b> ${escHTML(voice.CTAStyle || "—")}</div>
        ${dl("Signature words", voice.signatureWords)}
        ${dl("Openers", voice.openerPatterns)}
        ${dl("Closers", voice.closerPatterns)}
        <div class="fs-voice-meta-row" style="color:#a8a9b3;font-size:11px">model: ${escHTML(voice.model || "")} · source posts: ${voice.sourcePostCount} · generated ${new Date(voice.generatedAt).toLocaleString()}</div>
      </div>`;
    const exampleHTML = `
      <div class="fs-voice-original">
        <div class="fs-voice-col-head">Original caption</div>
        <div class="fs-voice-orig-body">${escHTML(example && example.desc || "(no caption)")}</div>
      </div>`;
    const sideBySideHTML = `
      <div class="fs-voice-side">
        <div class="fs-voice-col">
          <div class="fs-voice-col-head">WITHOUT fingerprint <span class="fs-voice-col-sub">(generic rewrite)</span></div>
          <div class="fs-voice-col-body" data-voice-without>⏳ generating…</div>
        </div>
        <div class="fs-voice-col fs-voice-col-with">
          <div class="fs-voice-col-head">WITH fingerprint <span class="fs-voice-col-sub">(@${escHTML(u)} voice)</span></div>
          <div class="fs-voice-col-body" data-voice-with>⏳ generating…</div>
        </div>
      </div>`;
    openModal(`Voice fingerprint — @${escHTML(u)}`, summaryHTML + exampleHTML + sideBySideHTML);
    if (!window.__fsLlm) return;
    const model = String(state.ai && state.ai.model || "gemma4");
    const targetWith = els.modal && els.modal.querySelector("[data-voice-with]");
    const targetWithout = els.modal && els.modal.querySelector("[data-voice-without]");
    const fingerprintSystem = buildVoiceSystemPrompt(voice);
    const settle = (el, p) => p.then(
      (txt) => { if (el) el.textContent = txt || "(empty response)"; },
      (err) => { if (el) el.textContent = `failed: ${String(err && err.message || err).slice(0, 120)}`; },
    );
    await Promise.all([
      settle(targetWithout, oneRewrite(REWRITE_NEUTRAL_SYSTEM, example, model)),
      settle(targetWith, oneRewrite(fingerprintSystem, example, model)),
    ]);
    logInfo("voice.preview.rendered", { username: u, postId: example && example.id });
  };

  const downloadVideo = async (p) => {
    if (!p.videoUrl) {
      logWarn("download.skip", { id: p.id, reason: "no-video-url" });
      return;
    }
    logInfo("download.start", { id: p.id, shortcode: p.shortcode });
    try {
      const r = await fetch(p.videoUrl, { credentials: "omit" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${p.author || "ig"}-${p.shortcode || p.id}.mp4`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1500);
      logInfo("download.ok", { id: p.id, bytes: blob.size });
    } catch (e) {
      // Pass the Error through so logWarn lifts its stack into the entry.
      logWarn("download.fail", e, { id: p.id, url: p.videoUrl, fallback: "newtab" });
      setStatus(`download blocked by CDN — opened in new tab`);
      window.open(p.videoUrl, "_blank", "noopener");
    }
  };

  // Mirrors downloadVideo but pulls the audio progressive URL we captured
  // at parse time. Only IG original sounds + most TT music expose this;
  // licensed IG music returns no progressive_download_url for legal
  // reasons — the row button is disabled in that case.
  const downloadAudio = async (p) => {
    const url = p && p.audio && p.audio.downloadUrl;
    if (!url) {
      logWarn("download.audio.skip", { id: p && p.id, reason: "no-audio-url" });
      return;
    }
    const ext = /\.mp3(\?|$)/i.test(url) ? "mp3" : (/\.m4a(\?|$)/i.test(url) ? "m4a" : "mp4");
    const filename = `${p.author || "audio"}-${p.shortcode || p.id}-audio.${ext}`;
    logInfo("download.audio.start", { id: p.id, shortcode: p.shortcode });
    try {
      const r = await fetch(url, { credentials: "omit" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1500);
      logInfo("download.audio.ok", { id: p.id, bytes: blob.size });
    } catch (e) {
      logWarn("download.audio.fail", e, { id: p.id, url, fallback: "newtab" });
      setStatus(`audio download blocked by CDN — opened in new tab`);
      window.open(url, "_blank", "noopener");
    }
  };

  // -------- meta mutations --------
  const togglePin = async (id) => {
    const cur = !!getMetaSync(id)?.pinned;
    const next = !cur;
    logInfo("meta.pin", { id, pinned: next });
    await writeMetaNow(id, { pinned: next });
    // Keep pinnedPosts cache in sync without a full IDB roundtrip.
    if (next) {
      const p = posts.get(id) || pinnedPosts.get(id);
      if (p) pinnedPosts.set(id, p);
      else if (window.__fsStore) {
        // Pinning a post that is in IDB but not in our hot cache (rare).
        try {
          const all = await window.__fsStore.getAll();
          const hit = all.find((r) => r && r.id === id);
          if (hit) pinnedPosts.set(id, hit);
        } catch {}
      }
    } else {
      pinnedPosts.delete(id);
    }
    render();
  };

  const setStatus2 = async (id, status) => {
    const norm = status && STATUSES.includes(status) ? status : null;
    logInfo("meta.status", { id, status: norm });
    await writeMetaNow(id, { status: norm });
    render();
  };

  const addTag = async (id, tag) => {
    const t = String(tag).trim().replace(/^#/, "");
    if (!t) return;
    const cur = getMetaSync(id)?.tags || [];
    if (cur.includes(t)) return;
    const next = [...cur, t];
    logInfo("meta.tag.add", { id, tag: t });
    await writeMetaNow(id, { tags: next });
    if (pinnedPosts.has(id)) pinnedPosts.set(id, { ...pinnedPosts.get(id) });
    render();
  };

  const removeTag = async (id, tag) => {
    const cur = getMetaSync(id)?.tags || [];
    const next = cur.filter((x) => x !== tag);
    if (next.length === cur.length) return;
    logInfo("meta.tag.remove", { id, tag });
    await writeMetaNow(id, { tags: next });
    if (pinnedPosts.has(id)) pinnedPosts.set(id, { ...pinnedPosts.get(id) });
    render();
  };

  // Renders the per-post outlier diagnosis panel inside the row drawer.
  // 6 fields: 3 numeric scores (1–10 bars) + emotionalDriver, structuralPattern,
  // and the ≤80-word hypothesis. Includes a Re-analyze button.
  const dxBar = (label, val) => {
    const v = Math.max(1, Math.min(10, Number(val) || 0));
    const pct = Math.round(v * 10);
    return `<div class="fs-dx-bar-row">
      <span class="fs-dx-bar-label">${escHTML(label)}</span>
      <span class="fs-dx-bar-track"><span class="fs-dx-bar-fill" style="width:${pct}%"></span></span>
      <span class="fs-dx-bar-val">${v}/10</span>
    </div>`;
  };
  const renderDiagnosisBlock = (p, busy) => {
    const d = p && p.diagnosis;
    const canDiagnose = !!p.cover;
    const btnLabel = busy
      ? "Diagnosing…"
      : (d ? "Re-analyze" : "Diagnose outlier");
    const btnTitle = canDiagnose
      ? (d ? "Re-run multimodal diagnosis" : "Explain WHY this post is an outlier (multimodal Gemma)")
      : "No cover image to analyze";
    const btn = `<button class="fs-icon-btn fs-dx-run-btn" data-act="dx-analyze" data-id="${escHTML(p.id)}" ${(!canDiagnose || busy) ? "disabled" : ""} title="${escHTML(btnTitle)}">🔍 ${btnLabel}</button>`;
    if (!d) {
      return `<div class="fs-dx-block">
        <div class="fs-dx-head"><span class="fs-dx-title">Outlier diagnosis</span>${btn}</div>
        <div class="fs-dx-empty">${busy ? "Running multimodal diagnosis…" : "Not analyzed yet."}</div>
      </div>`;
    }
    const ago = d.analyzedAt ? new Date(d.analyzedAt).toLocaleString() : "";
    return `<div class="fs-dx-block">
      <div class="fs-dx-head">
        <span class="fs-dx-title">Outlier diagnosis</span>
        <span class="fs-dx-meta" title="${escHTML(ago)}">${escHTML(d.model || "")}</span>
        ${btn}
      </div>
      ${dxBar("Hook strength", d.hookStrength)}
      ${dxBar("Visual hook", d.visualHookStrength)}
      ${dxBar("Topic novelty", d.topicNovelty)}
      <div class="fs-dx-kv"><span class="fs-dx-k">Emotional driver</span><span class="fs-dx-v">${escHTML(d.emotionalDriver || "")}</span></div>
      <div class="fs-dx-kv"><span class="fs-dx-k">Structural pattern</span><span class="fs-dx-v">${escHTML(d.structuralPattern || "")}</span></div>
      <div class="fs-dx-hyp">${escHTML(d.hypothesis || "")}</div>
    </div>`;
  };

  // Renders one row + (optional) expanded notes/tags block. Pure HTML
  // string so it works for both the main list and the Pinned section.
  const rowHTML = (p, i, opts = {}) => {
    const meta = getMetaSync(p.id) || { pinned: false, status: null, note: "", tags: [] };
    const velocity = p.velocityViewsPerHr || 0;
    const velocityReady = p.velocityReady || p.snapshotCount > 1 || (p.snapshotCount > 0 && p.lastSeenAt > p.firstSeenAt);
    const velocityLabel = velocityReady ? `${fmt(Math.round(velocity))}/hr` : "—";
    const vph = p.vph || 0;
    const cpr = p.cpr || 0;
    const primary =
      state.sort === "relevance"
        ? `<span class="fs-score ${p.__fsRelevance >= 0.6 ? "fs-warm" : ""}" title="${escHTML(p.__fsRelevanceReason || "baseline")}">${p.__fsRelevance != null ? p.__fsRelevance.toFixed(2) : "—"}</span>`
        : state.sort === "outlier"
        ? `<span class="fs-score ${p._score >= 2 ? "fs-warm" : ""}">${fmtScore(p._score)}</span>`
        : state.sort === "status"
          ? `<span class="fs-score">${meta.status ? escHTML(meta.status) : "—"}</span>`
          : state.sort === "velocity"
            ? `<span class="fs-score ${velocity > 0 ? "fs-warm" : ""}" title="Observed views/hour between your first and latest collection snapshots">${velocityLabel}</span>`
            : state.sort === "vph"
              ? `<span class="fs-score ${vph > 0 ? "fs-warm" : ""}" title="Total views ÷ hours since the post was published">${vph > 0 ? fmt(Math.round(vph)) + "/hr" : "—"}</span>`
              : state.sort === "cpr"
                ? `<span class="fs-score ${cpr >= 20 ? "fs-warm" : ""}">${cpr ? cpr.toFixed(1) : "—"}</span>`
                : `<span class="fs-score">${fmt(p[state.sort] || 0)}</span>`;
    const cprBadge = cpr > 0 ? `<span class="fs-cpr-badge" title="Comments per 1k likes">${cpr.toFixed(1)} CPR</span>` : "";
    const desc = escHTML(p.desc || "(no caption)").slice(0, 140);
    // On a profile page, posts the user originally collected from Explore
    // would otherwise render as "· explore" — misleading when we're scoped
    // to one creator. Fall through to the format tag (reel / post) instead.
    const tag = (p.surface === "explore" && pageScope.kind !== "profile")
      ? " · explore"
      : isYouTubePost(p) ? " · short"
        : p.isReel ? " · reel" : "";
    const rising = p.accelerating ? `<span class="fs-rising" title="Recent velocity > 1.5× average">🔥 RISING</span>` : "";
    const who = p.author ? `@${escHTML(p.author)}` : "(unknown)";
    const dlDisabled = p.videoUrl ? "" : "fs-dl-disabled";
    const dlTitle = p.videoUrl ? "Download video" : "No video URL (image post)";
    const audioUrl = p.audio && p.audio.downloadUrl;
    const audioDisabled = audioUrl ? "" : "fs-dl-disabled";
    const audioTitle = audioUrl
      ? "Download audio"
      : "Audio not downloadable (licensed music)";
    const txInflight = state.transcribeInflight.has(p.id);
    const txDone = !!(p.transcript && p.transcript.trim());
    const txIsAlt = txDone && p.transcriptSource === "ig-alt";
    const txIcon = txInflight ? "⏳" : (txDone ? (txIsAlt ? "📝 alt" : "📝") : "✎");
    const txSrcBadge = (txDone && p.transcriptSource && !txInflight)
      ? (() => {
          const s = p.transcriptSource;
          const tag = s === "tiktok-vtt" ? "vtt" : s === "ig-alt" ? "alt" : s === "groq-whisper" ? "groq" : s === "hf-whisper" ? "hf" : s === "whisper" ? "whisper" : s;
          const cls = transcriptSourceClass(s);
          return `<span class="fs-meta-stat fs-tx-badge ${cls}" title="Transcript source: ${escHTML(TRANSCRIPT_SOURCE_LABELS[s] || s)}">${escHTML(tag)}</span>`;
        })()
      : "";
    const txTitle = txInflight
      ? "Transcribing…"
      : (txDone
        ? `Re-transcribe (already have ${(p.transcript || "").length} chars)`
        : (p.videoUrl ? "Transcribe via local sidecar" : "No video URL (image post)"));
    const txDisabledCls = p.videoUrl ? "" : " fs-tx-disabled";
    // Free tier: transcription is locked. Swap the per-row transcribe button
    // for an upgrade chip that routes to <appUrl>/billing. Capture continues
    // unaffected — only this control is gated.
    const txBtn = proAccess()
      ? `<button class="fs-tx-btn${txDone ? " fs-tx-done" : ""}${txInflight ? " fs-tx-busy" : ""}${txDisabledCls}" data-act="transcribe" data-id="${escHTML(p.id)}" title="${escHTML(txTitle)}" ${(txInflight || !p.videoUrl) ? "disabled" : ""}>${txIcon}</button>${txSrcBadge}`
      : `<button class="fs-icon-btn fs-upgrade-chip" data-act="upgrade" data-src="row-transcribe" title="Transcription is a Pro feature — click to upgrade">\uD83D\uDD12 Pro</button>`;
    const tier = p._score >= 10 ? "viral" : p._score >= 5 ? "hot" : p._score >= 2 ? "warm" : "cold";
    // Status takes precedence over tier for the left-border color when set.
    const statusCls = meta.status ? ` fs-status-${meta.status}` : "";
    const focusCls = !opts.pinned && i === state.focusedIdx ? " fs-focused" : "";
    const selCls = state.selected.has(p.id) ? " fs-selected" : "";
    const pinCls = meta.pinned ? " fs-pinned" : "";
    const expandedCls = state.expandedId === p.id ? " fs-expanded" : "";
    const checked = state.selected.has(p.id) ? "checked" : "";
    const pinTitle = meta.pinned ? "Unpin" : "Pin";
    const pinIcon = meta.pinned ? "📌" : "📍";
    const statusOptions = [
      `<option value="" ${!meta.status ? "selected" : ""}>— status</option>`,
      ...STATUSES.map((s) => `<option value="${s}" ${meta.status === s ? "selected" : ""}>${s}</option>`),
    ].join("");
    const noteIcon = (meta.note || "").trim() ? " ✎" : "";
    const tagsHTML = (meta.tags || []).map(
      (t) => `<span class="fs-tag">#${escHTML(t)}<button class="fs-tag-x" type="button" data-act="tag-remove" data-id="${escHTML(p.id)}" data-tag="${escHTML(t)}" title="Remove tag">×</button></span>`
    ).join("");
    const transcriptHTML = state.expandedId === p.id ? renderTranscriptBlock(p) : "";
    const aiBlockHTML = state.expandedId === p.id && p.ai && p.ai.hook
      ? `<div class="fs-ai-block">
          <div class="fs-ai-row"><span class="fs-ai-label">Hook</span> <span class="fs-ai-value">${escHTML(p.ai.hook)}</span> <button class="fs-ai-chip" data-act="ai-pick" data-key="hookType" data-val="${escHTML(p.ai.hookType || "other")}" title="Filter by this hook type">${escHTML(p.ai.hookType || "other")}</button></div>
          <div class="fs-ai-row"><span class="fs-ai-label">Topic</span> <button class="fs-ai-chip" data-act="ai-pick" data-key="topic" data-val="${escHTML(p.ai.topic || "")}" title="Filter by this topic">${escHTML(p.ai.topic || "")}</button> <button class="fs-ai-chip fs-ai-chip-angle" data-act="ai-pick" data-key="angle" data-val="${escHTML(p.ai.angle || "")}" title="Filter by this angle">${escHTML(p.ai.angle || "")}</button></div>
        </div>`
      : "";
    const expandHTML = state.expandedId === p.id
      ? `<div class="fs-row-expand" data-expand-for="${escHTML(p.id)}">
          <textarea class="fs-note-input" data-id="${escHTML(p.id)}" placeholder="Notes (autosaved)…" rows="3">${escHTML(meta.note || "")}</textarea>
          <div class="fs-tag-row">
            ${tagsHTML}
            <input class="fs-tag-input" data-id="${escHTML(p.id)}" type="text" placeholder="Add tag + Enter" autocomplete="off" />
          </div>
          ${aiBlockHTML}
          ${transcriptHTML}
        </div>`
      : "";
    const rank = opts.pinned ? "📌" : (i + 1);
    return `<div class="fs-row fs-tier-${tier}${statusCls}${pinCls}${focusCls}${selCls}${expandedCls}" data-row-id="${escHTML(p.id)}">
      <input type="checkbox" class="fs-check" data-id="${escHTML(p.id)}" ${checked} aria-label="Select row" />
      <span class="fs-rank">${rank}</span>
      <a class="fs-thumb-link" href="${escHTML(p.url)}" target="_blank" rel="noopener" data-cover="${escHTML(p.cover)}" data-video="${escHTML(p.videoUrl || "")}">
        <img class="fs-thumb" src="${escHTML(p.cover)}" referrerpolicy="no-referrer" loading="lazy" />
      </a>
      <div class="fs-meta">
        <button class="fs-meta-caption" data-act="expand" data-id="${escHTML(p.id)}" title="Click to add notes / tags">
          <span class="fs-meta-line1">${who}${tag}${noteIcon}${rising ? " " + rising : ""}</span>
          <span class="fs-meta-stats">
            <span class="fs-meta-stat">${fmt(p.likes)} ♥</span>
            <span class="fs-meta-stat">${state.sort === "velocity" ? velocityLabel : state.sort === "vph" ? (vph > 0 ? fmt(Math.round(vph)) + "/hr" : "0/hr") : fmt(p.views)} ▶</span>
            <span class="fs-meta-stat">${fmt(p.comments)} 💬</span>
            <span class="fs-meta-stat">${fmtDate(p.createTime)}${cprBadge ? " " + cprBadge : ""}</span>
          </span>
        </button>
      </div>
      ${txBtn}
      <button class="fs-dl-audio ${audioDisabled}" data-act="audio-download" data-id="${escHTML(p.id)}" title="${audioTitle}" ${audioUrl ? "" : "disabled"}>🎵</button>
      <button class="fs-dl ${dlDisabled}" data-act="download" data-id="${escHTML(p.id)}" title="${dlTitle}" ${p.videoUrl ? "" : "disabled"}>⬇</button>
      ${expandHTML}
    </div>`;
  };

  const renderChips = () => {
    if (!els.chips) return;
    els.chips.querySelectorAll("[data-chip]").forEach((c) => {
      const kind = c.dataset.chip;
      let active = false;
      if (kind === "pinnedOnly") active = !!state.pinnedOnly;
      else if (kind === "hashtag") active = !!state.hashtagFilter;
      else if (kind === "keyword") active = !!state.keywordFilter;
      else if (kind === "niche") active = !!state.nicheFilter;
      else if (kind === "format") active = !!state.formatFilter;
      else if (kind === "hookType") active = !!state.hookTypeFilter;
      else if (kind === "topic") active = !!state.topicFilter;
      else if (kind === "angle") active = !!state.angleFilter;
      c.classList.toggle("fs-chip-active", active);
    });
    const aiChips = [
      ["hooktype-chip", state.hookTypeFilter, "hookType"],
      ["topic-chip", state.topicFilter, "topic"],
      ["angle-chip", state.angleFilter, "angle"],
    ];
    for (const [attr, val, label] of aiChips) {
      const el = els.chips.querySelector(`[data-${attr}]`);
      if (!el) continue;
      if (val) {
        el.hidden = false;
        el.textContent = `${label}: ${val} ✕`;
        el.title = `Clear ${label} filter`;
      } else {
        el.hidden = true;
      }
    }
    // Mirror the live state into the new selects (status / has).
    const statusSel = els.chips.querySelector('[data-ctl="statusFilter"]');
    if (statusSel) statusSel.value = state.statusFilter || "";
    const hasSel = els.chips.querySelector('[data-ctl="hasFilter"]');
    if (hasSel) hasSel.value = state.hasNote ? "note" : state.hasTranscript ? "transcript" : state.hasAi ? "ai" : "";
    if (els.hashtagChip) {
      if (state.hashtagFilter) {
        els.hashtagChip.hidden = false;
        els.hashtagChip.textContent = `#${state.hashtagFilter} ✕`;
        els.hashtagChip.title = `Clear hashtag filter`;
      } else {
        els.hashtagChip.hidden = true;
      }
    }
    if (els.keywordChip) {
      if (state.keywordFilter) {
        els.keywordChip.hidden = false;
        els.keywordChip.textContent = `“${state.keywordFilter}” ✕`;
        els.keywordChip.title = `Clear keyword filter`;
      } else {
        els.keywordChip.hidden = true;
      }
    }
    if (els.nicheChip) {
      if (state.nicheFilter) {
        els.nicheChip.hidden = false;
        els.nicheChip.textContent = `niche: ${state.nicheFilter} ✕`;
        els.nicheChip.title = `Clear niche filter`;
      } else {
        els.nicheChip.hidden = true;
      }
    }
    if (els.formatChip) {
      if (state.formatFilter) {
        els.formatChip.hidden = false;
        els.formatChip.textContent = `format: ${state.formatFilter} ✕`;
        els.formatChip.title = `Clear format filter`;
      } else {
        els.formatChip.hidden = true;
      }
    }
  };

  // -------- Stats sidebar (high-leverage aggregations) --------
  // Operates on the full enriched scope list (no `limit` slice) so the
  // numbers reflect the whole dataset the user has loaded, not just the
  // currently-displayed rows.
  const HASHTAG_RE = /#([\w_]+)/g;

  // Mirror of src/lib/stats.js makeScoreOf — falls back to vph-relative
  // ratio when _score is 0 (Explore). Keeps stats meaningful on Explore
  // ("≥2× outlier" ≡ "≥2× the median pace").
  const makeScoreOf = (list) => {
    const vphMed = median((list || []).map((p) => p.vph || 0).filter((x) => x > 0));
    return (p) => {
      const s = Number(p && p._score) || 0;
      if (s > 0) return s;
      const v = Number(p && p.vph) || 0;
      if (vphMed > 0 && v > 0) return v / vphMed;
      return 0;
    };
  };

  // Curated stopword list (mirrors src/lib/stats.js STOPWORDS).
  const STOPWORDS = new Set([
    "the","a","an","of","to","in","on","at","for","with","by","from","as","is",
    "are","was","were","be","been","being","am","do","does","did","done","doing",
    "have","has","had","having","will","would","could","should","may","might",
    "must","can","cant","cannot","wont","dont","didnt","im","ive","its","you",
    "your","youre","youll","youve","they","them","their","theirs","theyre","we",
    "our","ours","us","he","she","him","her","his","hers","this","that","these",
    "those","there","here","what","which","who","whom","whose","when","where",
    "why","how","not","no","nor","but","or","if","then","than","so","just",
    "very","too","really","because","while","about","into","over","under",
    "after","before","again","more","most","much","such","own","same","other",
    "some","any","all","each","every","both","few","many","only","also","ever",
    "still","now","never","always","sometimes",
    "and","yet","up","down","out","off","through","between","among",
    "via","upon","onto","across","around","without","within","along",
    "though","although","unless","until","since","whether",
    "follow","followers","following","like","likes","liked","share","shared",
    "comment","comments","subscribe","subscribed","subscriber","subscribers",
    "link","bio","tag","tagged","mention","reels","reel","post","posted",
    "video","videos","content","check","watch","tap","click","swipe","save",
    "saved","new","todays","today","yesterday","tomorrow","day","week","month",
    "year","time","life","make","made","get","got","getting","gets","go","going",
    "went","let","lets","want","wanted","need","needed","know","known","see",
    "seen","said","say","says","one","two","three","first","last","next","best",
    "good","great","nice","amazing","awesome","love","loved","loves","hate",
    "thing","things","stuff","way","ways","lot","lots","little","big","small",
    "okay","ok","yeah","yes","yep","nope",
  ]);
  const URL_RE = /https?:\/\/\S+/g;
  const TAG_AT_RE = /[#@][\w_]+/g;
  const WORD_RE = /\p{L}[\p{L}\p{M}']{2,}/gu;
  const captionWords = (text) => {
    const cleaned = String(text || "")
      .replace(URL_RE, " ")
      .replace(TAG_AT_RE, " ")
      .toLowerCase();
    const out = [];
    for (const m of cleaned.matchAll(WORD_RE)) {
      const w = m[0].replace(/'$/, "").replace(/^'/, "");
      if (w.length < 3) continue;
      if (STOPWORDS.has(w)) continue;
      out.push(w);
    }
    return out;
  };
  const computeKeywords = (list, scoreOf) => {
    const counts = new Map();
    const sums = new Map();
    let allSum = 0, allN = 0;
    for (const p of list) {
      const s = scoreOf(p);
      allSum += s; allN++;
      const seen = new Set();
      for (const w of captionWords(p.desc || "")) {
        if (seen.has(w)) continue;
        seen.add(w);
        counts.set(w, (counts.get(w) || 0) + 1);
        sums.set(w, (sums.get(w) || 0) + s);
      }
    }
    const rows = [];
    for (const [w, n] of counts) {
      if (n < 3) continue;
      const meanWith = sums.get(w) / n;
      const remN = allN - n;
      const meanWithout = remN > 0 ? (allSum - sums.get(w)) / remN : 0;
      const lift = meanWithout > 0 ? meanWith / meanWithout : (meanWith > 0 ? Infinity : 0);
      rows.push({ word: w, n, lift, meanWith });
    }
    // Frequency-first for keywords ("commonly used words" — user's literal
    // ask). Lift is a tie-breaker.
    rows.sort((a, b) => b.n - a.n || (b.lift || 0) - (a.lift || 0));
    return rows.slice(0, 15);
  };

  const statsScope = () => {
    // Mirror filtered()'s scope/surface/range/audio filters but skip the
    // `limit` slice and the search/chip/hashtag filters (so the stats
    // describe the unfiltered scope).
    let list = [...posts.values()];
    if (state.scope === "session") list = list.filter((p) => sessionIds.has(p.id));
    if (state.surface !== "all") list = list.filter((p) => matchesSurface(p, state.surface));
    list = applyRangeFilter(list);
    const nowMs = Date.now();
    list = list.map((p) => {
      const d = computeDerived(p, nowMs);
      const cpr = (p.comments || 0) / Math.max(p.likes || 0, 1) * 1000;
      const vph = vphSincePosted(p, nowMs);
      return { ...p, ...d, velocity: d.velocityViewsPerHr, cpr, vph };
    });
    if (pageScope.kind === "explore") {
      list = list.map((p) => ({ ...p, _score: 0, _scoreBasis: "none" }));
    } else {
      list = computeOutliers(list, state.metric);
    }
    return list;
  };

  const formatOf = (p) => {
    if (p.isReel || p.mediaType === 2) return "reel";
    if (p.mediaType === 8 || (p.carouselCount || 0) > 1) return "carousel";
    return "single";
  };

  const computeStats = (list) => {
    // Effective score: real outlier on profile, vph-relative on Explore.
    // Plumbed through every aggregation that previously read _score so
    // hashtag lift / format outlier% / hist / cadence stop collapsing to
    // 0 when scoring is disabled.
    const scoreOf = makeScoreOf(list);
    const formats = { reel: [], carousel: [], single: [] };
    for (const p of list) formats[formatOf(p)].push(p);
    const formatRows = ["reel", "carousel", "single"].map((f) => {
      const items = formats[f];
      const views = items.map((p) => p.views || 0).filter((x) => x > 0);
      const med = median(views);
      const outliers = items.filter((p) => scoreOf(p) >= 2).length;
      const pct = items.length ? (outliers / items.length) * 100 : 0;
      return { format: f, n: items.length, medianViews: med, outlierPct: pct };
    });

    // Hashtag lift
    const tagCounts = new Map();
    const tagScoreSum = new Map();
    let allScoreSum = 0, allN = 0;
    for (const p of list) {
      const s = scoreOf(p);
      allScoreSum += s; allN++;
      const desc = p.desc || "";
      const seen = new Set();
      let m;
      HASHTAG_RE.lastIndex = 0;
      while ((m = HASHTAG_RE.exec(desc)) !== null) {
        const t = m[1].toLowerCase();
        if (seen.has(t)) continue;
        seen.add(t);
        tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
        tagScoreSum.set(t, (tagScoreSum.get(t) || 0) + s);
      }
    }
    const allMean = allN ? allScoreSum / allN : 0;
    const tagRows = [];
    for (const [t, n] of tagCounts) {
      if (n < 3) continue;
      const meanWith = tagScoreSum.get(t) / n;
      const remN = allN - n;
      const meanWithout = remN > 0 ? (allScoreSum - tagScoreSum.get(t)) / remN : 0;
      const lift = meanWithout > 0 ? meanWith / meanWithout : (meanWith > 0 ? Infinity : 0);
      tagRows.push({ tag: t, n, lift, meanWith });
    }
    tagRows.sort((a, b) => b.lift - a.lift);
    const topTags = tagRows.slice(0, 15);

    // Caption length distribution (log buckets, 20 bars)
    const lens = list.map((p) => (p.desc || "").length).filter((x) => x > 0);
    const maxLen = lens.length ? Math.max(...lens) : 1;
    const minExp = 0; // log10(1)
    const maxExp = Math.max(1, Math.log10(maxLen + 1));
    const NB = 20;
    const histOut = new Array(NB).fill(0);
    const histNon = new Array(NB).fill(0);
    for (const p of list) {
      const len = (p.desc || "").length;
      if (len <= 0) continue;
      const exp = Math.log10(len);
      let b = Math.floor(((exp - minExp) / (maxExp - minExp || 1)) * NB);
      if (b < 0) b = 0;
      if (b >= NB) b = NB - 1;
      if (scoreOf(p) >= 2) histOut[b]++;
      else histNon[b]++;
    }

    // CPR median
    const cprs = list.map((p) => p.cpr || 0).filter((x) => x > 0);
    const cprMed = median(cprs);

    // Posting cadence: 7 days x 24 hours, mean _score weighted by post count.
    // Cell value = mean _score in that cell. Display intensity scaled by count.
    const cell = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ n: 0, sum: 0 })));
    for (const p of list) {
      if (!p.createTime) continue;
      const d = new Date(p.createTime * 1000);
      const dow = d.getDay();
      const hr = d.getHours();
      cell[dow][hr].n++;
      cell[dow][hr].sum += scoreOf(p);
    }

    const keywords = computeKeywords(list, scoreOf);
    const authors = new Set(list.map((p) => p.author).filter(Boolean));
    return {
      total: list.length,
      authors: authors.size,
      formats: formatRows,
      hashtags: topTags,
      keywords,
      hist: { out: histOut, non: histNon, nb: NB, maxLen },
      cpr: { median: cprMed, mean: cprs.length ? cprs.reduce((a, b) => a + b, 0) / cprs.length : 0, n: cprs.length },
      cadence: cell,
      allMean,
    };
  };

  const statsHistSVG = (h) => {
    const W = 280, H = 60, B = h.nb;
    const bw = W / B;
    const max = Math.max(1, ...h.out, ...h.non);
    let bars = "";
    for (let i = 0; i < B; i++) {
      const xn = i * bw + 0.5;
      const hn = (h.non[i] / max) * H;
      const ho = (h.out[i] / max) * H;
      bars += `<rect x="${xn.toFixed(1)}" y="${(H - hn).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${hn.toFixed(1)}" fill="#3a3b48"/>`;
      bars += `<rect x="${xn.toFixed(1)}" y="${(H - ho).toFixed(1)}" width="${(bw - 1).toFixed(1)}" height="${ho.toFixed(1)}" fill="#6e8eff"/>`;
    }
    return `<svg class="fs-stats-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg>`;
  };

  const statsHeatmapSVG = (cell) => {
    const cw = 11, ch = 13, padX = 22, padY = 12;
    const W = padX + 24 * cw, H = padY + 7 * ch;
    let max = 0;
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
      const c = cell[d][h];
      if (c.n) {
        const w = (c.sum / c.n) * Math.log2(c.n + 1);
        if (w > max) max = w;
      }
    }
    const dows = ["S","M","T","W","T","F","S"];
    let svg = "";
    for (let d = 0; d < 7; d++) {
      svg += `<text x="0" y="${padY + d * ch + ch - 3}" font-size="9" fill="#8a8b96">${dows[d]}</text>`;
      for (let h = 0; h < 24; h++) {
        const c = cell[d][h];
        let alpha = 0;
        if (c.n && max > 0) {
          const w = (c.sum / c.n) * Math.log2(c.n + 1);
          alpha = Math.min(1, w / max);
        }
        const x = padX + h * cw, y = padY + d * ch;
        const fill = c.n ? `rgba(110,142,255,${(0.15 + 0.85 * alpha).toFixed(2)})` : "#1a1b27";
        const tip = c.n ? `${c.n} posts · mean ${(c.sum / c.n).toFixed(2)}x · ${dows[d]} ${h}h` : "";
        svg += `<rect x="${x}" y="${y}" width="${cw - 1}" height="${ch - 1}" fill="${fill}" rx="1.5"><title>${tip}</title></rect>`;
      }
    }
    for (let h = 0; h < 24; h += 6) {
      svg += `<text x="${padX + h * cw}" y="9" font-size="9" fill="#8a8b96">${h}h</text>`;
    }
    return `<svg class="fs-stats-heatmap" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${svg}</svg>`;
  };

  // Renders the Hook × Topic cluster table inline inside the Stats panel.
  // Reuses computePatterns() (defined later) so the block stays in sync
  // with the dropped Patterns tab.
  const patternsBlockHTML = (list) => {
    const rows = computePatterns(list);
    if (!rows.length) {
      return `<div class="fs-stats-empty">No analyzed posts in this scope yet — use 🧠 on rows or “Analyze top N” below.</div>`;
    }
    const total = list.filter((p) => p.ai && p.ai.hook).length;
    const head = `<div class="fs-patterns-head">${total} analyzed post${total === 1 ? "" : "s"} · ${rows.length} cluster${rows.length === 1 ? "" : "s"}</div>`;
    const body = rows.map((r) => `
      <button class="fs-pattern-row" data-act="pattern-pick" data-hooktype="${escHTML(r.hookType)}" data-topic="${escHTML(r.topic)}" title="Filter list to this cluster">
        <span class="fs-pattern-cell fs-pattern-hook">${escHTML(r.hookType)}</span>
        <span class="fs-pattern-cell fs-pattern-topic">${escHTML(r.topic)}</span>
        <span class="fs-pattern-cell fs-pattern-n">${r.n}×</span>
        <span class="fs-pattern-cell fs-pattern-score">${r.medianOutlier.toFixed(2)}× med</span>
        <span class="fs-pattern-cell fs-pattern-angle">${r.topAngle ? escHTML(r.topAngle) : ""}</span>
      </button>`).join("");
    return head + `<div class="fs-patterns-rows">${body}</div>`;
  };

  const renderStats = () => {
    if (!els.statsBody || !els.statsSection) return;
    const list = statsScope();
    if (!els.statsSection.open) {
      // Cheap subline update: respect the same surface/range filters as
      // the open view so the count actually changes when filters change.
      if (els.statsSub) {
        els.statsSub.textContent = `${list.length} post${list.length === 1 ? "" : "s"} in scope`;
      }
      return;
    }
    if (!list.length) {
      els.statsBody.innerHTML = `<div class="fs-stats-empty">No posts in scope yet — collect to populate.</div>`;
      if (els.statsSub) els.statsSub.textContent = `0 posts`;
      return;
    }
    const s = computeStats(list);
    if (els.statsSub) {
      els.statsSub.textContent = `${s.total} posts · ${s.authors} author${s.authors === 1 ? "" : "s"} · CPR med ${s.cpr.median.toFixed(1)}`;
    }
    const fmtPct = (x) => x.toFixed(0) + "%";
    const fmtLift = (x) => isFinite(x) ? x.toFixed(2) + "×" : "∞";
    const formatTable = `
      <table class="fs-stats-table">
        <thead><tr><th>Format</th><th>n</th><th>Median views</th><th>≥ 2× outlier</th></tr></thead>
        <tbody>
          ${s.formats.map((r) => `<tr>
            <td>${r.format}</td>
            <td>${r.n}</td>
            <td>${r.medianViews ? fmt(Math.round(r.medianViews)) : "—"}</td>
            <td>${r.n ? fmtPct(r.outlierPct) : "—"}</td>
          </tr>`).join("")}
        </tbody>
      </table>`;
    const tagList = s.hashtags.length ? `
      <div class="fs-stats-tags">
        ${s.hashtags.map((t) => `<button class="fs-stats-tag${state.hashtagFilter === t.tag ? " fs-stats-tag-active" : ""}" data-act="stats-tag" data-tag="${escHTML(t.tag)}" title="${t.n} posts · mean score ${t.meanWith.toFixed(2)}x">#${escHTML(t.tag)} <span class="fs-stats-tag-lift">${fmtLift(t.lift)}</span></button>`).join("")}
      </div>` : `<div class="fs-stats-empty">No hashtags reach the n≥3 threshold.</div>`;
    const kwList = (s.keywords && s.keywords.length) ? `
      <div class="fs-stats-tags">
        ${s.keywords.map((k) => `<button class="fs-stats-tag${state.keywordFilter === k.word ? " fs-stats-tag-active" : ""}" data-act="stats-keyword" data-keyword="${escHTML(k.word)}" title="${k.n} posts mention this word · mean score ${k.meanWith.toFixed(2)}x">${escHTML(k.word)} <span class="fs-stats-tag-lift">${k.n}</span></button>`).join("")}
      </div>` : `<div class="fs-stats-empty">No caption keywords reach the n≥3 threshold.</div>`;

    // ---- Niches: count + average score per unique p.niche label ----
    const nicheAgg = new Map();
    for (const p of list) {
      const n = (typeof p.niche === "string" && p.niche) ? p.niche : null;
      if (!n) continue;
      const cur = nicheAgg.get(n) || { n: 0, sum: 0 };
      cur.n += 1;
      cur.sum += Number(p._score) || 0;
      nicheAgg.set(n, cur);
    }
    const nicheRows = [...nicheAgg.entries()]
      .map(([niche, v]) => ({ niche, n: v.n, mean: v.n ? v.sum / v.n : 0 }))
      .sort((a, b) => b.n - a.n || b.mean - a.mean);
    const nicheList = nicheRows.length ? `
      <div class="fs-stats-tags">
        ${nicheRows.map((r) => `<button class="fs-stats-niche-chip${state.nicheFilter === r.niche ? " fs-stats-tag-active" : ""}" data-act="stats-niche" data-niche="${escHTML(r.niche)}" title="${r.n} posts · mean score ${r.mean.toFixed(2)}x">${escHTML(r.niche)} <span class="fs-stats-tag-lift">${r.n} · ${r.mean.toFixed(2)}×</span></button>`).join("")}
      </div>` : `<div class="fs-stats-empty">No niche labels yet — cluster creators on the Niche tab.</div>`;
    const nicheClusterBusy = !!state.nicheClusterBusy;
    const nicheClusterStatus = state.nicheClusterStatus || "";
    const nicheActions = `
      <div class="fs-stats-actions">
        <button class="fs-icon-btn" data-act="stats-cluster-niches" title="Embed every post in scope, cluster by caption/transcript, then label each cluster with one Gemma call" ${nicheClusterBusy ? "disabled" : ""}>${nicheClusterBusy ? "⏳ Clustering…" : "🪄 Cluster niches"}</button>
        <span class="fs-stats-hint" data-niche-cluster-label-status>${escHTML(nicheClusterStatus)}</span>
      </div>`;

    // ---- Formats: prefer visualFormat (cover-AI rollup: talking-head /
    // info-card / split-screen / product / b-roll) over the legacy
    // caption-rule `format` (list/story/tutorial/hottake/...) which collapses
    // talking-head reels to "other" because no caption rule matches them.
    // Falls back to caption format when cover-AI hasn't run yet.
    const fmtAgg = new Map();
    let fmtTotal = 0;
    let fmtVisualCount = 0;
    let fmtCaptionOnlyCount = 0;
    for (const p of list) {
      const vf = (typeof p.visualFormat === "string" && p.visualFormat) ? p.visualFormat : null;
      const cf = (typeof p.format === "string" && p.format) ? p.format : null;
      const f = vf || cf;
      if (!f) continue;
      if (vf) fmtVisualCount++; else fmtCaptionOnlyCount++;
      fmtAgg.set(f, (fmtAgg.get(f) || 0) + 1);
      fmtTotal += 1;
    }
    const formatRows2 = [...fmtAgg.entries()]
      .map(([format, n]) => ({ format, n }))
      .sort((a, b) => b.n - a.n);
    const formatChips = formatRows2.length ? `
      <div class="fs-stats-tags">
        ${formatRows2.map((r) => `<button class="fs-stats-format-chip${state.formatFilter === r.format ? " fs-stats-tag-active" : ""}" data-act="stats-format" data-format="${escHTML(r.format)}" title="${r.n} posts classified as ${r.format}">${escHTML(r.format)} <span class="fs-stats-tag-lift">${r.n}</span></button>`).join("")}
      </div>` : `<div class="fs-stats-empty">No format labels yet — click “Detect visual format” below.</div>`;
    const cvBusy = !!(state.cvBatch && state.cvBatch.running);
    const cvProgress = cvBusy && state.cvBatch.total
      ? ` (${state.cvBatch.done}/${state.cvBatch.total})`
      : "";
    const formatActions = `
      <div class="fs-stats-actions">
        <button class="fs-icon-btn" data-act="stats-detect-visual-format" title="Run cover-AI on the top ${Math.min(list.length, 20)} posts — produces talking-head/info-card/split-screen/product/b-roll/other labels" ${cvBusy ? "disabled" : ""}>${cvBusy ? `⏳ Analyzing…${cvProgress}` : "👁️ Detect visual format"}</button>
        <button class="fs-icon-btn" data-act="stats-detect-formats" title="Rule-based caption format detection (list / story / tutorial / before-after / …). Fast, no LLM. Talking-head reels usually fall to 'other' — use Detect visual format above for those.">⚡ Caption fallback</button>
        <span class="fs-stats-hint">${fmtTotal} of ${list.length} classified${fmtVisualCount ? ` • ${fmtVisualCount} visual` : ""}${fmtCaptionOnlyCount ? ` • ${fmtCaptionOnlyCount} caption-only` : ""}</span>
      </div>`;
    const histLegend = `
      <div class="fs-stats-legend">
        <span><span class="fs-stats-sw fs-stats-sw-out"></span>outliers ≥2×</span>
        <span><span class="fs-stats-sw fs-stats-sw-non"></span>others</span>
        <span class="fs-stats-axis">caption length, log buckets → ${s.hist.maxLen} chars</span>
      </div>`;
    const cprLine = `<div class="fs-stats-line">Median CPR <b>${s.cpr.median.toFixed(1)}</b> · mean <b>${s.cpr.mean.toFixed(1)}</b> · from ${s.cpr.n} posts with likes</div>`;

    els.statsBody.innerHTML = `
      <div class="fs-stats-block">
        <div class="fs-stats-h">Format win-rate</div>
        ${formatTable}
      </div>
      <div class="fs-stats-block">
        <div class="fs-stats-h">Hashtag lift <span class="fs-stats-hint">click to filter</span></div>
        ${tagList}
      </div>
      <div class="fs-stats-block">
        <div class="fs-stats-h">Caption keywords <span class="fs-stats-hint">click to filter by niche term</span></div>
        ${kwList}
      </div>
      ${pageScope.kind === "profile" ? "" : `<div class="fs-stats-block">
        <div class="fs-stats-h">Niches <span class="fs-stats-hint">click to filter</span></div>
        ${nicheList}
        ${nicheActions}
      </div>`}
      <div class="fs-stats-block">
        <div class="fs-stats-h">Formats <span class="fs-stats-hint">click to filter</span></div>
        ${formatChips}
        ${formatActions}
      </div>
      <div class="fs-stats-block">
        <div class="fs-stats-h">Caption length · outliers vs others</div>
        ${statsHistSVG(s.hist)}
        ${histLegend}
      </div>
      <div class="fs-stats-block">
        <div class="fs-stats-h">Engagement quality (CPR)</div>
        ${cprLine}
      </div>
      <div class="fs-stats-block">
        <div class="fs-stats-h">Posting cadence · mean outlier score</div>
        ${statsHeatmapSVG(s.cadence)}
      </div>
    `;
  };


  let renderQueued = false;
  const render = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      buildUI();
      // Tier gate: on Explore/FYP + free, swap the scroll-list + stats panel
      // for an upgrade card. Capture keeps running in the background
      // (harvest() is wired into the network interceptor, not into render).
      const lockExplore = pageScope.kind === "explore" && !proAccess();
      if (els.root) els.root.classList.toggle("fs-locked-explore", lockExplore);
      if (lockExplore) {
        els.count.textContent = "— posts";
        els.authors.textContent = "— authors";
        updateBulkTxButton();
        renderBulkTxStatus();
        els.list.innerHTML = `
          <div class="fs-upgrade-card" role="region" aria-label="Pro feature">
            <div class="fs-upgrade-card-icon">\uD83D\uDD12</div>
            <div class="fs-upgrade-card-title">Explore-page research is a Pro feature.</div>
            <p class="fs-upgrade-card-body">Free covers your own profile. Upgrade to research Explore, For You, and Search across creators.</p>
            <button class="fs-icon-btn fs-upgrade-cta" data-act="upgrade" data-src="explore-card">Upgrade</button>
          </div>`;
        logInfo("tier.explore.lock", { scope: pageScope.kind });
        return;
      }
      const list = filtered();
      const authors = new Set(list.map((p) => p.author).filter(Boolean)).size;
      els.count.textContent = `${list.length} posts`;
      els.authors.textContent = `${authors} author${authors === 1 ? "" : "s"}`;
      // Drop selections that are no longer in the visible list source
      // (e.g. scope changed and posts cleared). Keep ones that just
      // happen to be filtered out — user may un-filter to act on them.
      for (const id of state.selected) {
        if (!posts.has(id)) state.selected.delete(id);
      }
      renderBatchBar();
      renderChips();
      renderStats();
      renderPipelineEta();
      updateBulkTxButton();
      renderBulkTxStatus();
      logInfo("filter.applied", {
        limit: state.limit,
        range: state.range,
        surface: state.surface,
        pinnedOnly: state.pinnedOnly,
        statusFilter: state.statusFilter,
        hasNote: state.hasNote,
        listLen: list.length,
        total: posts.size,
      });
      // Re-render Radar if it's open — metric/sort changes affect it.
      if (state.radar) renderRadar();
      const gKey = state.groupBy && state.groupBy !== "none" ? state.groupBy : null;
      const groupOf = (p) => {
        if (!gKey) return "";
        if (gKey === "status") return statusOf(p.id) || "(no status)";
        if (gKey === "hookType" || gKey === "topic" || gKey === "angle") {
          return (p.ai && p.ai[gKey]) || "(unanalyzed)";
        }
        if (gKey === "coverWinRate") {
          // Bucketize by score band so groups stay sane.
          const s = p._score || 0;
          if (s >= 3) return "≥3× outlier";
          if (s >= 2) return "2–3×";
          if (s >= 1) return "1–2× (baseline+)";
          return "<1×";
        }
        return "";
      };
      // Slice (limit) is already applied above; group headers come second
      // so a high-N group can’t crowd out a low-N group below the cap.
      let html;
      if (gKey) {
        const out = [];
        let prev = null;
        list.forEach((p, i) => {
          const g = groupOf(p);
          if (g !== prev) {
            out.push(`<div class="fs-group-h">${escHTML(g)}</div>`);
            prev = g;
          }
          out.push(rowHTML(p, i));
        });
        html = out.join("");
      } else {
        html = list.map((p, i) => rowHTML(p, i)).join("");
      }
      els.list.innerHTML =
        html ||
        `<div style="padding:16px;color:#6a6b78;font-size:12px;text-align:center">
          ${pageScope.kind === "other"
            ? "Navigate to a profile, Explore, Search, or Shorts feed to capture posts."
            : "Scroll to capture posts, or click Collect all."}
        </div>`;
    });
  };

  const exportCSV = (opts = {}) => {
    const selectedOnly = !!opts.selectedOnly;
    let rows;
    if (selectedOnly) {
      // Use the visible/filtered ordering as the canonical row order so the
      // CSV row indexes match what the user sees, but keep only selected.
      const sel = state.selected;
      rows = filtered().filter((p) => sel.has(p.id));
      // Include selections that were filtered out (e.g. user changed limit
      // after selecting). Append them at the end with score=0.
      const seen = new Set(rows.map((p) => p.id));
      for (const id of sel) {
        if (seen.has(id)) continue;
        const p = posts.get(id);
        if (p) rows.push({ ...p, _score: 0 });
      }
    } else {
      rows = filtered();
    }
    const header = [
      "rank","author","id","shortcode","surface","productType","createTime",
      "likes","views","comments","outlier",
      "firstSeenViews","velocityPerHr","snapshotCount",
      "desc","url",
      "carouselCount","accessibilityCaption",
      "audioId","audioTitle","audioArtist","audioOriginalAuthor","audioIsOriginal","audioUseCount","audioClusterId",
      "usertags","coauthors",
      "locationId","locationName","locationLat","locationLng",
      "pinned","status","note","tags",
      "aiHook","aiHookType","aiTopic","aiAngle","aiModel","aiAnalyzedAt",
    ];
    const esc = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const lines = [header.join(",")];
    const nowMs = Date.now();
    rows.forEach((p, i) => {
      const au = p.audio || {};
      const lo = p.location || {};
      const me = getMetaSync(p.id) || {};
      // `rows` may be from filtered() (already enriched) or pulled raw from
      // `posts` (selectedOnly fallback path). Re-derive defensively.
      const d = (p.velocityViewsPerHr === undefined) ? computeDerived(p, nowMs) : p;
      lines.push([
        i + 1, p.author, p.id, p.shortcode, p.surface, p.productType || "",
        p.createTime ? new Date(p.createTime * 1000).toISOString() : "",
        p.likes, p.views, p.comments,
        (p._score || 0).toFixed(3),
        d.firstSeenViews || 0,
        (d.velocityViewsPerHr || 0).toFixed(2),
        d.snapshotCount || 0,
        esc(p.desc), p.url,
        p.carouselCount || 0, esc(p.accessibilityCaption || ""),
        au.id || "", esc(au.title || ""), esc(au.artist || ""), esc(au.originalAuthor || ""),
        au.isOriginal ? "true" : "false", au.useCount || 0,
        p.audioClusterId || "",
        esc((p.usertags || []).join("|")),
        esc((p.coauthors || []).join("|")),
        lo.id || "", esc(lo.name || ""), lo.lat || "", lo.lng || "",
        me.pinned ? "true" : "false",
        esc(me.status || ""),
        esc(me.note || ""),
        esc((me.tags || []).join("|")),
        esc((p.ai && p.ai.hook) || ""),
        (p.ai && p.ai.hookType) || "",
        esc((p.ai && p.ai.topic) || ""),
        esc((p.ai && p.ai.angle) || ""),
        (p.ai && p.ai.model) || "",
        (p.ai && p.ai.analyzedAt) ? new Date(p.ai.analyzedAt).toISOString() : "",
      ].join(","));
    });
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    // ig_{scope}_{surface}_{sort-by-metric}_{rows}_{YYYY-MM-DD_HHMM}.csv
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    const scopePart = pageScope.kind === "profile" && pageScope.username
      ? pageScope.username
      : pageScope.kind === "explore"
        ? "explore"
        : "page";
    const sortPart = state.sort === "outlier"
      ? `outlier-${state.metric}`
      : state.sort;
    const surfacePart = state.surface === "all" ? "" : `_${state.surface}`;
    const rangePart = state.range === "all" ? "" : `_${state.range}`;
    const countPart = selectedOnly ? `_selected${rows.length}_` : `_${rows.length}_`;
    a.download = `${PLATFORM_CSV_PREFIX}_${scopePart}${surfacePart}_${sortPart}${rangePart}${countPart}${stamp}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  // -------- IDB rehydrate --------
  // Re-populate the in-memory Map from IndexedDB for the current page scope
  // (or all-time when state.scope === "alltime"). Runs on boot, on scope
  // change, on data-toggle change, and after a non-purging refresh.
  // Load all meta rows into the in-memory cache. Cheap (small table) and
  // shared across scopes — we never clear this.
  const loadAllMeta = async () => {
    if (!window.__fsStore) return;
    try {
      const rows = await window.__fsStore.getAllMeta();
      for (const m of rows || []) {
        if (m && m.id) metaCache.set(String(m.id), m);
      }
      logDebug("meta.load", { rows: rows?.length || 0 });
    } catch (e) {
      logWarn("meta.load.fail", e);
    }
  };

  // Load pinned posts (cross-scope). Survives navigation between profiles.
  const loadPinnedPosts = async () => {
    if (!window.__fsStore) return;
    try {
      const rows = await window.__fsStore.getPinnedPosts();
      pinnedPosts.clear();
      for (const p of rows || []) {
        if (p && p.id) pinnedPosts.set(p.id, p);
      }
      logDebug("pinned.load", { rows: rows?.length || 0 });
    } catch (e) {
      logWarn("pinned.load.fail", e);
    }
  };

  const rehydrateFromStore = async () => {
    if (!window.__fsStore) return;
    let rows;
    try {
      if (state.scope === "alltime") {
        rows = await window.__fsStore.getAll();
      } else {
        rows = await window.__fsStore.getByScope(pageScope);
      }
    } catch (e) {
      logError("store.read.fail", e);
      return;
    }
    let kept = 0;
    for (const p of rows || []) {
      if (!p || !p.id) continue;
      // Apply the same scope filter we apply to live ingests so the view
      // stays consistent across reloads.
      if (pageScope.kind === "profile" && pageScope.username && p.author &&
          p.author.toLowerCase() !== pageScope.username && state.scope !== "alltime") {
        continue;
      }
      if (state.scope !== "alltime" && !isCurrentDetailVideo(p)) continue;
      // Don't blow away records we already merged in this session.
      if (!posts.has(p.id)) {
        const normalized = isYouTubePost(p) ? { ...p, platform: "youtube", surface: "shorts-feed" } : p;
        posts.set(p.id, normalized);
        kept++;
      }
    }
    logInfo("store.rehydrate", {
      scope: pageScope,
      mode: state.scope,
      rows: rows?.length || 0,
      kept,
      total: posts.size,
    });
    render();
  };
  window.__feedSorter.rehydrate = rehydrateFromStore;

  // -------- view switching --------
  const updateView = () => {
    if (!els.root) return;
    els.root.dataset.view = state.view;
    els.root.classList.toggle("fs-radar-on", !!state.radar);
    if (els.tabs) {
      els.tabs.querySelectorAll("[data-tab]").forEach((b) => {
        b.classList.toggle("fs-tab-active", b.dataset.tab === state.view);
      });
    }
    if (els.nichePanel) els.nichePanel.hidden = state.view !== "niche";
    if (els.settingsPanel) els.settingsPanel.hidden = state.view !== "settings";
    if (els.soundsPanel) els.soundsPanel.hidden = state.view !== "sounds";
    if (els.signalsPanel) els.signalsPanel.hidden = !state.signalsOpen;
    if (els.signalsBtn) {
      // Bell visible only when there are stored signals OR notify is on.
      const hasAny = signalsCache.size > 0 || !!state.signalsNotify;
      els.signalsBtn.hidden = !hasAny;
      els.signalsBtn.classList.toggle("fs-signals-bell-on", !!state.signalsOpen);
    }
    if (els.radar) els.radar.hidden = !state.radar;
    if (els.radarBtn) els.radarBtn.classList.toggle("fs-radar-btn-on", !!state.radar);
    if (state.view === "niche") renderNiche();
    else if (state.view === "settings") renderSettings();
    else if (state.view === "sounds") renderSounds();
    if (state.radar) renderRadar();
    updatePinBtn();
  };

  const toggleRadar = () => {
    state.radar = !state.radar;
    logInfo("radar.toggle", { on: state.radar });
    updateView();
  };

  // -------- creators (watchlist) --------
  const trackedSet = () => new Set(creators.map((c) => c.username));

  const reloadCreators = async () => {
    if (!window.__fsStore) return;
    try {
      creators = (await window.__fsStore.getAllCreators()) || [];
      logDebug("creators.load", { n: creators.length });
    } catch (e) {
      logWarn("creators.load.fail", e);
      creators = [];
    }
    if (state.view === "niche") renderNiche();
    if (els.nicheAddCurrent) {
      els.nicheAddCurrent.disabled = !(pageScope.kind === "profile" && pageScope.username);
    }
    updatePinBtn();
  };

  const upsertCreator = async (username, patch = {}) => {
    if (!window.__fsStore) return;
    const u = String(username || "").trim().toLowerCase().replace(/^@/, "");
    if (!u) return;
    try {
      await window.__fsStore.addCreator(u, patch);
      logInfo("creator.upsert", { username: u, patch });
      await reloadCreators();
    } catch (e) {
      logWarn("creator.upsert.fail", e, { username: u });
    }
  };
  const updateCreator = (username, patch) => upsertCreator(username, patch);

  const removeCreator = async (username) => {
    if (!window.__fsStore) return;
    try {
      await window.__fsStore.removeCreator(username);
      logInfo("creator.remove", { username });
      await reloadCreators();
    } catch (e) {
      logWarn("creator.remove.fail", e, { username });
    }
  };

  const addCurrentCreator = () => {
    if (pageScope.kind !== "profile" || !pageScope.username) {
      setStatus("not on a profile page");
      return;
    }
    upsertCreator(pageScope.username);
  };

  const addManualCreator = () => {
    const u = (els.nicheUsername?.value || "").trim();
    const niche = (els.nicheNiche?.value || "").trim();
    if (!u) return;
    upsertCreator(u, niche ? { niche } : {});
    if (els.nicheUsername) els.nicheUsername.value = "";
    if (els.nicheNiche) els.nicheNiche.value = "";
  };

  const rescrapeStale = () => {
    try {
      chrome.runtime.sendMessage({ type: "fs-bg", cmd: "rescrape-stale" }, (resp) => {
        logInfo("rescrape.stale.ack", { resp });
        setStatus(`re-scan queued (${resp?.queued ?? "?"})`);
      });
    } catch (e) {
      logWarn("rescrape.stale.fail", e);
    }
  };
  const rescrapeOne = (username) => {
    try {
      chrome.runtime.sendMessage({ type: "fs-bg", cmd: "rescrape-now", username }, (resp) => {
        logInfo("rescrape.one.ack", { username, resp });
        setStatus(`re-scan @${username} queued`);
      });
    } catch (e) {
      logWarn("rescrape.one.fail", e, { username });
    }
  };

  // Mirror of src/analysis/post-analysis.js detectFormat() — keep in sync.
  // Pure rule-based (no LLM); first match wins.
  const FORMATS = ["list", "story", "tip", "tutorial", "hottake", "reaction", "dayinlife", "beforeafter", "other"];
  const detectFormat = (p) => {
    const desc = String((p && p.desc) || "");
    const lower = desc.toLowerCase();
    const trimmed = desc.trim();
    const lowerTrimmed = trimmed.toLowerCase();
    const segs = Array.isArray(p && p.transcriptSegments) ? p.transcriptSegments : null;
    const transcript = (segs && segs.length
      ? segs.map((s) => String((s && s.text) || "")).join(" ")
      : String((p && p.transcript) || "")).toLowerCase();
    if (/^\d+[.\s]/.test(trimmed)) return "list";
    const lines = desc.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.filter((l) => /^([-•]|\d+\.)\s*\S/.test(l)).length >= 3) return "list";
    if (/\bstep\s*1\b/.test(lower) || /\bhow to\b/.test(lower) || /\btutorial\b/.test(lower)
      || /\bguide\b/.test(lower) || /\bstep\s*1\b/.test(transcript) || /\bstep\s*one\b/.test(transcript)) return "tutorial";
    if ((/\bbefore\b/.test(lower) && /\bafter\b/.test(lower)) || /\btransformation\b/.test(lower) || /\bresults\b/.test(lower)) return "beforeafter";
    if (/\bday in (my )?life\b/.test(lower) || /\bday in\b/.test(lower) || /\bmorning routine\b/.test(lower) || /\bdaily routine\b/.test(lower)) return "dayinlife";
    if (/\breact(ing)?\b/.test(lower) || /\bmy thoughts on\b/.test(lower) || /\bwatching\b/.test(lower)) return "reaction";
    if (/\bunpopular opinion\b/.test(lower) || /\bhot take\b/.test(lower) || /i['’]ll say it\b/.test(lower) || /\bcontroversial\b/.test(lower)) return "hottake";
    if (/\btip:\s/.test(lower) || /\bpro tip\b/.test(lower) || /\bquick tip\b/.test(lower) || /^if you\s+\S+/.test(lowerTrimmed)) return "tip";
    const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
    const fp = (lower.match(/\b(i|me|my|we)\b/g) || []).length;
    if (fp >= 3 && wordCount >= 30) return "story";
    return "other";
  };

  // Run rule-based detectFormat() on every post in the current Stats scope
  // and persist the labels via setPostFormat. Instant; toast confirms count.
  const runDetectFormats = async () => {
    const scope = statsScope();
    if (!scope.length) { setStatus("no posts in scope"); return; }
    const store = window.__fsStore;
    if (!store || typeof store.setPostFormat !== "function") {
      setStatus("format detect: store unavailable");
      return;
    }
    let n = 0, fail = 0;
    for (const p of scope) {
      try {
        const f = detectFormat(p);
        if (!FORMATS.includes(f)) continue;
        await store.setPostFormat(p.id, f);
        const live = posts.get(p.id);
        if (live) live.format = f;
        n += 1;
      } catch (e) {
        fail += 1;
        logWarn("format.detect.fail", e, { id: p.id });
      }
    }
    logInfo("format.detect.done", { n, fail, scope: scope.length });
    setStatus(`detected formats on ${n} post${n === 1 ? "" : "s"}${fail ? ` · ${fail} failed` : ""}`);
    render();
  };

  // Embed scope posts, cluster by niche, label each cluster with ONE
  // Gemma call (cached by exemplar-postId hash). Writes the label back to
  // every member post via __fsStore.setPostNiche.
  const labelNicheClusters = async () => {
    const ncl = window.__fsNicheCluster;
    if (!ncl) { setStatus("niche-cluster runtime unavailable"); return; }
    if (!window.__fsLlm) { setStatus("LLM bridge unavailable"); return; }
    if (!window.__fsStore) { setStatus("store unavailable"); return; }
    if (state.nicheClusterBusy) return;
    const scope = statsScope();
    if (!scope.length) { setStatus("no posts in scope"); return; }

    state.nicheClusterBusy = true;
    state.nicheClusterStatus = "embedding…";
    renderStats();

    const t0 = Date.now();
    logInfo("niche.cluster.label.start", { scope: scope.length });

    const embedFn = (texts) => new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type: "fs-bg", cmd: "embed-texts", texts }, (resp) => {
          const lerr = chrome.runtime.lastError;
          if (lerr) { reject(new Error(String(lerr.message || lerr))); return; }
          if (!resp || !resp.ok) { reject(new Error(String(resp && resp.err || "embed failed"))); return; }
          resolve(resp.vectors || []);
        });
      } catch (e) { reject(e); }
    });

    // IDB-backed cache for cluster labels (reuses pipeline_steps table; the
    // step name `niche-label` namespaces it from real pipeline rows).
    const store = window.__fsStore;
    const cache = {
      get: async (key) => {
        try {
          const row = await store.getPipelineStep(`cluster::${key}`, "niche-label");
          return row && row.payload ? row.payload.label : null;
        } catch { return null; }
      },
      set: async (key, label) => {
        try { await store.putPipelineStep(`cluster::${key}`, "niche-label", { label, at: Date.now() }); } catch {}
      },
    };

    const getPost = async (id) => posts.get(id) || null;
    const setPostNiche = async (id, label, basis) => {
      try {
        await store.setPostNiche(id, label, basis);
        const live = posts.get(id);
        if (live) { live.niche = label; live.nicheBasis = basis; }
      } catch (e) { logWarn("niche.set.fail", e, { id }); }
    };

    let clusters = [];
    let labeled = [];
    try {
      const result = await ncl.clusterPostsByNiche(scope, { embedFn });
      clusters = result.clusters || [];
      state.nicheClusterStatus = `labeling 0/${clusters.length}…`;
      renderStats();

      labeled = await ncl.labelClusters(clusters, {
        chat: (req) => window.__fsLlm.chat(req),
        getPost,
        cache,
        setPostNiche,
        onProgress: ({ done, total }) => {
          state.nicheClusterStatus = `labeling ${done}/${total}…`;
          if (els.statsBody) {
            const el = els.statsBody.querySelector("[data-niche-cluster-label-status]");
            if (el) el.textContent = state.nicheClusterStatus;
          }
        },
      });
      const cached = labeled.filter((c) => c && c.fromCache).length;
      const fresh = labeled.filter((c) => c && c.label && !c.fromCache).length;
      state.nicheClusterStatus = `${labeled.length} cluster${labeled.length === 1 ? "" : "s"} · ${fresh} new · ${cached} cached`;
      logInfo("niche.cluster.label.end", {
        scope: scope.length,
        clusters: clusters.length,
        labeled: fresh,
        cached,
        deferred: (result.deferred || []).length,
        inherited: (result.inherited || []).length,
        ms: Date.now() - t0,
      });
      setStatus(`niches: ${labeled.length} cluster${labeled.length === 1 ? "" : "s"} labeled`);
    } catch (e) {
      logWarn("niche.cluster.label.fail", e);
      state.nicheClusterStatus = `failed: ${String(e && e.message || e).slice(0, 60)}`;
      setStatus("niche cluster failed");
    } finally {
      state.nicheClusterBusy = false;
      render();
    }
  };

  // Auto-cluster trigger — fires the background pipeline. We poll cluster-meta
  // until lastRunAt advances, then refresh the panel.
  const runClusterNiches = async () => {
    const setBadge = (txt) => {
      const nodes = els.nicheClusterStatus;
      if (!nodes) return;
      // NodeList from querySelectorAll — update every visible badge.
      if (typeof nodes.forEach === "function") nodes.forEach((el) => { el.textContent = txt; });
      else nodes.textContent = txt;
    };
    setBadge("clustering…");
    setStatus("auto-clustering niches…");
    let prevAt = 0;
    try {
      const resp0 = await new Promise((res) => chrome.runtime.sendMessage({ type: "fs-bg", cmd: "cluster-meta" }, res));
      prevAt = resp0?.meta?.lastRunAt || 0;
    } catch {}
    // The SW lives in the extension origin and can't read the page-origin IDB
    // where our posts AND creators live. Read both here and pass through the
    // message payload (same workaround the api.sync-posts handler uses).
    // Creators carry the new bio/category/externalUrl fields that drive the
    // bio-first niche cascade (src/lib/niche-signal.js).
    let postsForCluster = [];
    let creatorsForCluster = [];
    try {
      const store = window.__fsStore;
      if (store && typeof store.getAll === "function") {
        postsForCluster = await store.getAll();
      }
      if (store && typeof store.getAllCreators === "function") {
        creatorsForCluster = await store.getAllCreators();
      }
    } catch (e) { logWarn("cluster.read-store.fail", e); }
    const bioCovered = creatorsForCluster.filter((c) => c && c.bioCapturedAt > 0).length;
    logInfo("cluster.posts-ready", {
      postCount: postsForCluster.length,
      creatorCount: creatorsForCluster.length,
      bioCovered,
      bioCoverage: creatorsForCluster.length ? Math.round(100 * bioCovered / creatorsForCluster.length) + "%" : "0%",
    });
    try {
      chrome.runtime.sendMessage({
        type: "fs-bg",
        cmd: "cluster-niches-now",
        posts: postsForCluster,
        creators: creatorsForCluster,
      }, (resp) => {
        logInfo("cluster.start.ack", { resp });
      });
    } catch (e) {
      logWarn("cluster.start.fail", e);
      setBadge("failed");
      setStatus("cluster failed: see console");
      return;
    }
    // Poll for completion; first model load can take ~30s.
    const t0 = Date.now();
    const POLL_MS = 1500;
    const TIMEOUT_MS = 5 * 60 * 1000;
    const tick = async () => {
      if (Date.now() - t0 > TIMEOUT_MS) { setBadge("timed out"); return; }
      try {
        const r = await new Promise((res) => chrome.runtime.sendMessage({ type: "fs-bg", cmd: "cluster-meta" }, res));
        const meta = r?.meta;
        if (meta && meta.lastRunAt && meta.lastRunAt > prevAt) {
          await reloadCreators();
          const n = meta.clusters?.length || 0;
          setBadge(`${n} niche${n === 1 ? "" : "s"} · ${Math.round(meta.ms || 0)}ms`);
          setStatus(`clustered into ${n} niches`);
          logInfo("cluster.done", meta);
          return;
        }
      } catch (e) { logWarn("cluster.poll.fail", e); }
      setTimeout(tick, POLL_MS);
    };
    setTimeout(tick, POLL_MS);
  };

  const unpinCreatorNiche = async (username) => {
    if (!window.__fsStore) return;
    try {
      await window.__fsStore.updateCreator(username, { nichePinned: false });
      logInfo("niche.unpin", { username });
      await reloadCreators();
    } catch (e) { logWarn("niche.unpin.fail", e); }
  };

  // Drag-to-reassign: drop a creator row onto a niche group header.
  const onCreatorDragStart = (ev) => {
    const row = ev.target.closest("[data-creator-row]");
    if (!row) return;
    ev.dataTransfer.setData("text/x-fs-creator", row.dataset.creatorRow);
    ev.dataTransfer.effectAllowed = "move";
    row.classList.add("fs-dragging");
  };
  const onCreatorDragEnd = (ev) => {
    const row = ev.target.closest("[data-creator-row]");
    if (row) row.classList.remove("fs-dragging");
    document.querySelectorAll(".fs-niche-group-drop").forEach((el) => el.classList.remove("fs-niche-group-drop"));
  };
  const onGroupDragOver = (ev) => {
    if (!ev.dataTransfer.types.includes("text/x-fs-creator")) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    const grp = ev.target.closest("[data-niche-group]");
    if (grp) grp.classList.add("fs-niche-group-drop");
  };
  const onGroupDragLeave = (ev) => {
    const grp = ev.target.closest("[data-niche-group]");
    if (grp) grp.classList.remove("fs-niche-group-drop");
  };
  const onGroupDrop = async (ev) => {
    const grp = ev.target.closest("[data-niche-group]");
    if (!grp) return;
    const u = ev.dataTransfer.getData("text/x-fs-creator");
    if (!u) return;
    ev.preventDefault();
    grp.classList.remove("fs-niche-group-drop");
    const niche = grp.dataset.nicheGroup;
    if (!window.__fsStore) return;
    try {
      await window.__fsStore.updateCreator(u, { niche, _userNiche: true });
      logInfo("niche.reassign", { username: u, niche });
      await reloadCreators();
    } catch (e) { logWarn("niche.reassign.fail", e); }
  };

  const generateCreatorReport = async (username) => {
    const u = String(username || "").trim().toLowerCase().replace(/^@/, "");
    if (!u) return;
    if (!window.__fsReport || !window.__fsReport.generate) {
      logError("report.unavailable", { username: u });
      setStatus("report module not loaded");
      return;
    }
    setStatus(`generating PDF for @${u}…`);
    logInfo("report.start", { username: u });
    try {
      const res = await window.__fsReport.generate(u);
      if (res && res.ok) {
        logInfo("report.ok", res);
        setStatus(`saved ${res.filename} (${res.posts} posts)`);
      } else {
        logWarn("report.fail", res || { error: "unknown" }, { username: u });
        setStatus(`report failed: ${res?.error || "unknown"}`);
      }
    } catch (e) {
      logError("report.exception", e, { username: u });
      setStatus("report failed — see console");
    }
  };

  const fmtAge = (t) => {
    if (!t) return "never";
    const s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  };

  // -------- Niche tab render --------
  // Per-creator stats from the in-memory `posts` Map + pinnedPosts +
  // anything that already lives in IDB. We accept stale numbers — the
  // accurate count is the IDB count which we fetch lazily.
  // Voice fingerprint cache — populated on niche tab render so we can show
  // last-generated date + a stale indicator next to the per-creator button.
  // Stale = older than VOICE_STALE_MS.
  const VOICE_STALE_MS = 30 * 24 * 60 * 60 * 1000;
  let voiceCache = { at: 0, by: new Map() };
  /** @type {Set<string>} usernames whose voice regen is in flight */
  const voiceInflight = new Set();

  const refreshVoiceCache = async (force = false) => {
    if (!window.__fsStore || !window.__fsStore.getAllVoices) return;
    if (!force && Date.now() - voiceCache.at < 5000) return;
    try {
      const all = await window.__fsStore.getAllVoices();
      const by = new Map();
      for (const v of all || []) {
        if (v && v.username) by.set(v.username, v);
      }
      voiceCache = { at: Date.now(), by };
    } catch (e) {
      logWarn("voice.cache.fail", e);
    }
  };

  let creatorStatsCache = { at: 0, by: new Map() };
  const refreshCreatorStats = async () => {
    if (!window.__fsStore) return;
    if (Date.now() - creatorStatsCache.at < 5000) return;
    try {
      const all = await window.__fsStore.getAll();
      const by = new Map();
      for (const p of all || []) {
        if (!p || !p.author) continue;
        const k = p.author.toLowerCase();
        if (!by.has(k)) by.set(k, { count: 0, scores: [] });
        const e = by.get(k);
        e.count++;
      }
      // Compute author-median outlier score (using likes) so we have a
      // "median outlier score" per creator.
      for (const p of all || []) {
        if (!p || !p.author) continue;
        const k = p.author.toLowerCase();
        by.get(k).scores.push(p.likes || 0);
      }
      creatorStatsCache = { at: Date.now(), by };
    } catch (e) {
      logWarn("creator.stats.fail", e);
    }
  };

  const medianScoreFor = (username) => {
    const e = creatorStatsCache.by.get(username);
    if (!e || !e.scores.length) return { count: 0, median: 0 };
    const s = [...e.scores].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    const med = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    return { count: e.count, median: med };
  };

  const renderCreatorRow = (c) => {
    const st = medianScoreFor(c.username);
    const auto = c.autoCollect ? "checked" : "";
    const sel = state.selectedCreators.has(c.username) ? "checked" : "";
    const pin = c.nichePinned
      ? `<button class="fs-icon-btn fs-niche-pin-on" data-act="niche-unpin" data-username="${escHTML(c.username)}" title="Niche is pinned (manual). Click to unlock for auto-cluster.">📌</button>`
      : "";
    const v = voiceCache.by.get(c.username);
    const inflight = voiceInflight.has(c.username);
    const stale = v && (Date.now() - (v.generatedAt || 0)) > VOICE_STALE_MS;
    const voiceLabel = inflight
      ? "⏳ generating…"
      : v ? "🎙 Regenerate voice" : "🎙 Generate voice fingerprint";
    const voiceMeta = v
      ? `<span class="fs-creator-voice-meta${stale ? ' fs-stale' : ''}" title="${stale ? 'Stale (>30 days) — regenerate' : 'Voice fingerprint up to date'}">${stale ? '⚠ stale · ' : ''}generated ${fmtAge(Math.floor((v.generatedAt || 0) / 1000))}</span>`
      : `<span class="fs-creator-voice-meta fs-creator-voice-none">no fingerprint yet</span>`;
    return `<div class="fs-creator-row" data-creator-row="${escHTML(c.username)}" draggable="true">
      <div class="fs-creator-head">
        <span class="fs-creator-grip" title="Drag to a niche to reassign">⋮⋮</span>
        <input type="checkbox" class="fs-creator-check" ${sel} aria-label="Select creator" />
        <a class="fs-creator-name" href="${escHTML(PLATFORM.profileUrl(c.username))}" target="_blank" rel="noopener">@${escHTML(c.username)}</a>
        ${pin}
        <span class="fs-creator-age" title="Last scraped">${fmtAge(c.lastScrapedAt)}</span>
        <button class="fs-icon-btn" data-act="niche-rescrape-one" data-username="${escHTML(c.username)}" title="Re-scan now">⟳</button>
        <button class="fs-icon-btn" data-act="niche-report" data-username="${escHTML(c.username)}" title="Generate PDF report">📄</button>
        <button class="fs-icon-btn" data-act="niche-remove" data-username="${escHTML(c.username)}" title="Remove">✕</button>
      </div>
      <div class="fs-creator-stats">${st.count} posts · median ${fmt(st.median)} likes</div>
      <div class="fs-creator-voice">
        <button class="fs-icon-btn fs-creator-voice-btn" data-act="niche-voice" data-username="${escHTML(c.username)}" ${inflight ? "disabled" : ""} title="Build a reusable voice/style profile from this creator's top posts">${voiceLabel}</button>
        ${voiceMeta}
      </div>
      <div class="fs-creator-fields">
        <input class="fs-niche-input fs-creator-niche" type="text" value="${escHTML(c.niche || "")}" placeholder="niche" />
        <input class="fs-niche-input fs-creator-interval" type="number" min="1" step="1" value="${c.scrapeIntervalHrs || 24}" title="Interval (hours)" />
        <label class="fs-creator-auto-label"><input class="fs-creator-auto" type="checkbox" ${auto} /> auto</label>
      </div>
    </div>`;
  };

  const renderNiche = async () => {
    if (!els.nicheList) return;
    if (els.nicheAddCurrent) {
      els.nicheAddCurrent.disabled = !(pageScope.kind === "profile" && pageScope.username);
    }
    await refreshCreatorStats();
    await refreshVoiceCache();
    if (!creators.length) {
      els.nicheList.innerHTML = `<div class="fs-niche-empty">No creators tracked yet. Add the current profile or type a username above.</div>`;
      updateNicheBatchUI();
      return;
    }
    // Drop selections that no longer exist.
    const usernames = new Set(creators.map((c) => c.username));
    for (const u of [...state.selectedCreators]) if (!usernames.has(u)) state.selectedCreators.delete(u);

    // Group by niche label. Empty/missing niche → "unlabeled" group at the end.
    const groups = new Map();
    for (const c of creators) {
      const key = (c.niche || "").trim() || "unlabeled";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    const groupKeys = [...groups.keys()].sort((a, b) => {
      if (a === "unlabeled") return 1;
      if (b === "unlabeled") return -1;
      return groups.get(b).length - groups.get(a).length;
    });

    els.nicheList.innerHTML = groupKeys.map((key) => {
      const rows = [...groups.get(key)].sort((a, b) => (b.lastScrapedAt || 0) - (a.lastScrapedAt || 0));
      const pinnedCount = rows.filter((r) => r.nichePinned).length;
      const sub = pinnedCount ? ` · ${pinnedCount} pinned` : "";
      return `<div class="fs-niche-group" data-niche-group="${escHTML(key)}">
        <div class="fs-niche-group-head">
          <span class="fs-niche-group-name">${escHTML(key)}</span>
          <span class="fs-niche-group-count">${rows.length} creator${rows.length === 1 ? "" : "s"}${sub}</span>
        </div>
        <div class="fs-niche-group-body">
          ${rows.map(renderCreatorRow).join("")}
        </div>
      </div>`;
    }).join("");

    // Wire HTML5 drag-and-drop (one set of listeners on the list container).
    if (!els.nicheList.dataset.dndWired) {
      els.nicheList.addEventListener("dragstart", onCreatorDragStart);
      els.nicheList.addEventListener("dragend", onCreatorDragEnd);
      els.nicheList.addEventListener("dragover", onGroupDragOver);
      els.nicheList.addEventListener("dragleave", onGroupDragLeave);
      els.nicheList.addEventListener("drop", onGroupDrop);
      els.nicheList.dataset.dndWired = "1";
    }

    updateNicheBatchUI();
  };

  const updateNicheBatchUI = () => {
    if (!els.nicheBatch) return;
    const n = state.selectedCreators.size;
    els.nicheBatch.hidden = n === 0;
    if (els.nicheBatchCount) els.nicheBatchCount.textContent = `${n} selected`;
    const cmpBtn = els.nicheBatch.querySelector('[data-act="niche-compare"]');
    if (cmpBtn) cmpBtn.disabled = !(n >= 2 && n <= 3);
  };

  const renderSettings = async () => {
    if (!els.settingsPanel) return;
    // Sync inputs to current state.
    const ms = els.settingsPanel.querySelector('[data-ctl="minScore"]');
    if (ms) ms.value = String(state.minScore);
    const rr = els.settingsPanel.querySelector('[data-ctl="radarRange"]');
    if (rr) rr.value = state.radarRange;
    const rl = els.settingsPanel.querySelector('[data-ctl="radarLimit"]');
    if (rl) rl.value = String(state.radarLimit);
    const sNotify = els.settingsPanel.querySelector('[data-ctl="signalsNotify"]');
    if (sNotify) sNotify.checked = !!state.signalsNotify;
    const sSim = els.settingsPanel.querySelector('[data-ctl="signalsMinSim"]');
    if (sSim) sSim.value = String(state.signalsMinSim);
    const sHist = els.settingsPanel.querySelector('[data-ctl="signalsMinHistScore"]');
    if (sHist) sHist.value = String(state.signalsMinHistScore);
    const sAge = els.settingsPanel.querySelector('[data-ctl="signalsMaxAgeDays"]');
    if (sAge) sAge.value = String(state.signalsMaxAgeDays);
    const txUrl = els.settingsPanel.querySelector('[data-ctl="transcribeUrl"]');
    if (txUrl) txUrl.value = String(state.transcribeUrl || "");
    // Health-check the sidecar every time Settings opens.
    checkSidecarHealth().catch(() => {});
    // Sync AI fields and re-check Ollama health.
    const aiSync = (sel, v) => {
      const el = els.settingsPanel.querySelector(`[data-ctl="${sel}"]`);
      if (el) el.value = String(v ?? "");
    };
    aiSync("aiEndpoint", state.ai.endpoint);
    aiSync("aiModel", state.ai.model);
    aiSync("aiVisionModel", state.ai.visionModel);
    aiSync("aiConcurrency", state.ai.concurrency);
    aiSync("aiProvider", state.ai.provider);
    applyProviderUi();
    // Populate Groq dropdowns from cache, then trigger a (cached) refresh.
    populateGroqDropdowns(state.ai.groq.modelsCache && state.ai.groq.modelsCache.models || []);
    refreshGroqModels().catch(() => {});
    checkAiHealth().catch(() => {});
    if (window.__fsStore && els.setInfo) {
      try {
        const all = await window.__fsStore.getAll();
        els.setInfo.textContent = `${all.length} posts · ${creators.length} creators tracked`;
      } catch {
        els.setInfo.textContent = `${creators.length} creators tracked`;
      }
    }
    // Webhook field sync (re-load from storage in case background changed them).
    await loadWebhookConfig();
    const setIfPresent = (sel, v, isCheckbox = false) => {
      const el = els.settingsPanel.querySelector(`[data-ctl="${sel}"]`);
      if (!el) return;
      if (isCheckbox) el.checked = !!v;
      else el.value = String(v || "");
    };
    setIfPresent("whGeneric", state.webhooks.generic);
    setIfPresent("whSlack", state.webhooks.slack);
    setIfPresent("whDiscord", state.webhooks.discord);
    setIfPresent("whAutoOnCollect", state.webhooks.autoOnCollect, true);
    if (els.webhookStatus) els.webhookStatus.textContent = state.webhookStatus || "";
    // Sink fields
    await loadSinkConfig();
    els.settingsPanel.querySelectorAll("[data-sink-ctl]").forEach((sel) => {
      const [sk, field] = String(sel.dataset.sinkCtl || "").split(".");
      if (!sk || !field || !state.sinks[sk]) return;
      const v = state.sinks[sk][field];
      if (sel.type === "checkbox") sel.checked = !!v;
      else sel.value = String(v || "");
    });
    for (const name of Object.keys(state.sinks)) {
      const el = els.settingsPanel.querySelector(`[data-sink-status="${name}"]`);
      if (el) el.textContent = state.sinkStatus[name] || "";
    }
    updateSinkBadges();
  };

  // -------- Outlier Radar render --------
  // Aggregates posts across ALL tracked creators using their *full* IDB
  // history. Per-author baseline = median of `state.metric`. Score = value
  // / baseline. Then filter score ≥ minScore + date cutoff, sort desc.
  const renderRadar = async () => {
    if (!els.radarList) return;
    if (!window.__fsStore) {
      els.radarList.innerHTML = `<div class="fs-niche-empty">IDB not available.</div>`;
      return;
    }
    if (!creators.length) {
      els.radarList.innerHTML = `<div class="fs-niche-empty">Track creators on the Niche tab to populate the Radar.</div>`;
      if (els.radarSub) els.radarSub.textContent = "";
      return;
    }
    const tracked = trackedSet();
    let all;
    try {
      all = await window.__fsStore.getAll();
    } catch (e) {
      logWarn("radar.read.fail", e);
      els.radarList.innerHTML = `<div class="fs-niche-empty">Read failed.</div>`;
      return;
    }
    const inScope = (all || []).filter(
      (p) => p && p.author && tracked.has(p.author.toLowerCase())
    );
    const days = RANGES[state.radarRange] || 0;
    const cutoff = days ? Date.now() / 1000 - days * 86400 : 0;
    const filtered = cutoff ? inScope.filter((p) => p.createTime >= cutoff) : inScope;
    // Compute per-author baseline using FULL stored history (inScope, not
    // filtered) so the baseline is robust to date cutoff.
    const metric = state.metric || "likes";
    const byAuthor = new Map();
    for (const p of inScope) {
      const k = p.author.toLowerCase();
      if (!byAuthor.has(k)) byAuthor.set(k, []);
      byAuthor.get(k).push(p[metric] || 0);
    }
    const meds = new Map();
    for (const [k, vals] of byAuthor) {
      const pos = vals.filter((v) => v > 0);
      if (pos.length < 2) { meds.set(k, 0); continue; }
      const s = pos.sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      meds.set(k, s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
    }
    const min = Number(state.minScore) || 0;
    const scored = filtered.map((p) => {
      const base = meds.get(p.author.toLowerCase()) || 0;
      const score = base > 0 ? (p[metric] || 0) / base : 0;
      return { ...p, _score: score, _scoreBasis: base ? "author" : "insufficient" };
    }).filter((p) => p._score >= min);
    scored.sort((a, b) => b._score - a._score);
    const lim = Number(state.radarLimit) || 0;
    const view = lim > 0 ? scored.slice(0, lim) : scored;
    if (els.radarSub) {
      els.radarSub.textContent = `${view.length}/${scored.length} posts · ${creators.length} creators · ≥${min}× ${metric}`;
    }
    els.radarList.innerHTML = view.length
      ? view.map((p, i) => rowHTML(p, i)).join("")
      : `<div class="fs-niche-empty">No posts ≥ ${min}× yet — try lowering the threshold or running a re-scan.</div>`;
    logInfo("radar.render", {
      tracked: creators.length, candidates: inScope.length,
      filtered: filtered.length, kept: scored.length, shown: view.length,
      min, metric, range: state.radarRange,
    });
  };

  // -------- Signals (cross-creator hook reuse) --------
  // Compute per-author baseline (median likes) across IDB and tag each post
  // with `_score`. Then for each candidate "new" post, find historical posts
  // with author!=newAuthor, _score>=minHistScore, jaccard(hook)>=minSim.
  const computeStoreOutliers = (all) => {
    const byAuthor = new Map();
    for (const p of all) {
      if (!p || !p.author) continue;
      const k = p.author.toLowerCase();
      if (!byAuthor.has(k)) byAuthor.set(k, []);
      byAuthor.get(k).push(p.likes || 0);
    }
    const meds = new Map();
    for (const [k, vals] of byAuthor) {
      const pos = vals.filter((v) => v > 0);
      if (pos.length < 2) { meds.set(k, 0); continue; }
      const s = pos.sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      meds.set(k, s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
    }
    return all.map((p) => {
      const base = meds.get((p.author || "").toLowerCase()) || 0;
      const score = base > 0 ? (p.likes || 0) / base : 0;
      return { ...p, _score: score };
    });
  };

  // Scan a batch of "new" posts against `historical` for hook reuse.
  // Persists matches as signals; returns the list of newly-created signals.
  const detectHookSignals = async (candidates, historical) => {
    if (!candidates || !candidates.length) return [];
    if (!window.__fsStore) return [];
    const minSim = Number(state.signalsMinSim) || 0.6;
    const minHist = Number(state.signalsMinHistScore) || 3;
    const maxAgeDays = Number(state.signalsMaxAgeDays) || 0;
    const ageCutoff = maxAgeDays > 0 ? Date.now() / 1000 - maxAgeDays * 86400 : 0;
    // Pre-compute trigrams for every historical hook with score >= minHist.
    const histReady = [];
    for (const h of historical) {
      if (!h || !h.hook || !h.author) continue;
      if ((h._score || 0) < minHist) continue;
      histReady.push({ post: h, tris: hookTrigrams(h.hook) });
    }
    if (!histReady.length) return [];
    const fresh = [];
    for (const c of candidates) {
      if (!c || !c.id || !c.hook || !c.author) continue;
      if (ageCutoff && (c.createTime || 0) < ageCutoff) continue;
      const newAuthor = c.author.toLowerCase();
      const aTris = hookTrigrams(c.hook);
      let best = null;
      for (const h of histReady) {
        if (h.post.id === c.id) continue;
        if (h.post.author.toLowerCase() === newAuthor) continue;
        const sim = hookJaccard(aTris, h.tris);
        if (sim < minSim) continue;
        if (!best || sim > best.similarity) {
          best = { post: h.post, similarity: sim };
        }
      }
      if (!best) continue;
      const sig = {
        id: `${c.id}__${best.post.id}`,
        newPostId: c.id,
        newAuthor,
        newCreateTime: c.createTime || 0,
        newDesc: c.desc || "",
        newHook: c.hook,
        newUrl: c.url || "",
        newCover: c.cover || "",
        histPostId: best.post.id,
        histAuthor: best.post.author.toLowerCase(),
        histCreateTime: best.post.createTime || 0,
        histDesc: best.post.desc || "",
        histHook: best.post.hook || "",
        histUrl: best.post.url || "",
        histCover: best.post.cover || "",
        histScore: Number(best.post._score) || 0,
        similarity: best.similarity,
      };
      try {
        const res = await window.__fsStore.addSignal(sig);
        if (res && res.row) {
          signalsCache.set(res.row.id, res.row);
          if (res.isNew) {
            fresh.push(res.row);
            logInfo("hook.match", {
              new: { id: c.id, author: newAuthor },
              hist: { id: best.post.id, author: sig.histAuthor, score: sig.histScore.toFixed(2) + "x" },
              similarity: Number(sig.similarity.toFixed(3)),
            });
          }
        }
      } catch (e) {
        logWarn("signals.add.fail", e);
      }
    }
    if (fresh.length) {
      updateSignalsBadge();
      if (state.signalsOpen) renderSignals();
      if (state.signalsNotify) {
        for (const s of fresh) {
          try {
            chrome.runtime.sendMessage({ type: "fs-bg", cmd: "notify-signal", signal: s });
          } catch (e) { logWarn("signals.notify.fail", e); }
        }
      }
    }
    return fresh;
  };

  // Debounced post-ingest scan: pending IDs accumulate and we scan ~1s
  // after the last ingest tick to coalesce a scroll burst.
  const pendingScan = new Set();
  let scanTimer = null;
  const queueHookScan = (ids) => {
    if (!ids || !ids.length) return;
    for (const id of ids) pendingScan.add(id);
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(runQueuedScan, 1000);
  };
  const runQueuedScan = async () => {
    scanTimer = null;
    if (!window.__fsStore) { pendingScan.clear(); return; }
    if (!pendingScan.size) return;
    const ids = [...pendingScan];
    pendingScan.clear();
    try {
      const all = await window.__fsStore.getAll();
      const scored = computeStoreOutliers(all || []);
      const byId = new Map(scored.map((p) => [p.id, p]));
      const candidates = ids.map((id) => byId.get(id) || posts.get(id)).filter(Boolean);
      // Don't compare a candidate against itself; pass full scored list.
      await detectHookSignals(candidates, scored);
    } catch (e) {
      logWarn("signals.scan.fail", e);
    }
  };

  // Manual full rescan: every stored post with a hook becomes a candidate.
  const rescanAllSignals = async () => {
    if (!window.__fsStore) return;
    setStatus("rescanning signals…");
    const all = await window.__fsStore.getAll();
    const scored = computeStoreOutliers(all || []);
    const candidates = scored.filter((p) => p && p.hook);
    const fresh = await detectHookSignals(candidates, scored);
    setStatus(`rescan done — ${fresh.length} new signal${fresh.length === 1 ? "" : "s"}`);
    logInfo("signals.rescan.done", { candidates: candidates.length, fresh: fresh.length });
    await loadSignalsCache();
    renderSignals();
  };

  const loadSignalsCache = async () => {
    if (!window.__fsStore) return;
    try {
      const rows = await window.__fsStore.getAllSignals();
      signalsCache.clear();
      for (const r of rows || []) signalsCache.set(r.id, r);
      updateSignalsBadge();
    } catch (e) { logWarn("signals.load.fail", e); }
  };

  const updateSignalsBadge = () => {
    if (els.signalsBadge) {
      let unread = 0;
      for (const s of signalsCache.values()) if (s && !s.read) unread++;
      els.signalsBadge.textContent = String(unread);
      els.signalsBadge.hidden = unread === 0;
    }
    if (els.signalsBtn) {
      const hasAny = signalsCache.size > 0 || !!state.signalsNotify;
      els.signalsBtn.hidden = !hasAny;
    }
  };

  const fmtRelDate = (t) => {
    if (!t) return "";
    const ms = t * 1000;
    const days = Math.floor((Date.now() - ms) / 86400000);
    if (days <= 0) return "today";
    if (days === 1) return "1d ago";
    if (days < 30) return `${days}d ago`;
    if (days < 365) return `${Math.floor(days / 30)}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  };

  const renderSignals = () => {
    if (!els.signalsList) return;
    // Sync threshold inputs in the bar (Settings tab also has them).
    if (els.signalsPanel) {
      const setVal = (name, v) => {
        const i = els.signalsPanel.querySelector(`[data-ctl="${name}"]`);
        if (i) i.value = String(v);
      };
      setVal("signalsMinSim", state.signalsMinSim);
      setVal("signalsMinHistScore", state.signalsMinHistScore);
      setVal("signalsMaxAgeDays", state.signalsMaxAgeDays);
      const chip = els.signalsPanel.querySelector('[data-signals-chip="unreadOnly"]');
      if (chip) chip.classList.toggle("fs-chip-active", !!state.signalsUnreadOnly);
    }
    const minSim = Number(state.signalsMinSim) || 0;
    const minHist = Number(state.signalsMinHistScore) || 0;
    const maxAgeDays = Number(state.signalsMaxAgeDays) || 0;
    const ageCutoff = maxAgeDays > 0 ? Date.now() / 1000 - maxAgeDays * 86400 : 0;
    const rows = [...signalsCache.values()].filter((s) => {
      if (!s) return false;
      if (s.similarity < minSim) return false;
      if (s.histScore < minHist) return false;
      if (ageCutoff && (s.newCreateTime || 0) < ageCutoff) return false;
      if (state.signalsUnreadOnly && s.read) return false;
      return true;
    });
    rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    if (!rows.length) {
      els.signalsList.innerHTML = `<div class="fs-niche-empty">No signals match the current thresholds. Scroll a creator's feed or click ⟳ to rescan stored posts.</div>`;
      return;
    }
    els.signalsList.innerHTML = rows.map((s) => {
      const pct = Math.round((s.similarity || 0) * 100);
      const score = (Number(s.histScore) || 0).toFixed(1);
      const dot = s.read ? "" : `<span class="fs-signal-dot" title="unread"></span>`;
      const newLink = s.newUrl ? `<a class="fs-signal-author" href="${escHTML(s.newUrl)}" target="_blank" rel="noopener">@${escHTML(s.newAuthor)}</a>` : `<span class="fs-signal-author">@${escHTML(s.newAuthor)}</span>`;
      const histLink = s.histUrl ? `<a class="fs-signal-author" href="${escHTML(s.histUrl)}" target="_blank" rel="noopener">@${escHTML(s.histAuthor)}</a>` : `<span class="fs-signal-author">@${escHTML(s.histAuthor)}</span>`;
      const histAge = fmtRelDate(s.histCreateTime);
      const histScoreStr = `${score}×`;
      return `<div class="fs-signal-row${s.read ? "" : " fs-signal-unread"}">
        <div class="fs-signal-head">
          ${dot}<span class="fs-signal-pct" title="trigram-Jaccard similarity">${pct}%</span>
          <button class="fs-icon-btn fs-signal-mark" data-act="signal-mark-read" data-id="${escHTML(s.id)}" title="Toggle read">${s.read ? "⚬" : "●"}</button>
        </div>
        <div class="fs-signal-line">new post by ${newLink}</div>
        <div class="fs-signal-hook">“${escHTML(s.newHook || "")}”</div>
        <div class="fs-signal-line fs-signal-hist">
          hooks similar to <span class="fs-signal-score">${histScoreStr}</span> outlier by ${histLink} · ${escHTML(histAge)}
        </div>
        <div class="fs-signal-hook">“${escHTML(s.histHook || "")}”</div>
      </div>`;
    }).join("");
  };

  // -------- Sounds (trending audio) --------
  // Reads the `audio` IDB store, applies UI chip filters, sorts by composite
  // risingScore = medianOutlier * weeklyUseGrowth, renders rows.
  // -------- Patterns tab (hookType × topic clusters) --------
  // Pure aggregation — no LLM call here. Pulls from the same enriched scope
  // as the Stats panel (full scope, no limit slice).
  const computePatterns = (list) => {
    const buckets = new Map();
    for (const p of list) {
      if (!p.ai || !p.ai.hook) continue;
      const ht = p.ai.hookType || "other";
      const tp = p.ai.topic || "(unknown)";
      const key = ht + "\u0001" + tp;
      let b = buckets.get(key);
      if (!b) {
        b = { hookType: ht, topic: tp, n: 0, scores: [], angles: new Map(), examples: [] };
        buckets.set(key, b);
      }
      b.n++;
      b.scores.push(p._score || 0);
      const a = p.ai.angle || "";
      if (a) b.angles.set(a, (b.angles.get(a) || 0) + 1);
      if (b.examples.length < 3) b.examples.push(p);
    }
    const rows = [];
    for (const b of buckets.values()) {
      const med = median(b.scores);
      const topAngle = [...b.angles.entries()].sort((x, y) => y[1] - x[1])[0];
      rows.push({
        hookType: b.hookType,
        topic: b.topic,
        n: b.n,
        medianOutlier: med,
        topAngle: topAngle ? topAngle[0] : "",
        examples: b.examples,
      });
    }
    rows.sort((x, y) => y.medianOutlier - x.medianOutlier || y.n - x.n);
    return rows;
  };
  const renderSounds = async () => {
    if (!els.soundsList) return;
    if (!window.__fsStore) {
      els.soundsList.innerHTML = `<div class="fs-niche-empty">IDB not available.</div>`;
      return;
    }
    // Sync chip active state.
    if (els.soundsPanel) {
      els.soundsPanel.querySelectorAll("[data-sound-chip]").forEach((c) => {
        const k = c.dataset.soundChip;
        const on = !!state["audio" + k[0].toUpperCase() + k.slice(1)];
        c.classList.toggle("fs-chip-active", on);
      });
    }
    if (els.soundsActive) {
      const on = !!state.audioId;
      els.soundsActive.hidden = !on;
      if (on && els.soundsActiveLabel) {
        const a = audioById(state.audioId);
        const label = a ? `Filtering posts by sound: ${a.title || a.id}` : `Filtering by audio ${state.audioId}`;
        els.soundsActiveLabel.textContent = label;
      }
    }
    let rows;
    try {
      rows = await window.__fsStore.getAllAudio();
    } catch (e) {
      logWarn("sounds.read.fail", e);
      els.soundsList.innerHTML = `<div class="fs-niche-empty">Read failed.</div>`;
      return;
    }
    rows = rows || [];
    if (state.audioOriginalsOnly) rows = rows.filter((r) => !!r.isOriginal);
    if (state.audioMusicOnly) rows = rows.filter((r) => !r.isOriginal);
    if (state.audioMinUses) rows = rows.filter((r) => (r.posts?.length || 0) >= 3);
    rows = rows.map((r) => ({
      ...r,
      _rising: (Number(r.medianOutlier) || 0) * (Number(r.weeklyUseGrowth) || 0),
    }));
    rows.sort((a, b) => {
      if (b._rising !== a._rising) return b._rising - a._rising;
      // Tie-breaker: useCount, then post fan-out.
      if ((b.useCount || 0) !== (a.useCount || 0)) return (b.useCount || 0) - (a.useCount || 0);
      return (b.posts?.length || 0) - (a.posts?.length || 0);
    });
    if (!rows.length) {
      els.soundsList.innerHTML = `<div class="fs-niche-empty">No sounds yet — scroll a Reels-heavy profile to capture audio metadata.</div>`;
      logInfo("sounds.render", { rows: 0 });
      return;
    }
    const fmtPct = (g) => {
      if (!g) return "—";
      const pct = (g - 1) * 100;
      const sign = pct > 0 ? "+" : "";
      return `${sign}${pct.toFixed(0)}%`;
    };
    els.soundsList.innerHTML = rows.slice(0, 200).map((r) => {
      const title = escHTML(r.title || (r.isOriginal ? "Original audio" : "(untitled)"));
      const artist = escHTML(r.artist || r.originalAuthor || (r.isOriginal ? "original" : ""));
      const uses = r.posts?.length || 0;
      const med = (Number(r.medianOutlier) || 0).toFixed(2);
      const growth = fmtPct(r.weeklyUseGrowth);
      const tag = r.isOriginal
        ? `<span class="fs-sound-tag fs-sound-tag-orig">orig</span>`
        : `<span class="fs-sound-tag fs-sound-tag-music">music</span>`;
      const link = PLATFORM.audioUrl(r.id);
      const sel = state.audioId === r.id ? " fs-sound-row-active" : "";
      return `<div class="fs-sound-row${sel}" data-sound-id="${escHTML(r.id)}">
        <div class="fs-sound-head">
          ${tag}
          <div class="fs-sound-title" title="${title}">${title}</div>
          <a class="fs-sound-link" href="${link}" target="_blank" rel="noopener" title="Open on Instagram" data-sound-link>↗</a>
        </div>
        <div class="fs-sound-sub">${artist || "&nbsp;"}</div>
        <div class="fs-sound-stats">
          <span title="posts captured using this sound">▶ ${uses}</span>
          <span title="median outlier score across captured posts">med ${med}×</span>
          <span title="weekly use growth (last 7d / prev 7d)">growth ${growth}</span>
        </div>
      </div>`;
    }).join("");
    logInfo("sounds.render", { rows: rows.length });
  };

  const audioById = (id) => {
    // Best-effort sync lookup from session posts (avoids an await for the label).
    for (const p of posts.values()) {
      if (p.audio && p.audio.id === id) return p.audio;
    }
    return null;
  };

  // -------- Outbound webhooks --------
  // URLs are persisted in chrome.storage.local under `fs.webhooks` so the
  // service worker (background.js) can read the same config for the weekly
  // digest alarm. No auth beyond the URL itself.
  const WH_KEY = "fs.webhooks";
  const loadWebhookConfig = async () => {
    try {
      const r = await chrome.storage.local.get(WH_KEY);
      const cfg = r && r[WH_KEY];
      if (cfg && typeof cfg === "object") {
        state.webhooks = {
          generic: String(cfg.generic || ""),
          slack: String(cfg.slack || ""),
          discord: String(cfg.discord || ""),
          autoOnCollect: !!cfg.autoOnCollect,
        };
      }
    } catch (e) {
      logWarn("webhook.load.fail", e);
    }
  };
  const saveWebhookConfig = async () => {
    try {
      await chrome.storage.local.set({ [WH_KEY]: state.webhooks });
      logInfo("webhook.config.save", {
        hasGeneric: !!state.webhooks.generic,
        hasSlack: !!state.webhooks.slack,
        hasDiscord: !!state.webhooks.discord,
        autoOnCollect: state.webhooks.autoOnCollect,
      });
    } catch (e) {
      logWarn("webhook.save.fail", e);
    }
  };

  const setWebhookStatus = (msg, level = "info") => {
    state.webhookStatus = msg || "";
    if (els.webhookStatus) {
      els.webhookStatus.textContent = msg || "";
      els.webhookStatus.dataset.level = level;
    }
  };

  // Route POSTs through the background SW so we side-step Instagram's CSP
  // and don't leak referer/auth from the IG page context.
  const postJSON = async (url, body) => {
    if (!url) return { ok: false, status: 0, err: "no-url" };
    const t0 = Date.now();
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "fs-bg", cmd: "webhook-post", url, body },
          (resp) => {
            const lerr = chrome.runtime.lastError;
            if (lerr || !resp) {
              const out = { ok: false, status: 0, err: String(lerr?.message || "no-response"), ms: Date.now() - t0 };
              logWarn("webhook.post.fail", { url: redactUrl(url), ...out });
              return resolve(out);
            }
            const out = { ok: !!resp.ok, status: resp.status || 0, err: resp.err, ms: Date.now() - t0 };
            if (out.ok) logInfo("webhook.post", { url: redactUrl(url), ...out });
            else logWarn("webhook.post.fail", { url: redactUrl(url), ...out });
            resolve(out);
          },
        );
      } catch (e) {
        const out = { ok: false, status: 0, err: String(e), ms: Date.now() - t0 };
        logWarn("webhook.post.fail", { url: redactUrl(url), ...out });
        resolve(out);
      }
    });
  };
  const redactUrl = (u) => {
    try {
      const x = new URL(u);
      return `${x.origin}${x.pathname.split("/").slice(0, 3).join("/")}/***`;
    } catch { return "<bad-url>"; }
  };

  // Compact post-shape sent over the wire — strip snapshots/heavy fields.
  const slimPost = (p) => ({
    id: p.id,
    shortcode: p.shortcode || "",
    author: p.author || "",
    desc: (p.desc || "").slice(0, 500),
    createTime: p.createTime || 0,
    surface: p.surface || "",
    likes: p.likes || 0,
    views: p.views || 0,
    comments: p.comments || 0,
    score: Number(p._score || 0),
    url: p.url || "",
    cover: p.cover || "",
    videoUrl: p.videoUrl || "",
  });

  const buildViewPayload = (rows) => ({
    posts: rows.map(slimPost),
    scope: { ...pageScope },
    filters: {
      sort: state.sort, metric: state.metric, range: state.range,
      limit: state.limit, surface: state.surface, scope: state.scope,
      q: state.q || "",
    },
    generatedAt: new Date().toISOString(),
    source: PLATFORM_SOURCE,
    version: "view",
  });

  // Slack Block Kit digest for top N rows.
  const buildSlackBlocks = (rows, title) => {
    const blocks = [
      { type: "header", text: { type: "plain_text", text: title } },
      { type: "context", elements: [{ type: "mrkdwn", text: `_Feed Sorter · ${new Date().toLocaleString()}_` }] },
      { type: "divider" },
    ];
    rows.forEach((p, i) => {
      const score = Number(p._score || 0).toFixed(2);
      const lines = [
        `*${i + 1}. <${p.url || "#"}|@${p.author || "unknown"}>*  · ${score}× · ❤ ${p.likes || 0} · ▶ ${p.views || 0} · 💬 ${p.comments || 0}`,
        (p.desc || "").slice(0, 200),
      ].filter(Boolean);
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n") },
        accessory: p.cover ? { type: "image", image_url: p.cover, alt_text: `@${p.author || ""}` } : undefined,
      });
    });
    return { text: title, blocks };
  };

  // Discord webhook payload (embeds).
  const buildDiscordEmbeds = (rows, title) => ({
    content: title,
    embeds: rows.map((p, i) => ({
      title: `${i + 1}. @${p.author || "unknown"} · ${Number(p._score || 0).toFixed(2)}×`,
      url: p.url || undefined,
      description: (p.desc || "").slice(0, 300),
      thumbnail: p.cover ? { url: p.cover } : undefined,
      fields: [
        { name: "Likes", value: String(p.likes || 0), inline: true },
        { name: "Views", value: String(p.views || 0), inline: true },
        { name: "Comments", value: String(p.comments || 0), inline: true },
      ],
      timestamp: p.createTime ? new Date(p.createTime * 1000).toISOString() : undefined,
    })),
  });

  // -- Public webhook actions --
  const sendTestPing = async () => {
    const cfg = state.webhooks;
    const targets = [
      ["generic", cfg.generic],
      ["slack", cfg.slack],
      ["discord", cfg.discord],
    ].filter(([, u]) => !!u);
    if (!targets.length) {
      setWebhookStatus("no webhooks configured", "warn");
      return;
    }
    setWebhookStatus("sending test ping…");
    const stub = {
      source: PLATFORM_SOURCE,
      version: "test-ping",
      generatedAt: new Date().toISOString(),
      message: "Hello from Feed Sorter — webhook configured successfully.",
      scope: { ...pageScope },
    };
    const results = [];
    for (const [kind, url] of targets) {
      let body = stub;
      if (kind === "slack") body = { text: "Feed Sorter test ping ✅", blocks: [{ type: "section", text: { type: "mrkdwn", text: "*Feed Sorter test ping* ✅\nWebhook is reachable." } }] };
      else if (kind === "discord") body = { content: "Feed Sorter test ping ✅ — webhook is reachable." };
      const r = await postJSON(url, body);
      results.push({ kind, ok: r.ok, status: r.status });
    }
    const ok = results.filter((r) => r.ok).length;
    const tone = ok === results.length ? "info" : (ok ? "warn" : "error");
    setWebhookStatus(`test ping: ${ok}/${results.length} ok · ${results.map((r) => `${r.kind}=${r.ok ? "ok" : (r.status || "err")}`).join(" ")}`, tone);
  };

  const sendViewToGeneric = async () => {
    const url = state.webhooks.generic;
    if (!url) { setWebhookStatus("set a Generic webhook URL first", "warn"); return; }
    const rows = filtered();
    if (!rows.length) { setWebhookStatus("no posts in current view", "warn"); return; }
    setWebhookStatus(`sending ${rows.length} posts…`);
    const r = await postJSON(url, buildViewPayload(rows));
    setWebhookStatus(r.ok ? `sent ${rows.length} posts (${r.status})` : `failed: ${r.status || r.err}`, r.ok ? "info" : "error");
  };

  const sendTopToSlack = async () => {
    const url = state.webhooks.slack;
    if (!url) { setWebhookStatus("set a Slack webhook URL first", "warn"); return; }
    const top = filtered().slice(0, 5);
    if (!top.length) { setWebhookStatus("no posts to send", "warn"); return; }
    const title = pageScope.kind === "profile" && pageScope.username
      ? `Top ${top.length} on @${pageScope.username}`
      : `Top ${top.length} outliers`;
    setWebhookStatus("sending Slack digest…");
    const r = await postJSON(url, buildSlackBlocks(top.map(slimPost), title));
    setWebhookStatus(r.ok ? `Slack: sent ${top.length} (${r.status})` : `Slack failed: ${r.status || r.err}`, r.ok ? "info" : "error");
  };

  const sendTopToDiscord = async () => {
    const url = state.webhooks.discord;
    if (!url) { setWebhookStatus("set a Discord webhook URL first", "warn"); return; }
    const top = filtered().slice(0, 5);
    if (!top.length) { setWebhookStatus("no posts to send", "warn"); return; }
    const title = pageScope.kind === "profile" && pageScope.username
      ? `Top ${top.length} on @${pageScope.username}`
      : `Top ${top.length} outliers`;
    setWebhookStatus("sending Discord digest…");
    const r = await postJSON(url, buildDiscordEmbeds(top.map(slimPost), title));
    setWebhookStatus(r.ok ? `Discord: sent ${top.length} (${r.status})` : `Discord failed: ${r.status || r.err}`, r.ok ? "info" : "error");
  };

  // -------- Direct sinks (Sheets / Airtable / Notion) --------
  // Config persisted in chrome.storage.local under `fs.sinks`. Each sink is
  // implemented in src/sinks/<name>.js and registered onto window.__fsSinks.
  const SINKS_KEY = "fs.sinks";
  const loadSinkConfig = async () => {
    try {
      const r = await chrome.storage.local.get(SINKS_KEY);
      const cfg = r && r[SINKS_KEY];
      if (cfg && typeof cfg === "object") {
        for (const k of Object.keys(state.sinks)) {
          if (cfg[k] && typeof cfg[k] === "object") {
            state.sinks[k] = { ...state.sinks[k], ...cfg[k] };
          }
        }
      }
    } catch (e) { logWarn("sink.load.fail", e); }
  };
  const saveSinkConfig = async () => {
    try {
      await chrome.storage.local.set({ [SINKS_KEY]: state.sinks });
      logInfo("sink.config.save", {
        sheets: { en: state.sinks.sheets.enabled, hasUrl: !!state.sinks.sheets.url, auto: state.sinks.sheets.autoOnCollect },
        airtable: { en: state.sinks.airtable.enabled, hasToken: !!state.sinks.airtable.token, hasBase: !!state.sinks.airtable.baseId, table: state.sinks.airtable.table, auto: state.sinks.airtable.autoOnCollect },
        notion: { en: state.sinks.notion.enabled, hasToken: !!state.sinks.notion.token, hasDb: !!state.sinks.notion.databaseId, auto: state.sinks.notion.autoOnCollect },
      });
    } catch (e) { logWarn("sink.save.fail", e); }
  };

  const setSinkStatus = (name, msg, level = "info") => {
    state.sinkStatus[name] = msg || "";
    if (!els.settingsPanel) return;
    const el = els.settingsPanel.querySelector(`[data-sink-status="${name}"]`);
    if (el) {
      el.textContent = msg || "";
      el.dataset.level = level;
    }
  };
  const updateSinkBadges = () => {
    if (!els.settingsPanel) return;
    for (const name of Object.keys(state.sinks)) {
      const b = els.settingsPanel.querySelector(`[data-sink-badge="${name}"]`);
      if (!b) continue;
      const cfg = state.sinks[name];
      const tags = [];
      if (cfg.enabled) tags.push("on");
      if (cfg.autoOnCollect) tags.push("auto");
      b.textContent = tags.length ? `· ${tags.join(", ")}` : "";
    }
  };

  const runSinkTest = async (name) => {
    const reg = window.__fsSinks && window.__fsSinks.sinks[name];
    if (!reg) { setSinkStatus(name, "sink not loaded", "error"); return; }
    setSinkStatus(name, "testing…");
    logInfo(`sink.${name}.test.start`);
    const r = await reg.test(state.sinks[name]);
    logInfo(`sink.${name}.test.done`, { ok: r.ok, status: r.status });
    setSinkStatus(name, r.msg || (r.ok ? "ok" : "failed"), r.ok ? "info" : "error");
  };

  const runSinkSync = async (name, rows) => {
    const reg = window.__fsSinks && window.__fsSinks.sinks[name];
    if (!reg) { setSinkStatus(name, "sink not loaded", "error"); return { ok: false }; }
    if (!rows || !rows.length) { setSinkStatus(name, "no posts in current view", "warn"); return { ok: false }; }
    const total = rows.length;
    let done = 0, ok = 0, fail = 0;
    setSinkStatus(name, `syncing 0/${total}…`);
    logInfo(`sink.${name}.sync.start`, { rows: total });
    const onProgress = (i, n, status) => {
      done = i;
      if (status === "ok") ok++; else fail++;
      // Throttle UI updates to every 5 rows or last row.
      if (i === n || i % 5 === 0) setSinkStatus(name, `syncing ${i}/${n} · ✓${ok} ✗${fail}`);
    };
    const t0 = Date.now();
    const res = await reg.push(rows, state.sinks[name], onProgress);
    const ms = Date.now() - t0;
    logInfo(`sink.${name}.sync.done`, { sent: res.sent, failed: res.failed, ms, errs: (res.errors || []).slice(0, 3) });
    const tone = res.ok ? "info" : (res.sent ? "warn" : "error");
    let msg = `${res.sent}/${total} ok` + (res.failed ? ` · ${res.failed} failed` : "") + ` · ${(ms / 1000).toFixed(1)}s`;
    if (res.errors && res.errors.length) msg += ` — ${res.errors[0]}`;
    setSinkStatus(name, msg, tone);
    return res;
  };

  // Run every enabled sink whose autoOnCollect is true. Called from
  // sendCollectDelta. Operates on the *delta* (only newly-captured rows).
  const runAutoSinksOnCollect = async (rows) => {
    if (!rows.length) return;
    for (const name of Object.keys(state.sinks)) {
      const cfg = state.sinks[name];
      if (!cfg.enabled || !cfg.autoOnCollect) continue;
      try { await runSinkSync(name, rows); }
      catch (e) { logError(`sink.${name}.auto.fail`, e); }
    }
  };

  // Auto delta on collect.end. `preIds` is the set of post IDs known before
  // the collect run started; the delta is the in-scope rows whose id wasn't
  // in that set.
  const sendCollectDelta = async (preIds, endPayload) => {
    const url = state.webhooks.generic;
    if (!url || !state.webhooks.autoOnCollect) return;
    const rows = filtered().filter((p) => !preIds.has(p.id));
    if (!rows.length) {
      logInfo("webhook.delta.empty", { preIds: preIds.size });
      return;
    }
    const body = {
      ...buildViewPayload(rows),
      version: "collect-delta",
      collect: endPayload || null,
    };
    const r = await postJSON(url, body);
    logInfo("webhook.delta.sent", { rows: rows.length, ok: r.ok, status: r.status });
  };

  // Single auto-on-collect entry point. The webhook delta is conceptually
  // the same payload, just routed differently — keep both code paths.
  const runAutoOnCollect = async (preIds, endPayload) => {
    const delta = filtered().filter((p) => !preIds.has(p.id));
    try { await sendCollectDelta(preIds, endPayload); } catch (e) { logWarn("webhook.delta.fail", e); }
    try { await runAutoSinksOnCollect(delta); } catch (e) { logWarn("sink.auto.fail", e); }
  };

  const boot = () => {
    if (!document.body) return setTimeout(boot, 50);
    pageScope = deriveScope();
    suppressHashSync = true;
    restoreFromHash();
    suppressHashSync = false;
    loadWebhookConfig().catch(() => {});
    loadSinkConfig().catch(() => {});
    loadTranscribeConfig().catch(() => {});
    loadTranscriptCloudConfig().catch(() => {});
    loadAiConfig().catch(() => {});
    loadMeConfig().catch(() => {});
    buildUI();
    render();
    // Hydrate the tier cache + subscribe to live flips. When the user
    // upgrades in another tab, /v1/billing/webhook → background →
    // chrome.storage.local["fs.api.tier"] changes → onTierChange fires →
    // re-render and the locked surfaces unlock without a reload.
    try {
      const tg = globalThis.FeedSorterTierGate;
      if (tg) {
        tg.getTier().then(() => {
          try { render(); } catch (e) { logWarn("tier.boot.render.fail", e); }
        });
        tg.onTierChange((next, prev) => {
          logInfo("tier.change", { from: prev, to: next });
          try { render(); } catch (e) { logWarn("tier.change.render.fail", e); }
        });
      }
    } catch (e) { logWarn("tier.boot.fail", e); }
    logInfo("boot", {
      scope: pageScope,
      path: location.pathname,
      hash: location.hash,
      platform: PLATFORM.platform,
      surfaces: PLATFORM.surfaces,
      idPrefix: PLATFORM.postIdPrefix,
      downloadFolder: PLATFORM_DOWNLOAD_FOLDER,
    });
    if (pageScope.kind === "other") setStatus("idle (off-feed page)");
    // Bio-first niche cascade input: on profile boots, ask injected.js to
    // hit IG's web_profile_info endpoint so we get the user's biography +
    // category. The response flows through the existing `feed-response`
    // channel and lands in IDB via the profile branch added above.
    maybeFetchProfileInfo();
    // Kick off store init + rehydrate. Safe even on "other" pages —
    // getByScope returns [] for kind=other.
    if (window.__fsStore) {
      window.__fsStore.ready()
        .then(async () => {
          await loadAllMeta();
          await loadPinnedPosts();
          await reloadCreators();
          await rehydrateFromStore();
          await loadSignalsCache();
          render();
          updateView();
        })
        .catch((e) => logError("store.init.fail", e));
    } else {
      logWarn("store.missing", { hint: "src/store.js not loaded" });
    }
  };
  boot();
})();
