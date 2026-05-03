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

  // -------- page scope --------
  // What page are we on? Drives ingest filtering + auto-collect gating.
  // Updated on SPA navs via patched history methods + popstate.
  /** @type {{ kind: "profile"|"explore"|"other", username: string|null }} */
  let pageScope = { kind: "other", username: null };

  const deriveScope = () => PLATFORM.scope.deriveScope(location.pathname || "/");

  const onScopeMaybeChanged = () => {
    const next = deriveScope();
    if (next.kind === pageScope.kind && next.username === pageScope.username) return;
    const old = { ...pageScope };
    pageScope = next;
    // Don't wipe IDB. Just drop the rendered/in-memory view; we'll rehydrate
    // for the new scope below.
    posts.clear();
    collector.abort = collector.running ? true : false;
    collector.reason = null;
    logInfo("scope.change", { from: old, to: pageScope, path: location.pathname });
    updateHeader();
    render();
    setStatus(pageScope.kind === "other" ? "idle (off-feed page)" : "idle");
    // Rehydrate from IDB for the new scope (or all-time if toggle is set).
    rehydrateFromStore().catch((e) => logError("store.rehydrate.fail", e));
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

  const ingest = (raw, url, tag) => {
    let json;
    try { json = JSON.parse(raw); } catch { return 0; }
    const surface = surfaceFromUrlTag(url || "", tag || "");
    const items = harvestPosts(json, surface);
    let added = 0;
    let droppedScope = 0;
    const toPersist = [];
    const now = Date.now();
    for (const p of items) {
      if (!p.id) continue;
      // Scope filter
      if (pageScope.kind === "other") { droppedScope++; continue; }
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
          author: p.author || prev.author,
          videoUrl: p.videoUrl || prev.videoUrl,
          // Preserve snapshots; canonical update arrives via the IDB callback below.
          snapshots: prev.snapshots || [],
          firstSeenAt: prev.firstSeenAt || now,
          lastSeenAt: now,
        };
      } else {
        merged = { ...p, snapshots: [], firstSeenAt: now, lastSeenAt: now };
        added++;
      }
      posts.set(p.id, merged);
      sessionIds.add(p.id);
      toPersist.push(merged);
    }
    if (droppedScope) logDebug("ingest.dropped", { scope: pageScope.kind, dropped: droppedScope });
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
    if (items.length) render();
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
      ingest(data.body, data.url, data.tag);
      const added = posts.size - before;
      if (added > 0) logInfo("capture", {
        platform: PLATFORM.platform,
        surface: surfaceFromUrlTag(data.url, data.tag),
        tag: data.tag || "",
        added,
        total: posts.size,
      });
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
  const STEP_MS = 1500;

  const collector = {
    running: false,
    abort: false,
    reason: null,
    startedAt: 0,
  };

  const oldestInScope = () => {
    let oldest = Infinity;
    for (const p of posts.values()) {
      if (state.surface !== "all" && p.surface !== state.surface) continue;
      if (p.createTime && p.createTime < oldest) oldest = p.createTime;
    }
    return oldest === Infinity ? 0 : oldest;
  };

  const inScopeCount = () => {
    if (state.surface === "all") return posts.size;
    let n = 0;
    for (const p of posts.values()) if (p.surface === state.surface) n++;
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
    const preIds = new Set(posts.keys());

    const days = RANGES[state.range];
    const cutoff = days ? Date.now() / 1000 - days * 86400 : 0;
    const limit = state.limit;

    logInfo("collect.start", {
      trigger,
      scope: pageScope,
      surface: state.surface,
      range: state.range,
      cutoffISO: cutoff ? new Date(cutoff * 1000).toISOString() : null,
      limit,
      url: location.pathname,
    });
    setStatus("collecting…");

    let lastCount = inScopeCount();
    let stagnantSince = Date.now();
    let scrolls = 0;

    while (!collector.abort) {
      window.scrollTo(0, document.documentElement.scrollHeight);
      scrolls++;
      await sleep(STEP_MS);

      if (scrolls % 3 === 0) {
        window.scrollBy(0, -400);
        await sleep(200);
        window.scrollTo(0, document.documentElement.scrollHeight);
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
      if (Date.now() - stagnantSince > IDLE_MS) {
        collector.reason = "idle-end-of-feed";
        break;
      }
      if (Date.now() - collector.startedAt > 5 * 60 * 1000) {
        collector.reason = "timeout-5min";
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
  // Pure: reads p.snapshots and returns the time-series-derived fields.
  // velocityViewsPerHr = (views_now - views_first) / hours_since_first.
  // accelerating = recent-interval velocity > average velocity * 1.5
  // (requires ≥ 3 snapshots so we have a "recent" vs "overall" comparison).
  const ACCEL_RATIO = 1.5;
  const computeDerived = (p) => {
    const snaps = Array.isArray(p.snapshots) ? p.snapshots : [];
    if (!snaps.length) {
      return { firstSeenViews: p.views || 0, velocityViewsPerHr: 0, accelerating: false, snapshotCount: 0 };
    }
    const first = snaps[0];
    const last = snaps[snaps.length - 1];
    const hrs = Math.max((last.capturedAt - first.capturedAt) / 3600000, 0);
    const dViews = Math.max(0, (last.views || 0) - (first.views || 0));
    const velocity = hrs > 0 ? dViews / hrs : 0;
    let accelerating = false;
    if (snaps.length >= 3 && velocity > 0) {
      const prev = snaps[snaps.length - 2];
      const recentHrs = Math.max((last.capturedAt - prev.capturedAt) / 3600000, 0);
      const recentV = recentHrs > 0
        ? Math.max(0, (last.views || 0) - (prev.views || 0)) / recentHrs
        : 0;
      accelerating = recentV > velocity * ACCEL_RATIO;
    }
    return {
      firstSeenViews: first.views || 0,
      velocityViewsPerHr: velocity,
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

  // Outlier score = value / baseline.
  // Per-author median when the author has ≥2 samples (proper "this post vs
  // their typical"). Otherwise fall back to the global median across the
  // current list — meaningful on Explore where each author has 1 post.
  const MIN_SAMPLES = 2;
  const computeOutliers = (list, metric) => {
    const byAuthor = new Map();
    const globalVals = [];
    for (const p of list) {
      const v = p[metric] || 0;
      if (v > 0) globalVals.push(v);
      const k = p.author || "_unknown";
      if (!byAuthor.has(k)) byAuthor.set(k, []);
      byAuthor.get(k).push(v);
    }
    const globalMed = median(globalVals);
    const meds = new Map();
    for (const [a, vals] of byAuthor) {
      const positive = vals.filter((x) => x > 0);
      meds.set(a, positive.length >= MIN_SAMPLES ? median(positive) : 0);
    }
    return list.map((p) => {
      const authorMed = meds.get(p.author || "_unknown") || 0;
      const baseline = authorMed || globalMed;
      const score = baseline > 0 ? (p[metric] || 0) / baseline : 0;
      return { ...p, _score: score, _scoreBasis: authorMed ? "author" : "global" };
    });
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

  const els = {};
  /** @type {{username:string,niche:string,addedAt:number,lastScrapedAt:number,scrapeIntervalHrs:number,autoCollect:boolean}[]} */
  let creators = [];
  const state = {
    sort: "outlier",
    metric: "likes",
    range: "all",
    limit: 0,
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
    hashtagFilter: null,
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
    // Sidecar transcribe (faster-whisper).
    transcribeUrl: "http://localhost:8787",
    transcribeStatus: { ok: null, msg: "", model: "", checkedAt: 0 },
    transcribeBulk: { running: false, cancel: false, done: 0, total: 0, fail: 0 },
    transcribeInflight: new Set(), // post ids being transcribed right now
    // Local LLM (Ollama). Persisted under fs:ai. No cloud, no keys.
    ai: {
      endpoint: "http://localhost:11434",
      model: "gemma4",
      visionModel: "gemma4",
      concurrency: 2,
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
  const HASH_KEYS = ["sort", "groupBy", "metric", "range", "limit", "surface", "scope", "q", "pinnedOnly", "statusFilter", "hasNote", "hasTranscript", "hashtagFilter", "hasAi", "hookTypeFilter", "topicFilter", "angleFilter"];
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
      ? ` · @${pageScope.username}`
      : pageScope.kind === "explore"
        ? " · explore"
        : "";
    els.title.textContent = `Feed Sorter · IG${suffix}`;
    if (els.reportBtn) {
      const profileScope = pageScope.kind === "profile" && !!pageScope.username;
      els.reportBtn.hidden = !profileScope;
      els.reportBtn.dataset.username = profileScope ? pageScope.username : "";
    }
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
    }
  };

  const buildUI = () => {
    if (els.root) return;
    const root = document.createElement("div");
    root.className = "fs-root";
    root.innerHTML = `
      <div class="fs-header" data-drag>
        <span class="fs-title" data-title>Feed Sorter · IG</span>
        <button class="fs-icon-btn" data-act="radar" data-radar-btn title="Outlier Radar (cross-creator)">📡</button>
        <button class="fs-icon-btn fs-signals-bell" data-act="signals" data-signals-btn title="Signals — cross-creator hook reuse" hidden>🔔<span class="fs-tab-badge" data-signals-badge hidden>0</span></button>
        <button class="fs-icon-btn" data-act="report" data-report-btn title="Generate PDF report for this profile" hidden>📄</button>
        <button class="fs-icon-btn" data-act="share" title="Copy view link">🔗</button>
        <button class="fs-icon-btn" data-act="help" title="Keyboard shortcuts (?)">?</button>
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
              <option value="outlier">Outlier score</option>
              <option value="velocity">Velocity (views/hr)</option>
              <option value="likes">Likes</option>
              <option value="views">Views</option>
              <option value="comments">Comments</option>
              <option value="cpr">CPR (comments/1k likes)</option>
              <option value="recent">Most recent</option>
            </select>
          </label>
          <label>Outlier metric
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
            </select>
          </label>
        </div>
        <div class="fs-chips" data-chips>
          <button class="fs-chip fs-chip-ai" data-chip="hookType" type="button" hidden data-hooktype-chip>hook</button>
          <button class="fs-chip fs-chip-ai" data-chip="topic" type="button" hidden data-topic-chip>topic</button>
          <button class="fs-chip fs-chip-ai" data-chip="angle" type="button" hidden data-angle-chip>angle</button>
          <button class="fs-chip fs-chip-hashtag" data-chip="hashtag" type="button" hidden data-hashtag-chip>#tag</button>
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
        <button class="fs-icon-btn" data-act="batch-download" title="Download selected videos">Download</button>
        <button class="fs-icon-btn" data-act="batch-sync" title="Sync selected to webapp">Sync</button>
        <button class="fs-icon-btn" data-act="batch-copy" title="Copy URLs to clipboard">Copy URLs</button>
        <button class="fs-icon-btn" data-act="batch-clear" title="Clear selection">Clear</button>
        <span class="fs-batch-sep"></span>
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
          </span>
        </summary>
        <div class="fs-log-panel" data-logs></div>
      </details>
      <div class="fs-footer">
        <button class="fs-icon-btn" data-act="collect">Collect all</button>
        <button class="fs-icon-btn" data-act="stop">Stop</button>
        <button class="fs-icon-btn" data-act="sync-webapp" title="Sync collected posts to the webapp">Sync to webapp</button>
        <span class="fs-bulk-status" data-sync-status hidden></span>
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
          <summary>Transcription sidecar</summary>
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
        <details class="fs-set-section">
          <summary>Local AI (Ollama)</summary>
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
        <div class="fs-set-row">
          <span>Status</span>
          <span class="fs-tx-health" data-ai-health data-level="unknown">not checked</span>
          <button class="fs-icon-btn" data-act="ai-health" title="Ping /api/tags on the configured endpoint">Check</button>
          <button class="fs-icon-btn" data-act="ai-cache-clear" title="Drop all cached LLM responses">Clear AI cache</button>
        </div>
        <div class="fs-set-info">Run <code>ollama serve</code> and <code>ollama pull gemma4</code> (or <code>gemma3</code>). Nothing leaves this machine.</div>
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
    els.nicheClusterStatus = root.querySelector('[data-niche-cluster-status]');
    els.settingsPanel = root.querySelector('[data-settings-panel]');
    els.txHealth = root.querySelector('[data-tx-health]');
    els.aiHealth = root.querySelector('[data-ai-health]');
    els.setInfo = root.querySelector('[data-set-info]');
    els.webhookStatus = root.querySelector('[data-webhook-status]');
    els.radar = root.querySelector('[data-radar]');
    els.radarList = root.querySelector('[data-radar-list]');
    els.radarSub = root.querySelector('[data-radar-sub]');
    els.radarBtn = root.querySelector('[data-radar-btn]');
    els.reportBtn = root.querySelector('[data-report-btn]');
    els.statsSection = root.querySelector('[data-stats-section]');
    els.statsBody = root.querySelector('[data-stats-body]');
    els.statsSub = root.querySelector('[data-stats-sub]');
    els.hashtagChip = root.querySelector('[data-hashtag-chip]');

    if (els.statsSection) {
      els.statsSection.open = !!state.statsSectionOpen;
      els.statsSection.addEventListener("toggle", () => {
        state.statsSectionOpen = els.statsSection.open;
        if (els.statsSection.open) renderStats();
      });
    }

    updateHeader();

    let qDebounce = null;
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
        setStatus("sync to webapp not configured yet");
        logWarn("sync.webapp.todo", { msg: "webapp endpoint not yet wired" });
      }
      if (act === "export-logs") { exportLogs().catch((err) => logError("export.logs.fail", err)); }
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
      if (act === "ai-health") { e.preventDefault(); checkAiHealth().catch((err) => logError("ai.health.fail", err)); }
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
    const swapToVideo = (link, url) => {
      link.innerHTML = `<video class="fs-thumb fs-thumb-video" src="${escHTML(url)}" autoplay muted loop playsinline preload="metadata"></video>`;
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
        if (link.querySelector("video")) restoreImg(link);
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
    const enriched = computeOutliers(sel.map((p) => {
      const d = computeDerived(p);
      const cpr = (p.comments || 0) / Math.max(p.likes || 0, 1) * 1000;
      return { ...p, ...d, velocity: d.velocityViewsPerHr, cpr };
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
          <span class="k">Velocity</span><span class="v">${p.velocityViewsPerHr ? fmt(Math.round(p.velocityViewsPerHr)) + "/hr" : "—"}</span>
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
      list = list.filter((p) => p.surface === state.surface);
    }
    if (state.audioId) {
      list = list.filter((p) => p.audio && p.audio.id === state.audioId);
    }
    const days = RANGES[state.range];
    if (days) {
      const cutoff = Date.now() / 1000 - days * 86400;
      list = list.filter((p) => p.createTime >= cutoff);
    }
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
    if (state.hasAi) list = list.filter((p) => !!(p.ai && p.ai.hook));
    if (state.hookTypeFilter) list = list.filter((p) => p.ai && p.ai.hookType === state.hookTypeFilter);
    if (state.topicFilter) list = list.filter((p) => p.ai && p.ai.topic === state.topicFilter);
    if (state.angleFilter) list = list.filter((p) => p.ai && p.ai.angle === state.angleFilter);
    // Enrich with derived fields so velocity/accelerating are available
    // to the sort, the outlier metric, the row line, and the CSV.
    list = list.map((p) => {
      const d = computeDerived(p);
      // Expose `velocity` as an alias so computeOutliers(list, "velocity")
      // reads it directly without special-casing the metric key.
      const cpr = (p.comments || 0) / Math.max(p.likes || 0, 1) * 1000;
      return { ...p, ...d, velocity: d.velocityViewsPerHr, cpr };
    });
    list = computeOutliers(list, state.metric);
    const key = state.sort;
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
      if (key === "outlier") return b._score - a._score;
      if (key === "recent") return b.createTime - a.createTime;
      if (key === "velocity") return (b.velocityViewsPerHr || 0) - (a.velocityViewsPerHr || 0);
      if (key === "cpr") return (b.cpr || 0) - (a.cpr || 0);
      if (key === "status") {
        const sa = STATUS_RANK[statusOf(a.id)] || 99;
        const sb = STATUS_RANK[statusOf(b.id)] || 99;
        if (sa !== sb) return sa - sb;
        return b._score - a._score;
      }
      if (key === "hookType" || key === "topic" || key === "angle") {
        const va = (a.ai && a.ai[key]) || "\uffff";
        const vb = (b.ai && b.ai[key]) || "\uffff";
        if (va !== vb) return va < vb ? -1 : 1;
        return (b._score || 0) - (a._score || 0);
      }
      return (b[key] || 0) - (a[key] || 0);
    });
    if (state.limit > 0) list = list.slice(0, state.limit);
    return list;
  };

  const escHTML = (s) =>
    String(s || "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

  const setStatus = (s) => {
    if (els.status) els.status.textContent = s;
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

  const renderTranscriptBlock = (p) => {
    const inflight = state.transcribeInflight.has(p.id);
    if (!p.transcript && !inflight) return "";
    if (inflight && !p.transcript) {
      return `<div class="fs-transcript fs-transcript-busy">
        <div class="fs-transcript-head">🎙️ Transcribing…</div>
      </div>`;
    }
    const segs = Array.isArray(p.transcriptSegments) ? p.transcriptSegments : [];
    const head = `<div class="fs-transcript-head">
        <span>🎙️ Transcript</span>
        ${p.transcriptLang ? `<span class="fs-transcript-lang">${escHTML(p.transcriptLang)}</span>` : ""}
        <span class="fs-transcript-meta">${(p.transcript || "").length} chars · ${segs.length} segs</span>
        <button class="fs-icon-btn fs-transcript-copy" data-act="transcript-copy" data-id="${escHTML(p.id)}" title="Copy transcript text">Copy</button>
      </div>`;
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
    if (!p.videoUrl) return { ok: false, err: "no-video-url" };
    const base = sidecarBase();
    if (!base) return { ok: false, err: "no-sidecar-url" };
    if (state.transcribeInflight.has(p.id)) return { ok: false, err: "already-running" };
    state.transcribeInflight.add(p.id);
    if (!quiet) setStatus(`transcribing ${p.shortcode || p.id}…`);
    logInfo("transcribe.start", { id: p.id, shortcode: p.shortcode, surface: p.surface });
    render();
    try {
      const r = await sendBg("transcribe", {
        sidecarUrl: base,
        videoUrl: p.videoUrl,
        id: p.id,
        shortcode: p.shortcode,
      });
      if (!r.ok || !r.body || !r.body.ok) {
        if (!quiet) setStatus(`transcribe failed: ${r.err || "see log"}`);
        logWarn("transcribe.fail", { id: p.id, err: r.err, status: r.status });
        return { ok: false, err: r.err };
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

  const TRANSCRIBE_KEY = "fs.transcribe";
  const loadTranscribeConfig = async () => {
    try {
      const r = await chrome.storage.local.get(TRANSCRIBE_KEY);
      const cfg = r && r[TRANSCRIBE_KEY];
      if (cfg && typeof cfg === "object" && cfg.url) {
        state.transcribeUrl = String(cfg.url);
      }
    } catch (e) { logWarn("transcribe.load.fail", e); }
  };
  const saveTranscribeConfig = async () => {
    try {
      await chrome.storage.local.set({ [TRANSCRIBE_KEY]: { url: state.transcribeUrl } });
      logInfo("transcribe.config.save", { url: state.transcribeUrl });
    } catch (e) { logWarn("transcribe.save.fail", e); }
  };

  // -------- Local LLM (Ollama) settings + health --------
  const AI_KEY = "fs:ai";
  const loadAiConfig = async () => {
    try {
      const r = await chrome.storage.local.get(AI_KEY);
      const cfg = r && r[AI_KEY];
      if (cfg && typeof cfg === "object") {
        state.ai = {
          endpoint: String(cfg.endpoint || state.ai.endpoint),
          model: String(cfg.model || state.ai.model),
          visionModel: String(cfg.visionModel || cfg.model || state.ai.visionModel),
          concurrency: Math.max(1, Math.min(16, Number(cfg.concurrency) || state.ai.concurrency)),
        };
      }
    } catch (e) { logWarn("ai.load.fail", e); }
  };
  const saveAiConfig = async () => {
    try {
      await chrome.storage.local.set({ [AI_KEY]: { ...state.ai } });
      logInfo("ai.config.save", { endpoint: state.ai.endpoint, model: state.ai.model, vision: state.ai.visionModel, conc: state.ai.concurrency });
    } catch (e) { logWarn("ai.save.fail", e); }
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
  const checkAiHealth = async () => {
    setAiHealth(null, "checking…");
    try {
      const body = await (window.__fsLlm
        ? window.__fsLlm.healthCheck(state.ai.endpoint)
        : Promise.reject(new Error("llm-bridge unavailable")));
      const models = (body && body.models) || [];
      const has = models.some((m) => m === state.ai.model || m.startsWith(state.ai.model + ":"));
      const note = has ? "" : ` · ${state.ai.model} not pulled`;
      setAiHealth(true, `✔ ${models.length} model${models.length === 1 ? "" : "s"}${note}`, models);
      logInfo("ai.health.ok", { models: models.length, endpoint: state.ai.endpoint, hasModel: has });
      return { ok: true, body };
    } catch (e) {
      setAiHealth(false, `✗ ${String(e && e.message || e).slice(0, 80)}`);
      logWarn("ai.health.fail", e);
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
      const merged = { ...p, cover_ai: cached };
      posts.set(p.id, merged);
      if (window.__fsStore && window.__fsStore.setPostCoverAi) {
        try { await window.__fsStore.setPostCoverAi(p.id, cached); } catch (e) { logWarn("cover.persist.fail", e, { id: p.id }); }
      }
      logInfo("cover.cached", { id: p.id });
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
      const merged = { ...p, cover_ai: coverAi };
      posts.set(p.id, merged);
      if (window.__fsStore && window.__fsStore.setPostCoverAi) {
        try { await window.__fsStore.setPostCoverAi(p.id, coverAi); }
        catch (e) { logWarn("cover.persist.fail", e, { id: p.id }); }
      }
      logInfo("cover.ok", {
        id: p.id, hasFace, faceCount: coverAi.faceCount, expr: coverAi.expression,
        textOv: hasTextOverlay, comp: coverAi.composition, color: coverAi.dominantColor,
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
    const cpr = p.cpr || 0;
    const primary =
      state.sort === "outlier"
        ? `<span class="fs-score ${p._score >= 2 ? "fs-warm" : ""}">${fmtScore(p._score)}</span>`
        : state.sort === "status"
          ? `<span class="fs-score">${meta.status ? escHTML(meta.status) : "—"}</span>`
          : state.sort === "velocity"
            ? `<span class="fs-score ${velocity > 0 ? "fs-warm" : ""}">${velocity > 0 ? fmt(Math.round(velocity)) + "/hr" : "—"}</span>`
            : state.sort === "cpr"
              ? `<span class="fs-score ${cpr >= 20 ? "fs-warm" : ""}">${cpr ? cpr.toFixed(1) : "—"}</span>`
              : `<span class="fs-score">${fmt(p[state.sort] || 0)}</span>`;
    const cprBadge = cpr > 0 ? `<span class="fs-cpr-badge" title="Comments per 1k likes">${cpr.toFixed(1)} CPR</span>` : "";
    const desc = escHTML(p.desc || "(no caption)").slice(0, 140);
    const tag = p.surface === "explore" ? " · explore" : p.isReel ? " · reel" : "";
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
    const txIcon = txInflight ? "⏳" : (txDone ? "📝" : "🎙️");
    const txTitle = txInflight
      ? "Transcribing…"
      : (txDone ? `Re-transcribe (already have ${(p.transcript || "").length} chars)` : "Transcribe via local sidecar");
    const txBtn = p.videoUrl
      ? `<button class="fs-tx-btn${txDone ? " fs-tx-done" : ""}${txInflight ? " fs-tx-busy" : ""}" data-act="transcribe" data-id="${escHTML(p.id)}" title="${escHTML(txTitle)}" ${txInflight ? "disabled" : ""}>${txIcon}</button>`
      : "";
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
    const dxBusy = state.dxInflight && state.dxInflight.has(p.id);
    const dxBlockHTML = state.expandedId === p.id
      ? renderDiagnosisBlock(p, dxBusy)
      : "";
    const expandHTML = state.expandedId === p.id
      ? `<div class="fs-row-expand" data-expand-for="${escHTML(p.id)}">
          <textarea class="fs-note-input" data-id="${escHTML(p.id)}" placeholder="Notes (autosaved)…" rows="3">${escHTML(meta.note || "")}</textarea>
          <div class="fs-tag-row">
            ${tagsHTML}
            <input class="fs-tag-input" data-id="${escHTML(p.id)}" type="text" placeholder="Add tag + Enter" autocomplete="off" />
          </div>
          ${aiBlockHTML}
          ${dxBlockHTML}
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
          <span class="fs-meta-line1">${who}${tag} · ${desc}${noteIcon}${rising ? " " + rising : ""}</span>
          <span class="fs-meta-line2">${fmt(p.likes)} ♥ · ${state.sort === "velocity" ? (velocity > 0 ? fmt(Math.round(velocity)) + "/hr" : "0/hr") : fmt(p.views)} ▶ · ${fmt(p.comments)} 💬 · ${fmtDate(p.createTime)} ${cprBadge}</span>
        </button>
      </div>
      <select class="fs-status-select" data-id="${escHTML(p.id)}" title="Status" aria-label="Status">${statusOptions}</select>
      ${primary}
      <button class="fs-pin" data-act="pin" data-id="${escHTML(p.id)}" title="${pinTitle}" aria-pressed="${meta.pinned ? "true" : "false"}">${pinIcon}</button>
      <button class="fs-dl ${dlDisabled}" data-act="download" data-id="${escHTML(p.id)}" title="${dlTitle}" ${p.videoUrl ? "" : "disabled"}>⬇</button>
      <button class="fs-dl-audio ${audioDisabled}" data-act="audio-download" data-id="${escHTML(p.id)}" title="${audioTitle}" ${audioUrl ? "" : "disabled"}>🎵</button>
      <button class="fs-ai-btn${p.ai && p.ai.hook ? " fs-ai-done" : ""}" data-act="ai-analyze" data-id="${escHTML(p.id)}" title="${p.ai && p.ai.hook ? "Re-analyze hook + topic" : "Analyze hook + topic via local LLM"}">🧠</button>
      <button class="fs-rw-btn${state.rewriteInflight.has(p.id) ? " fs-rw-busy" : ""}" data-act="rw-open" data-id="${escHTML(p.id)}" title="Repurpose for TikTok / YT Shorts / X / LinkedIn" ${state.rewriteInflight.has(p.id) ? "disabled" : ""}>✍</button>
      ${txBtn}
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
  };

  // -------- Stats sidebar (high-leverage aggregations) --------
  // Operates on the full enriched scope list (no `limit` slice) so the
  // numbers reflect the whole dataset the user has loaded, not just the
  // currently-displayed rows.
  const HASHTAG_RE = /#([\w_]+)/g;
  const statsScope = () => {
    // Mirror filtered()'s scope/surface/range/audio filters but skip the
    // `limit` slice and the search/chip/hashtag filters (so the stats
    // describe the unfiltered scope).
    let list = [...posts.values()];
    if (state.scope === "session") list = list.filter((p) => sessionIds.has(p.id));
    if (state.surface !== "all") list = list.filter((p) => p.surface === state.surface);
    const days = RANGES[state.range];
    if (days) {
      const cutoff = Date.now() / 1000 - days * 86400;
      list = list.filter((p) => p.createTime >= cutoff);
    }
    list = list.map((p) => {
      const d = computeDerived(p);
      const cpr = (p.comments || 0) / Math.max(p.likes || 0, 1) * 1000;
      return { ...p, ...d, velocity: d.velocityViewsPerHr, cpr };
    });
    list = computeOutliers(list, state.metric);
    return list;
  };

  const formatOf = (p) => {
    if (p.isReel || p.mediaType === 2) return "reel";
    if (p.mediaType === 8 || (p.carouselCount || 0) > 1) return "carousel";
    return "single";
  };

  const computeStats = (list) => {
    const formats = { reel: [], carousel: [], single: [] };
    for (const p of list) formats[formatOf(p)].push(p);
    const formatRows = ["reel", "carousel", "single"].map((f) => {
      const items = formats[f];
      const views = items.map((p) => p.views || 0).filter((x) => x > 0);
      const med = median(views);
      const outliers = items.filter((p) => (p._score || 0) >= 2).length;
      const pct = items.length ? (outliers / items.length) * 100 : 0;
      return { format: f, n: items.length, medianViews: med, outlierPct: pct };
    });

    // Hashtag lift
    const tagCounts = new Map();
    const tagScoreSum = new Map();
    let allScoreSum = 0, allN = 0;
    for (const p of list) {
      const s = p._score || 0;
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
      if ((p._score || 0) >= 2) histOut[b]++;
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
      cell[dow][hr].sum += p._score || 0;
    }

    const authors = new Set(list.map((p) => p.author).filter(Boolean));
    return {
      total: list.length,
      authors: authors.size,
      formats: formatRows,
      hashtags: topTags,
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
    if (!els.statsSection.open) {
      // still update summary subline
      if (els.statsSub) {
        els.statsSub.textContent = `${posts.size} post${posts.size === 1 ? "" : "s"} in scope`;
      }
      return;
    }
    const list = statsScope();
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
        ${s.hashtags.map((t) => `<button class="fs-stats-tag" data-act="stats-tag" data-tag="${escHTML(t.tag)}" title="${t.n} posts · mean score ${t.meanWith.toFixed(2)}x">#${escHTML(t.tag)} <span class="fs-stats-tag-lift">${fmtLift(t.lift)}</span></button>`).join("")}
      </div>` : `<div class="fs-stats-empty">No hashtags reach the n≥3 threshold.</div>`;
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
      <div class="fs-stats-block">
        <div class="fs-stats-h">LLM analysis <span class="fs-stats-hint">hook + topic via local Gemma (only score ≥1.5×)</span></div>
        <div class="fs-stats-ai-row">
          <button class="fs-icon-btn" data-act="ai-batch" data-n="10" title="Analyze top 10 outliers (score≥1.5×)">🧠 Analyze top 10</button>
          <button class="fs-icon-btn" data-act="ai-batch" data-n="25" title="Analyze top 25 outliers (score≥1.5×)">Top 25</button>
          <button class="fs-icon-btn" data-act="ai-batch" data-n="50" title="Analyze top 50 outliers (score≥1.5×)">Top 50</button>
        </div>
      </div>
      <div class="fs-stats-block">
        <div class="fs-stats-h">Hook × Topic clusters <span class="fs-stats-hint">click a row to filter</span></div>
        ${patternsBlockHTML(list)}
      </div>
      <div class="fs-stats-block">
        <div class="fs-stats-h">Outlier diagnosis <span class="fs-stats-hint">multimodal Gemma on cover · score ≥3× · sequential</span></div>
        <div class="fs-stats-ai-row">
          <button class="fs-icon-btn" data-act="dx-batch" data-n="10" title="Diagnose top 10 outliers (score≥3×) — explains WHY each beat the baseline">🔍 Diagnose top 10 outliers</button>
        </div>
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
            ? "Navigate to a profile or Explore to capture posts."
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
    rows.forEach((p, i) => {
      const au = p.audio || {};
      const lo = p.location || {};
      const me = getMetaSync(p.id) || {};
      // `rows` may be from filtered() (already enriched) or pulled raw from
      // `posts` (selectedOnly fallback path). Re-derive defensively.
      const d = (p.velocityViewsPerHr === undefined) ? computeDerived(p) : p;
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
      // Don't blow away records we already merged in this session.
      if (!posts.has(p.id)) {
        posts.set(p.id, p);
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

  // Auto-cluster trigger — fires the background pipeline. We poll cluster-meta
  // until lastRunAt advances, then refresh the panel.
  const runClusterNiches = async () => {
    const setBadge = (txt) => { if (els.nicheClusterStatus) els.nicheClusterStatus.textContent = txt; };
    setBadge("clustering…");
    setStatus("auto-clustering niches…");
    let prevAt = 0;
    try {
      const resp0 = await new Promise((res) => chrome.runtime.sendMessage({ type: "fs-bg", cmd: "cluster-meta" }, res));
      prevAt = resp0?.meta?.lastRunAt || 0;
    } catch {}
    try {
      chrome.runtime.sendMessage({ type: "fs-bg", cmd: "cluster-niches-now" }, (resp) => {
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
    loadAiConfig().catch(() => {});
    loadMeConfig().catch(() => {});
    buildUI();
    render();
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
