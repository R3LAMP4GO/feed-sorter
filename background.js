// Background service worker — auto-rescrape tracked creators.
//
// Schedule: a 10-minute chrome.alarms tick. On each tick, find at most ONE
// creator that is past its `scrapeIntervalHrs` (with ±10min jitter), open
// their profile in a hidden tab, send `start-collect` to the content script,
// wait for `collect.end`, then close the tab. This naturally enforces the
// "max 1 profile per 10 min" rate-limit.
//
// Talks to the same IndexedDB schema defined in src/store.js. We open the DB
// here directly — service workers can't use `window.__fsStore`.

const TAG = "[fs-bg]";
const log = (event, data = {}) => {
  try {
    console.log(TAG, event, JSON.stringify(data));
  } catch {
    console.log(TAG, event);
  }
};

const ALARM_NAME = "fs-rescrape-tick";
const AUDIO_ALARM = "fs-audio-recompute";
const WEEKLY_ALARM = "fs-weekly-digest";
const CLUSTER_ALARM = "fs-cluster-niches";
const TICK_MIN = 10; // 10-min granularity (max 1 profile / 10 min).
const AUDIO_TICK_MIN = 60; // hourly trending-audio recompute.
const WEEKLY_TICK_MIN = 7 * 24 * 60; // weekly digest cadence.
const CLUSTER_TICK_MIN = 60; // hourly check; only re-clusters nightly OR on >10% drift.
const CLUSTER_NIGHTLY_HR = 3; // local hour to do the unconditional nightly run.
const CLUSTER_DRIFT_RATIO = 0.10; // re-cluster early when watchlist size moves >10%.
const CLUSTER_META_KEY = "fs.cluster.meta"; // chrome.storage.local snapshot.
const JITTER_MS = 10 * 60 * 1000;
const WH_KEY = "fs.webhooks";

// Pull in shared clustering helpers (also used from content scripts and tests).
try { importScripts("src/lib/cluster.js"); } catch (e) { console.warn("[fs-bg] cluster import", e); }
const Cluster = globalThis.__fsCluster || null;
try { importScripts("src/lib/transcripts-runtime.js"); } catch (e) { console.warn("[fs-bg] transcripts import", e); }
const Transcripts = globalThis.__fsTranscripts || null;
try { importScripts("src/lib/transcribe-cloud-runtime.js"); } catch (e) { console.warn("[fs-bg] transcribe-cloud import", e); }
const TranscribeCloud = globalThis.__fsTranscribeCloud || null;
try { importScripts("src/lib/transcribe-cascade-runtime.js"); } catch (e) { console.warn("[fs-bg] transcribe-cascade import", e); }
const TranscribeCascade = globalThis.__fsTranscribeCascade || null;
try { importScripts("src/lib/niche-signal-runtime.js"); } catch (e) { console.warn("[fs-bg] niche-signal import", e); }
const NicheSignal = globalThis.__fsNicheSignal || null;
try { importScripts("src/lib/post-analysis-runtime.js"); } catch (e) { console.warn("[fs-bg] post-analysis import", e); }
const PostAnalysis = globalThis.__fsPostAnalysis || null;

// -------- raw-IDB helpers (creators store) --------
const DB_NAME = "feed-sorter";
// Must match src/store.js DB_VERSION. If this is lower than what content.js
// has migrated to, every SW open() throws VersionError and creator reads /
// writes silently fail. The SW's onupgradeneeded below only creates stores
// that don't exist — it doesn't run the data migrations that lived in
// store.js, because by the time the SW first opens the DB, content.js has
// already run those (in practice).
const DB_VERSION = 11;
const CREATOR_STORE = "creators";
const POST_STORE = "posts";
const AUDIO_STORE = "audio";
const SIGNAL_STORE = "signals";

const openDb = () =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    // Don't run upgrades from the SW — content.js owns the schema. If the
    // store is missing here, getAllCreators returns []. Best-effort only.
    // If the SW opens the DB before any content script has, we must build
    // the FULL schema (mirrors src/store.js) — otherwise content.js will
    // see v3 with only the creators store and crash on writes to posts/meta.
    req.onupgradeneeded = () => {
      try {
        const db = req.result;
        if (!db.objectStoreNames.contains("posts")) {
          const os = db.createObjectStore("posts", { keyPath: "id" });
          os.createIndex("by_author", "author");
          os.createIndex("by_createTime", "createTime");
          os.createIndex("by_surface", "surface");
          os.createIndex("by_score", "_score");
          os.createIndex("by_lastSeenAt", "lastSeenAt");
        }
        if (!db.objectStoreNames.contains("meta")) {
          const m = db.createObjectStore("meta", { keyPath: "id" });
          m.createIndex("by_pinned", "pinned");
          m.createIndex("by_status", "status");
          m.createIndex("by_updatedAt", "updatedAt");
        }
        if (!db.objectStoreNames.contains(CREATOR_STORE)) {
          const c = db.createObjectStore(CREATOR_STORE, { keyPath: "username" });
          c.createIndex("by_niche", "niche");
          c.createIndex("by_lastScrapedAt", "lastScrapedAt");
          c.createIndex("by_autoCollect", "autoCollect");
        }
        if (!db.objectStoreNames.contains(AUDIO_STORE)) {
          const a = db.createObjectStore(AUDIO_STORE, { keyPath: "id" });
          a.createIndex("by_useCount", "useCount");
          a.createIndex("by_lastSeenAt", "lastSeenAt");
          a.createIndex("by_isOriginal", "isOriginal");
        }
        if (!db.objectStoreNames.contains(SIGNAL_STORE)) {
          const s = db.createObjectStore(SIGNAL_STORE, { keyPath: "id" });
          s.createIndex("by_createdAt", "createdAt");
          s.createIndex("by_read", "read");
          s.createIndex("by_newAuthor", "newAuthor");
          s.createIndex("by_histAuthor", "histAuthor");
        }
      } catch (e) {
        log("idb.upgrade.fail", { err: String(e) });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

// Refresh the persisted tier from /v1/me. Called on api.set-token (so a
// fresh connect lights up Pro features immediately) and piggy-backed onto
// every /v1/me content-script ping. No-op when no token is set.
const refreshTierFromApi = async () => {
  const cfg = await chrome.storage.local.get(["fs.api.baseUrl", "fs.api.token"]);
  const token = cfg["fs.api.token"] || "";
  if (!token) return;
  const baseUrl = cfg["fs.api.baseUrl"] || "https://api.feedsorter.app";
  const res = await fetch(baseUrl + "/v1/me", {
    method: "GET",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + token,
    },
    credentials: "include",
  });
  if (!res.ok) return;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (json && typeof json.tier === "string") {
    await chrome.storage.local.set({ "fs.api.tier": json.tier });
    log("api.tier.persist", { tier: json.tier });
  }
};

const getAllCreators = async () => {
  try {
    const db = await openDb();
    if (!db.objectStoreNames.contains(CREATOR_STORE)) return [];
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(CREATOR_STORE, "readonly");
      const os = tx.objectStore(CREATOR_STORE);
      const r = os.getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
  } catch (e) {
    log("creators.read.fail", { err: String(e) });
    return [];
  }
};

const touchScraped = async (username, t = Date.now()) => {
  try {
    const db = await openDb();
    if (!db.objectStoreNames.contains(CREATOR_STORE)) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CREATOR_STORE, "readwrite");
      const os = tx.objectStore(CREATOR_STORE);
      const r = os.get(username);
      r.onsuccess = () => {
        const cur = r.result;
        if (!cur) return resolve();
        cur.lastScrapedAt = t;
        const w = os.put(cur);
        w.onsuccess = () => resolve();
        w.onerror = () => reject(w.error);
      };
      r.onerror = () => reject(r.error);
    });
  } catch (e) {
    log("creators.touch.fail", { err: String(e) });
  }
};

// -------- scheduling --------
const isStale = (c, now = Date.now()) => {
  if (!c || !c.autoCollect) return false;
  const intervalMs = (c.scrapeIntervalHrs || 24) * 3600 * 1000;
  // Deterministic per-creator jitter so the same creator isn't always
  // running early/late within the same hour.
  const seed = [...c.username].reduce((a, ch) => a + ch.charCodeAt(0), 0);
  const jitter = ((seed * 37) % (2 * JITTER_MS)) - JITTER_MS; // [-10m, +10m)
  return now - (c.lastScrapedAt || 0) > intervalMs + jitter;
};

const pickNext = async () => {
  const all = await getAllCreators();
  const now = Date.now();
  const stale = all.filter((c) => isStale(c, now));
  if (!stale.length) return null;
  // Prefer the most-overdue (smallest lastScrapedAt; 0 = never scraped).
  stale.sort((a, b) => (a.lastScrapedAt || 0) - (b.lastScrapedAt || 0));
  return stale[0];
};

// Wait until the content script in `tabId` reports the overlay is up.
const waitForReady = (tabId, timeoutMs = 30000) =>
  new Promise((resolve) => {
    const t0 = Date.now();
    const tick = async () => {
      try {
        const r = await chrome.tabs.sendMessage(tabId, { type: "fs-bg", cmd: "ping" });
        if (r && r.ok) return resolve(true);
      } catch {}
      if (Date.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(tick, 750);
    };
    tick();
  });

// One-shot: wait for a `collect.end` message from `tabId`.
const waitForCollectEnd = (tabId, timeoutMs = 6 * 60 * 1000) =>
  new Promise((resolve) => {
    const onMsg = (msg, sender) => {
      if (!msg || msg.type !== "fs-bg" || msg.event !== "collect.end") return;
      if (sender.tab?.id !== tabId) return;
      chrome.runtime.onMessage.removeListener(onMsg);
      resolve(msg);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    setTimeout(() => {
      chrome.runtime.onMessage.removeListener(onMsg);
      resolve(null);
    }, timeoutMs);
  });

let busy = false;

const scrapeOne = async (creator) => {
  if (busy) {
    log("scrape.skip", { reason: "busy", username: creator.username });
    return;
  }
  busy = true;
  // Pick the platform per creator row; legacy rows that pre-date the
  // platform field default to Instagram (single-platform world).
  const platform = creator.platform === "tiktok" ? "tiktok" : "instagram";
  const url = platform === "tiktok"
    ? `https://www.tiktok.com/@${creator.username}`
    : `https://www.instagram.com/${creator.username}/`;
  log("scrape.open", { username: creator.username, platform, url });
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ active: false, url });
    tabId = tab.id;
    const ready = await waitForReady(tabId);
    if (!ready) {
      log("scrape.timeout.ready", { username: creator.username });
      return;
    }
    log("scrape.start", { username: creator.username, tabId });
    const endP = waitForCollectEnd(tabId);
    try {
      await chrome.tabs.sendMessage(tabId, { type: "fs-bg", cmd: "start-collect" });
    } catch (e) {
      log("scrape.send.fail", { err: String(e), username: creator.username });
    }
    const end = await endP;
    log("scrape.end", { username: creator.username, end: end?.payload || null });
    await touchScraped(creator.username);
  } catch (e) {
    log("scrape.fail", { err: String(e), username: creator.username });
  } finally {
    if (tabId != null) {
      try { await chrome.tabs.remove(tabId); } catch {}
    }
    busy = false;
  }
};

const tick = async () => {
  try {
    const next = await pickNext();
    if (!next) {
      log("tick.idle");
      return;
    }
    await scrapeOne(next);
  } catch (e) {
    log("tick.fail", { err: String(e) });
  }
};

const ensureAlarm = async () => {
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: TICK_MIN,
      delayInMinutes: 1,
    });
    log("alarm.create", { name: ALARM_NAME, periodMin: TICK_MIN });
  }
  const audioExisting = await chrome.alarms.get(AUDIO_ALARM);
  if (!audioExisting) {
    await chrome.alarms.create(AUDIO_ALARM, {
      periodInMinutes: AUDIO_TICK_MIN,
      delayInMinutes: 2,
    });
    log("alarm.create", { name: AUDIO_ALARM, periodMin: AUDIO_TICK_MIN });
  }
  const clusterExisting = await chrome.alarms.get(CLUSTER_ALARM);
  if (!clusterExisting) {
    await chrome.alarms.create(CLUSTER_ALARM, {
      periodInMinutes: CLUSTER_TICK_MIN,
      delayInMinutes: 3,
    });
    log("alarm.create", { name: CLUSTER_ALARM, periodMin: CLUSTER_TICK_MIN });
  }
  const weeklyExisting = await chrome.alarms.get(WEEKLY_ALARM);
  if (!weeklyExisting) {
    await chrome.alarms.create(WEEKLY_ALARM, {
      periodInMinutes: WEEKLY_TICK_MIN,
      // First fire 5 min after install so users see *something* without
      // waiting a week. Subsequent fires honor the 7-day period.
      delayInMinutes: 5,
    });
    log("alarm.create", { name: WEEKLY_ALARM, periodMin: WEEKLY_TICK_MIN });
  }
};

// -------- webhook helpers --------
const getWebhookConfig = async () => {
  try {
    const r = await chrome.storage.local.get(WH_KEY);
    const cfg = r && r[WH_KEY];
    return {
      generic: String(cfg?.generic || ""),
      slack: String(cfg?.slack || ""),
      discord: String(cfg?.discord || ""),
      autoOnCollect: !!cfg?.autoOnCollect,
    };
  } catch (e) {
    log("webhook.cfg.fail", { err: String(e) });
    return { generic: "", slack: "", discord: "", autoOnCollect: false };
  }
};

const doWebhookPost = async (url, body) => {
  if (!url) return { ok: false, status: 0, err: "no-url" };
  try {
    const r = await fetch(url, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, status: 0, err: String(e?.message || e) };
  }
};

// Generic HTTP relay used by src/sinks/*. Supports custom method+headers and
// returns the raw response text + parsed JSON so sinks can surface API errors
// (Airtable / Notion both put structured errors in the JSON body).
const doSinkPost = async ({ url, method = "POST", headers = {}, body = null }) => {
  if (!url) return { ok: false, status: 0, err: "no-url" };
  try {
    const init = {
      method,
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "application/json", ...headers },
    };
    if (body != null && method !== "GET" && method !== "HEAD") {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    const r = await fetch(url, init);
    const text = await r.text().catch(() => "");
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    const retryAfter = r.headers && r.headers.get ? r.headers.get("retry-after") : null;
    return { ok: r.ok, status: r.status, text, json, retryAfter };
  } catch (e) {
    return { ok: false, status: 0, err: String(e?.message || e) };
  }
};

// -------- weekly digest --------
const medianN = (xs) => {
  if (!xs || !xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Best-effort canonical post URL when the row didn't get one at parse time.
// Reads `platform` from the post (added by the runtime parser); falls back
// to Instagram for legacy rows.
const postUrlForRow = (p) => {
  if (!p) return "";
  const platform = p.platform === "tiktok" ? "tiktok" : "instagram";
  if (platform === "tiktok") {
    const native = String(p.nativeId || p.shortcode || (p.id || "").replace(/^tt_/, ""));
    if (!native || !p.author) return "";
    return `https://www.tiktok.com/@${p.author}/video/${native}`;
  }
  if (!p.shortcode) return "";
  return `https://www.instagram.com/${p.surface === "reels" ? "reel" : "p"}/${p.shortcode}/`;
};

const computeWeeklyDigest = async (limit = 10) => {
  const creators = await getAllCreators();
  if (!creators.length) return { rows: [], creators: 0 };
  const tracked = new Set(creators.map((c) => String(c.username).toLowerCase()));
  const posts = await getAllFromStore(POST_STORE);
  // Per-author baseline using full history.
  const byAuthor = new Map();
  for (const p of posts) {
    if (!p || !p.author) continue;
    const v = Number(p.likes || 0);
    if (!(v > 0)) continue;
    const k = String(p.author).toLowerCase();
    if (!byAuthor.has(k)) byAuthor.set(k, []);
    byAuthor.get(k).push(v);
  }
  const meds = new Map();
  for (const [k, vals] of byAuthor) meds.set(k, medianN(vals));
  const cutoff = Date.now() / 1000 - 7 * 86400;
  const scored = [];
  for (const p of posts) {
    if (!p || !p.author) continue;
    const k = String(p.author).toLowerCase();
    if (!tracked.has(k)) continue;
    if ((p.createTime || 0) < cutoff) continue;
    const base = meds.get(k) || 0;
    const score = base > 0 ? (p.likes || 0) / base : 0;
    if (score <= 0) continue;
    scored.push({
      id: p.id,
      shortcode: p.shortcode || "",
      author: p.author,
      desc: (p.desc || "").slice(0, 300),
      createTime: p.createTime || 0,
      likes: p.likes || 0,
      views: p.views || 0,
      comments: p.comments || 0,
      score,
      url: p.url || postUrlForRow(p),
      cover: p.cover || "",
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return { rows: scored.slice(0, limit), creators: creators.length };
};

const slackBlocks = (rows, title) => {
  const blocks = [
    { type: "header", text: { type: "plain_text", text: title } },
    { type: "context", elements: [{ type: "mrkdwn", text: `_Feed Sorter weekly digest · ${new Date().toLocaleDateString()}_` }] },
    { type: "divider" },
  ];
  rows.forEach((p, i) => {
    const score = Number(p.score || 0).toFixed(2);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*${i + 1}. <${p.url || "#"}|@${p.author}>*  · ${score}× · ❤ ${p.likes} · ▶ ${p.views} · 💬 ${p.comments}\n${(p.desc || "").slice(0, 200)}` },
      accessory: p.cover ? { type: "image", image_url: p.cover, alt_text: `@${p.author}` } : undefined,
    });
  });
  return { text: title, blocks };
};
const discordEmbeds = (rows, title) => ({
  content: title,
  embeds: rows.map((p, i) => ({
    title: `${i + 1}. @${p.author} · ${Number(p.score || 0).toFixed(2)}×`,
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

const sendWeeklyDigest = async () => {
  const cfg = await getWebhookConfig();
  if (!cfg.generic && !cfg.slack && !cfg.discord) {
    log("weekly.skip", { reason: "no-webhooks" });
    return;
  }
  const { rows, creators } = await computeWeeklyDigest(10);
  if (!rows.length) {
    log("weekly.skip", { reason: "no-rows", creators });
    return;
  }
  const title = `Top ${rows.length} outliers this week (${creators} creators)`;
  const generatedAt = new Date().toISOString();
  const results = [];
  if (cfg.generic) {
    const r = await doWebhookPost(cfg.generic, {
      source: "feed-sorter-ig",
      version: "weekly-digest",
      generatedAt,
      window: { days: 7 },
      creators,
      posts: rows,
    });
    results.push({ kind: "generic", ...r });
  }
  if (cfg.slack) {
    const r = await doWebhookPost(cfg.slack, slackBlocks(rows, title));
    results.push({ kind: "slack", ...r });
  }
  if (cfg.discord) {
    const r = await doWebhookPost(cfg.discord, discordEmbeds(rows, title));
    results.push({ kind: "discord", ...r });
  }
  log("weekly.sent", { rows: rows.length, creators, results });
};

// Test hook: expose for sw.evaluate-based e2e tests. Production callers
// reach this via the WEEKLY_ALARM or `cmd: webhook-weekly-now` message.
globalThis.__fsWeeklyDigest = sendWeeklyDigest;

// -------- audio recompute --------
const median = (xs) => {
  if (!xs || !xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Map an IDB post row → POST /v1/posts/sync schema. Pure.
// Returns null when the row is missing required fields.
const SYNC_PLATFORMS = new Set(["instagram", "tiktok", "youtube"]);
const SCOPE_FROM_SURFACE = {
  profile: "profile",
  reels: "profile",
  graphql: "profile",
  explore: "explore",
  foryou: "foryou",
  related: "foryou",
  "shorts-feed": "shorts-feed",
  search: "search",
};
// IG parser (src/lib/parser.js) does not set `platform` on the row; the id
// is namespaced with `ig_` / `tt_` / `yt_` so we can infer.
const PLATFORM_BY_PREFIX = { ig: "instagram", tt: "tiktok", yt: "youtube" };
const inferPlatform = (p) => {
  if (p && SYNC_PLATFORMS.has(p.platform)) return p.platform;
  const m = String(p && p.id || "").match(/^([a-z]+)_/);
  return m ? PLATFORM_BY_PREFIX[m[1]] || null : null;
};
// Pull the AI-extracted hook off the row, tolerating both the legacy shape
// (a plain string written by content.js's analyzePost) and the richer object
// shape `{ text, label }` that the server / future pipeline writers use. The
// website Library page only cares about the human-readable hook text.
const extractHook = (ai) => {
  if (!ai) return null;
  const h = ai.hook;
  if (typeof h === "string") return h || null;
  if (h && typeof h === "object") {
    if (typeof h.text === "string" && h.text) return h.text;
    if (typeof h.label === "string" && h.label) return h.label;
  }
  return null;
};

// Build the optional `transcript` sub-object from the flat row fields written
// by setPostTranscript() in src/store.js. We don't have a separate transcripts
// IDB store in the extension — the text / segments / source live directly on
// the post row alongside the metric counters. Returns undefined when no
// transcript has been captured yet, so the field is omitted from the wire
// payload (the server side is permissive on missing fields).
const extractTranscript = (p) => {
  const text = typeof p.transcript === "string" ? p.transcript : "";
  const segments = Array.isArray(p.transcriptSegments) ? p.transcriptSegments : null;
  if (!text && !(segments && segments.length)) return undefined;
  const source = typeof p.transcriptSource === "string" && p.transcriptSource
    ? p.transcriptSource
    : undefined;
  const out = { text };
  if (segments && segments.length) out.segments = segments;
  if (source) out.source = source;
  return out;
};

// Pick the single argmax label out of a scoreFormats() map. Returns undefined
// when the map is empty (every label fell below the 0.15 noise floor) so the
// legacy `format` field stays omitted rather than carrying a misleading
// "other".
const argmaxFormat = (scores) => {
  if (!scores || typeof scores !== "object") return undefined;
  let best, bestVal = 0;
  for (const k of Object.keys(scores)) {
    const v = Number(scores[k]) || 0;
    if (v > bestVal) { bestVal = v; best = k; }
  }
  return best;
};

// `creatorNicheMap` is an optional Map<usernameLower, niche> built from the
// CREATOR_STORE before a sync batch. When present, each post inherits the
// niche label its creator was assigned by the clusterNiches() pipeline. The
// niche is denormalized onto the post itself (so the website Library doesn't
// need a creator join) AND added to the creator sub-object.
const toSyncPost = (p, creatorNicheMap) => {
  if (!p || !p.id) return null;
  const platform = inferPlatform(p);
  if (!platform) return null;
  const nativeId = String(p.nativeId || p.shortcode || p.id.replace(/^[a-z]+_/, ""));
  const scope = SCOPE_FROM_SURFACE[p.surface] || "profile";
  const postedAt = Number.isFinite(p.createTime) && p.createTime > 0
    ? new Date(p.createTime * (p.createTime > 1e12 ? 1 : 1000)).toISOString()
    : null;
  const usernameLower = p.author ? String(p.author).toLowerCase() : null;
  // Niche resolution order: post.niche (set by post-level cluster pipeline) →
  // creatorNicheMap (set by creator-level clusterNiches) → undefined.
  let niche;
  if (typeof p.niche === "string" && p.niche) niche = p.niche;
  else if (usernameLower && creatorNicheMap && creatorNicheMap.get) {
    const fromCreator = creatorNicheMap.get(usernameLower);
    if (typeof fromCreator === "string" && fromCreator) niche = fromCreator;
  }

  // Format classification: multi-label confidence map + argmax. The runtime
  // mirror at src/lib/post-analysis-runtime.js exposes scoreFormats() so the
  // SW can compute this without an ESM import. If the runtime didn't load
  // (rare — importScripts failed) we leave both fields undefined and let the
  // server compute on its end.
  const scoreFormats = PostAnalysis && typeof PostAnalysis.scoreFormats === "function"
    ? PostAnalysis.scoreFormats
    : null;
  let formatScores;
  let format;
  if (scoreFormats) {
    const scores = scoreFormats(p);
    if (scores && Object.keys(scores).length) {
      formatScores = scores;
      format = argmaxFormat(scores);
    }
  }
  // Fall back to the cached row-level format label when scoring produced
  // nothing (e.g. empty caption + no transcript). Preserves what the
  // post-level cluster pipeline / setPostFormat wrote.
  if (!format && typeof p.format === "string" && p.format) format = p.format;

  const ai = p.ai && typeof p.ai === "object" ? p.ai : null;
  const hook = extractHook(ai);
  const cta = (ai && ai.cta) ? ai.cta : null;
  const pacing = (ai && ai.pacing) ? ai.pacing : null;
  const coverAnalysis = p.cover_ai || null;
  const diagnosis = p.diagnosis || null;
  const transcript = extractTranscript(p);
  const outlierScore = Number.isFinite(p._score) && p._score > 0 ? p._score : undefined;
  const velocity = Number.isFinite(p.velocity) ? p.velocity : undefined;
  const nicheBasis = typeof p.nicheBasis === "string" && p.nicheBasis ? p.nicheBasis : undefined;
  const videoUrl = typeof p.videoUrl === "string" && p.videoUrl ? p.videoUrl : undefined;

  return {
    id: p.id,
    platform,
    nativeId,
    creator: usernameLower ? {
      platform: p.platform,
      username: usernameLower,
      displayName: p.authorFullName || undefined,
      followerCount: Number.isFinite(p.authorFollowers) ? p.authorFollowers : undefined,
      niche: niche || undefined,
    } : undefined,
    postedAt,
    views: Number.isFinite(p.views) ? p.views : undefined,
    likes: Number.isFinite(p.likes) ? p.likes : undefined,
    comments: Number.isFinite(p.comments) ? p.comments : undefined,
    shares: Number.isFinite(p.shares) ? p.shares : undefined,
    coverUrl: typeof p.cover === "string" ? p.cover : undefined,
    durationS: Number.isFinite(p.durationSec) ? Math.round(p.durationSec) : undefined,
    caption: typeof p.desc === "string" ? p.desc : undefined,
    scope,
    niche: niche || undefined,
    // New optional fields for the website Library page (Hook / Format /
    // Outlier / Velocity / CTA columns + click-to-open transcript drawer).
    // All omitted when absent — the server side is permissive.
    formatScores,
    format,
    nicheBasis,
    hook: hook || undefined,
    cta: cta || undefined,
    pacing: pacing || undefined,
    coverAnalysis: coverAnalysis || undefined,
    outlierScore,
    diagnosis: diagnosis || undefined,
    velocity,
    transcript,
    videoUrl,
  };
};

// Build username→niche lookup from the CREATOR_STORE. Used by the sync
// handler so every post in a batch picks up its creator's clustered niche
// without an N+1 IDB read.
const buildCreatorNicheMap = async () => {
  const map = new Map();
  try {
    const creators = await getAllCreators();
    for (const c of creators) {
      if (!c || !c.username) continue;
      const u = String(c.username).toLowerCase();
      const n = typeof c.niche === "string" ? c.niche.trim() : "";
      if (n) map.set(u, n);
    }
  } catch (e) {
    log("sync.creator-niche-map.fail", { err: String(e) });
  }
  return map;
};

const getAllFromStore = async (storeName) => {
  try {
    const db = await openDb();
    if (!db.objectStoreNames.contains(storeName)) return [];
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readonly");
      const r = tx.objectStore(storeName).getAll();
      r.onsuccess = () => resolve(r.result || []);
      r.onerror = () => reject(r.error);
    });
  } catch (e) {
    log("idb.getall.fail", { store: storeName, err: String(e) });
    return [];
  }
};

const putAudioRows = async (rows) => {
  if (!rows.length) return;
  try {
    const db = await openDb();
    if (!db.objectStoreNames.contains(AUDIO_STORE)) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(AUDIO_STORE, "readwrite");
      const os = tx.objectStore(AUDIO_STORE);
      let pending = rows.length;
      let failed = false;
      for (const r of rows) {
        const w = os.put(r);
        w.onsuccess = () => { if (--pending === 0 && !failed) resolve(); };
        w.onerror = () => { failed = true; reject(w.error); };
      }
      tx.onerror = () => { failed = true; reject(tx.error); };
    });
  } catch (e) {
    log("audio.put.fail", { err: String(e) });
  }
};

const recomputeAudio = async () => {
  const audios = await getAllFromStore(AUDIO_STORE);
  if (!audios.length) {
    log("audio.recompute.idle");
    return;
  }
  const posts = await getAllFromStore(POST_STORE);
  const postById = new Map();
  for (const p of posts) if (p && p.id) postById.set(String(p.id), p);

  // Per-author baseline (median likes among posts with likes>0).
  const byAuthor = new Map();
  for (const p of posts) {
    if (!p || !p.author) continue;
    const v = Number(p.likes || 0);
    if (!(v > 0)) continue;
    const k = String(p.author).toLowerCase();
    if (!byAuthor.has(k)) byAuthor.set(k, []);
    byAuthor.get(k).push(v);
  }
  const authorMed = new Map();
  for (const [k, vals] of byAuthor) authorMed.set(k, median(vals));
  const globalMed = median(posts.map((p) => Number(p?.likes || 0)).filter((v) => v > 0));

  const nowSec = Date.now() / 1000;
  const WEEK = 7 * 86400;
  const updated = [];
  for (const a of audios) {
    if (!a || !a.id) continue;
    const ids = Array.isArray(a.posts) ? a.posts : [];
    const scores = [];
    let last7 = 0, prev7 = 0;
    for (const id of ids) {
      const p = postById.get(String(id));
      if (!p) continue;
      const ak = String(p.author || "").toLowerCase();
      const base = authorMed.get(ak) || globalMed;
      const v = Number(p.likes || 0);
      const score = base > 0 ? v / base : 0;
      if (score > 0) scores.push(score);
      const ct = Number(p.createTime || 0);
      if (ct > 0) {
        const age = nowSec - ct;
        if (age <= WEEK) last7++;
        else if (age <= 2 * WEEK) prev7++;
      }
    }
    const medianOutlier = median(scores);
    // Smooth zeros: if prev7 is 0 we use 1 to avoid Infinity. last7=0 → 0.
    const weeklyUseGrowth = last7 === 0 ? 0 : last7 / Math.max(prev7, 1);
    updated.push({ ...a, medianOutlier, weeklyUseGrowth });
  }
  await putAudioRows(updated);
  log("audio.recompute.done", { audios: audios.length, posts: posts.length, updated: updated.length });
};

// -------- niche auto-clustering --------
const OFFSCREEN_URL = "offscreen.html";

const hasOffscreen = async () => {
  try {
    if (chrome.offscreen && typeof chrome.offscreen.hasDocument === "function") {
      return await chrome.offscreen.hasDocument();
    }
  } catch {}
  // Fallback: check matching contexts.
  try {
    const ctxs = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
    });
    return ctxs && ctxs.length > 0;
  } catch { return false; }
};

const ensureOffscreen = async () => {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ["WORKERS"],
    justification: "Run MiniLM embedding model for niche clustering.",
  });
  log("offscreen.create");
};

const closeOffscreen = async () => {
  try {
    if (await hasOffscreen()) {
      await chrome.offscreen.closeDocument();
      log("offscreen.close");
    }
  } catch (e) { log("offscreen.close.fail", { err: String(e) }); }
};

const sendOffscreen = (cmd, payload = {}) =>
  new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "fs-offscreen", cmd, ...payload }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (!resp) return reject(new Error("empty-response"));
      if (!resp.ok) return reject(new Error(resp.err || "offscreen-error"));
      resolve(resp);
    });
  });

const embedViaOffscreen = async (texts) => {
  if (!texts || !texts.length) return [];
  await ensureOffscreen();
  // Batch to keep memory bounded; MiniLM handles ~32 inputs per call comfortably.
  const BATCH = 16;
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const slice = texts.slice(i, i + BATCH);
    const r = await sendOffscreen("embed", { id: i, texts: slice });
    out.push(...r.vectors);
  }
  return out;
};

const putCreatorRow = async (row) => {
  const db = await openDb();
  if (!db.objectStoreNames.contains(CREATOR_STORE)) return null;
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(CREATOR_STORE, "readwrite");
    const os = tx.objectStore(CREATOR_STORE);
    const w = os.put(row);
    w.onsuccess = () => resolve(row);
    w.onerror = () => reject(w.error);
  });
};

let clusterBusy = false;

const clusterNiches = async (opts = {}) => {
  if (!Cluster) {
    log("cluster.skip", { reason: "no-cluster-lib" });
    return { ok: false, err: "cluster lib missing" };
  }
  if (clusterBusy) {
    log("cluster.skip", { reason: "busy" });
    return { ok: false, err: "busy" };
  }
  clusterBusy = true;
  const t0 = Date.now();
  // Auto-populate threshold: any post-author with at least this many rows
  // is treated as a tracked creator for clustering. Set to 1 because Explore-
  // page firehose libraries have most creators at exactly 1 post each — a
  // higher threshold makes the pipeline silently bail with too-few-creators.
  // Single-post creators may produce noisy embeddings, but MiniLM handles
  // short captions better than TF-IDF, and one-shot creators with empty
  // captions get correctly bucketed as "unlabeled" by clusterCreators().
  const AUTO_CREATOR_MIN_POSTS = 1;
  try {
    // Posts may live in either:
    //   (a) the SW's extension-origin IDB (POST_STORE), populated by some
    //       legacy sync paths, OR
    //   (b) the content-script's page-origin IDB, populated by every live
    //       capture in content.js. The SW cannot read (b) directly — that's
    //       a different IDB origin. So callers may pass posts via
    //       opts.posts, mirroring the api.sync-posts handler's pattern.
    const passedPosts = Array.isArray(opts && opts.posts) ? opts.posts : null;
    const posts = passedPosts && passedPosts.length
      ? passedPosts
      : await getAllFromStore(POST_STORE);
    const byAuthor = new Map();
    let postsWithAuthor = 0;
    for (const p of posts) {
      if (!p || !p.author) continue;
      postsWithAuthor++;
      const k = String(p.author).toLowerCase();
      if (!byAuthor.has(k)) byAuthor.set(k, []);
      byAuthor.get(k).push(p);
    }
    const eligibleAuthors = [...byAuthor.values()].filter((rs) => rs.length >= AUTO_CREATOR_MIN_POSTS).length;
    log("cluster.idb-stats", {
      totalPosts: posts.length,
      postsWithAuthor,
      uniqueAuthors: byAuthor.size,
      eligibleAuthors,
      threshold: AUTO_CREATOR_MIN_POSTS,
    });

    // Prefer caller-injected creators (content.js can read the page-origin
    // IDB; the SW often can't if content.js has migrated the schema past
    // the SW's openDb version). Falls back to the SW's getAllCreators for
    // alarm-triggered runs.
    const passedCreators = Array.isArray(opts && opts.creators) ? opts.creators : null;
    let creators = (passedCreators && passedCreators.length)
      ? passedCreators.slice()
      : await getAllCreators();
    if (passedCreators && passedCreators.length) {
      log("cluster.creators.from-content", { count: creators.length });
    }
    const tracked = new Set(creators.map((c) => String(c.username || "").toLowerCase()).filter(Boolean));
    let autoAdded = 0;
    let autoSkippedTracked = 0;
    let autoFailed = 0;
    const tNow = Date.now();
    for (const [username, rows] of byAuthor) {
      if (rows.length < AUTO_CREATOR_MIN_POSTS) continue;
      if (tracked.has(username)) { autoSkippedTracked++; continue; }
      const row = {
        username,
        addedAt: tNow,
        addedBy: "auto-cluster",
        lastScrapedAt: 0,
        scrapeIntervalHrs: 0,
        autoCollect: false,
        niche: "",
        nichePinned: false,
      };
      try { await putCreatorRow(row); autoAdded++; tracked.add(username); }
      catch (e) { autoFailed++; log("cluster.auto-add.fail", { username, err: String(e?.message || e) }); }
    }
    log("cluster.auto-add.summary", {
      added: autoAdded,
      skippedAlreadyTracked: autoSkippedTracked,
      failed: autoFailed,
      preTrackedCount: creators.length,
    });
    if (autoAdded) creators = await getAllCreators();

    if (creators.length < 2) {
      log("cluster.skip", {
        reason: "too-few-creators",
        n: creators.length,
        eligibleByThreshold: eligibleAuthors,
        // If eligibleAuthors > 0 but creators.length < 2, putCreatorRow is the problem.
        // If eligibleAuthors === 0, the IDB just doesn't have enough volume —
        // lower AUTO_CREATOR_MIN_POSTS, or scrape more posts per creator.
      });
      await chrome.storage.local.set({ [CLUSTER_META_KEY]: { lastRunAt: Date.now(), creatorCount: creators.length, clusters: [] } });
      return { ok: true, clusters: [], reason: "too-few-creators", debug: { totalPosts: posts.length, uniqueAuthors: byAuthor.size, eligibleAuthors } };
    }
    log("cluster.embed.start", { creators: creators.length, posts: posts.length });
    // Per-creator embedding-source pick: bio → captions+hook (top-N outliers)
    // → tags → none. Bio almost always names the vertical directly ("Real
    // Estate Agent in SF") while captions for talking-head/sales/advice
    // creators often sound generic. Logged per creator so we can audit
    // which source fired and how rich it was. See src/lib/niche-signal.js.
    let creatorVecs;
    const signalBreakdown = { bio: 0, captions: 0, tags: 0, none: 0 };
    if (NicheSignal && typeof NicheSignal.pickNicheSignal === "function") {
      const inputs = [];
      for (const c of creators) {
        const u = String(c.username || "").toLowerCase();
        const cPosts = byAuthor.get(u) || [];
        const sig = NicheSignal.pickNicheSignal(c, cPosts);
        signalBreakdown[sig.source] = (signalBreakdown[sig.source] || 0) + 1;
        const sampleTokens = (sig.text.toLowerCase().match(/[a-z]{4,}/g) || []).slice(0, 3);
        log("cluster.signal", {
          username: u,
          source: sig.source,
          wordCount: sig.wordCount,
          bioWords: sig.debug.bioWords,
          captionPosts: sig.debug.captionPosts,
          captionWords: sig.debug.captionWords,
          tagCount: sig.debug.tagCount,
          pinned: sig.debug.pinned,
          pinnedLabel: sig.debug.pinnedLabel,
          top3: sampleTokens.join(","),
        });
        inputs.push({ username: u, texts: sig.source === "none" ? [] : [sig.text], source: sig.source });
      }
      log("cluster.signal.summary", signalBreakdown);
      // Flatten + embed in one batched call (same shape as Cluster.buildCreatorVectors).
      const flat = [];
      const offsets = [];
      for (const inp of inputs) {
        offsets.push(flat.length);
        for (const t of inp.texts) flat.push(t);
      }
      let vectors = [];
      if (flat.length) vectors = await embedViaOffscreen(flat);
      creatorVecs = [];
      for (let i = 0; i < inputs.length; i++) {
        const start = offsets[i];
        const end = (i + 1 < inputs.length ? offsets[i + 1] : flat.length);
        const vecs = vectors.slice(start, end).map((v) => Cluster.normalize(new Float32Array(v)));
        const mean = vecs.length ? Cluster.meanVec(vecs) : null;
        creatorVecs.push({
          username: inputs[i].username,
          vector: mean,
          captions: inputs[i].texts, // feeds tf-idf labeling — bio text works as a label corpus too
          source: inputs[i].source,
        });
      }
    } else {
      // Fallback path: niche-signal runtime didn't load (rare — importScripts
      // failure). Use the legacy captions-only embed.
      log("cluster.signal.unavailable", { reason: "niche-signal-runtime not loaded" });
      creatorVecs = await Cluster.buildCreatorVectors(creators, byAuthor, embedViaOffscreen, 20);
    }
    const groups = Cluster.clusterCreators(creatorVecs, opts.simThreshold ?? 0.65);
    log("cluster.groups", { n: groups.length, sizes: groups.map((g) => g.members.length), labels: groups.map((g) => g.label) });

    // Persist embedding per creator + assign auto-niche (respecting pinned).
    const vecByUser = new Map(creatorVecs.map((c) => [c.username, c.vector]));
    const labelByUser = new Map();
    for (const g of groups) for (const u of g.members) labelByUser.set(u, g.label);
    const now = Date.now();
    for (const c of creators) {
      const u = c.username;
      const v = vecByUser.get(u);
      const label = labelByUser.get(u) || "";
      const next = { ...c };
      if (v) {
        next.embedding = Cluster.f32ToB64(v);
        next.embeddingAt = now;
      }
      // Auto-overwrite niche unless user pinned it.
      if (!c.nichePinned) next.niche = label;
      // Always normalize the new fields.
      if (typeof next.nichePinned !== "boolean") next.nichePinned = false;
      await putCreatorRow(next);
    }

    const meta = {
      lastRunAt: now,
      creatorCount: creators.length,
      clusters: groups.map((g) => ({ label: g.label, members: g.members })),
      ms: Date.now() - t0,
    };
    await chrome.storage.local.set({ [CLUSTER_META_KEY]: meta });
    log("cluster.done", { ms: meta.ms, clusters: groups.length, signalBreakdown });
    return { ok: true, clusters: groups, ms: meta.ms, signalBreakdown };
  } catch (e) {
    log("cluster.fail", { err: String(e?.message || e) });
    return { ok: false, err: String(e?.message || e) };
  } finally {
    clusterBusy = false;
    // Tear down offscreen so we release ~100MB of model weights.
    closeOffscreen();
  }
};

const maybeClusterTick = async () => {
  try {
    const r = await chrome.storage.local.get(CLUSTER_META_KEY);
    const meta = r && r[CLUSTER_META_KEY];
    const all = await getAllCreators();
    const now = Date.now();
    const lastRunAt = meta?.lastRunAt || 0;
    const ageMs = now - lastRunAt;
    const lastN = meta?.creatorCount || 0;
    const drift = lastN > 0 ? Math.abs(all.length - lastN) / lastN : (all.length >= 2 ? 1 : 0);
    const localHour = new Date(now).getHours();
    const overdueNightly = ageMs > 23 * 3600 * 1000 && localHour === CLUSTER_NIGHTLY_HR;
    const driftTrigger = drift > CLUSTER_DRIFT_RATIO && ageMs > 30 * 60 * 1000;
    const neverRan = !lastRunAt && all.length >= 2;
    if (overdueNightly || driftTrigger || neverRan) {
      log("cluster.tick.run", { drift, ageHrs: (ageMs / 3600000).toFixed(1), creators: all.length, lastN, reason: overdueNightly ? "nightly" : neverRan ? "never-ran" : "drift" });
      await clusterNiches();
    } else {
      log("cluster.tick.idle", { drift: Number(drift.toFixed(3)), ageHrs: (ageMs / 3600000).toFixed(1), creators: all.length, lastN });
    }
  } catch (e) {
    log("cluster.tick.fail", { err: String(e) });
  }
};

// Test hook for e2e/unit suites.
globalThis.__fsCluster = Cluster;
globalThis.__fsClusterRun = clusterNiches;

chrome.runtime.onInstalled.addListener(async () => {
  log("installed");
  await ensureAlarm();
});

chrome.runtime.onStartup.addListener(async () => {
  log("startup");
  await ensureAlarm();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await tick();
    return;
  }
  if (alarm.name === AUDIO_ALARM) {
    await recomputeAudio();
    return;
  }
  if (alarm.name === WEEKLY_ALARM) {
    try { await sendWeeklyDigest(); } catch (e) { log("weekly.fail", { err: String(e) }); }
    return;
  }
  if (alarm.name === CLUSTER_ALARM) {
    await maybeClusterTick();
    return;
  }
});

// Manual triggers from the overlay UI ("Re-scan stale creators now",
// per-creator "Run now"). Always best-effort — UI doesn't block on the result.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "fs-bg") return;
  if (msg.cmd === "rescrape-stale") {
    (async () => {
      const all = await getAllCreators();
      const stale = all.filter((c) => isStale(c));
      log("rescrape.stale.request", { stale: stale.length, total: all.length });
      sendResponse({ ok: true, queued: stale.length });
      // Fire-and-forget the actual scrape so the channel isn't held open
      // for minutes. The user can press the button again to enqueue more.
      if (stale.length) scrapeOne(stale[0]).catch((e) => log("scrape.fail", { err: String(e) }));
    })();
    return true; // async response
  }
  if (msg.cmd === "cluster-niches-now") {
    (async () => {
      sendResponse({ ok: true, started: true });
      try {
        await clusterNiches({
          simThreshold: msg.simThreshold,
          posts: Array.isArray(msg.posts) ? msg.posts : null,
          creators: Array.isArray(msg.creators) ? msg.creators : null,
        });
      } catch (e) { log("cluster.fail", { err: String(e) }); }
    })();
    return true;
  }
  if (msg.cmd === "embed-texts") {
    (async () => {
      try {
        const texts = Array.isArray(msg.texts) ? msg.texts.map((t) => String(t || "")) : [];
        if (!texts.length) { sendResponse({ ok: true, vectors: [] }); return; }
        const vectors = await embedViaOffscreen(texts);
        sendResponse({ ok: true, vectors });
      } catch (e) {
        log("embed.fail", { err: String(e) });
        sendResponse({ ok: false, err: String(e && e.message || e) });
      }
    })();
    return true;
  }
  if (msg.cmd === "cluster-meta") {
    (async () => {
      const r = await chrome.storage.local.get(CLUSTER_META_KEY);
      sendResponse({ ok: true, meta: r?.[CLUSTER_META_KEY] || null });
    })();
    return true;
  }
  if (msg.cmd === "audio-recompute") {
    (async () => {
      sendResponse({ ok: true });
      try { await recomputeAudio(); } catch (e) { log("audio.recompute.fail", { err: String(e) }); }
    })();
    return true;
  }
  if (msg.cmd === "notify-signal") {
    (async () => {
      try {
        if (!chrome.notifications || !chrome.notifications.create) {
          sendResponse({ ok: false, err: "no-notifications-api" });
          return;
        }
        const s = msg.signal || {};
        const title = `Hook reuse: @${s.newAuthor || "?"} → @${s.histAuthor || "?"}`;
        const pct = Math.round((Number(s.similarity) || 0) * 100);
        const score = (Number(s.histScore) || 0).toFixed(1);
        const message = `${pct}% similar to a ${score}× outlier on @${s.histAuthor || "?"}\n"${(s.newHook || "").slice(0, 80)}"`;
        chrome.notifications.create(`fs-signal-${s.id || Date.now()}`, {
          type: "basic",
          iconUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
          title,
          message,
          priority: 2,
        }, () => {
          if (chrome.runtime.lastError) {
            log("notify.fail", { err: String(chrome.runtime.lastError.message || chrome.runtime.lastError) });
          }
        });
        sendResponse({ ok: true });
      } catch (e) {
        log("notify.fail", { err: String(e) });
        sendResponse({ ok: false, err: String(e) });
      }
    })();
    return true;
  }
  if (msg.cmd === "webhook-post") {
    (async () => {
      const r = await doWebhookPost(msg.url, msg.body);
      log("webhook.post", { ok: r.ok, status: r.status, err: r.err });
      sendResponse(r);
    })();
    return true;
  }
  if (msg.cmd === "sink-post") {
    (async () => {
      const r = await doSinkPost({ url: msg.url, method: msg.method, headers: msg.headers, body: msg.body });
      log("sink.post", { ok: r.ok, status: r.status, method: msg.method || "POST" });
      sendResponse(r);
    })();
    return true;
  }
  if (msg.cmd === "webhook-weekly-now") {
    (async () => {
      sendResponse({ ok: true });
      try { await sendWeeklyDigest(); } catch (e) { log("weekly.fail", { err: String(e) }); }
    })();
    return true;
  }
  if (msg.cmd === "download") {
    (async () => {
      try {
        if (!chrome.downloads || !chrome.downloads.download) {
          sendResponse({ ok: false, err: "no-downloads-api" });
          return;
        }
        const id = await new Promise((resolve, reject) => {
          chrome.downloads.download(
            {
              url: msg.url,
              filename: msg.filename,
              conflictAction: msg.conflictAction || "uniquify",
              saveAs: false,
            },
            (dlId) => {
              const lastErr = chrome.runtime.lastError;
              if (lastErr || dlId === undefined) reject(new Error(lastErr?.message || "download-failed"));
              else resolve(dlId);
            }
          );
        });
        log("download.ok", { id, filename: msg.filename });
        sendResponse({ ok: true, id });
      } catch (e) {
        log("download.fail", { err: String(e), filename: msg.filename });
        sendResponse({ ok: false, err: String(e?.message || e) });
      }
    })();
    return true;
  }
  if (msg.cmd === "download-cancel" && typeof msg.id === "number") {
    try { chrome.downloads.cancel(msg.id, () => sendResponse({ ok: true })); } catch (e) { sendResponse({ ok: false, err: String(e) }); }
    return true;
  }
  if (msg.cmd === "groq-test") {
    (async () => {
      const key = msg && typeof msg.apiKey === "string" ? msg.apiKey.trim() : "";
      const t0 = Date.now();
      if (!TranscribeCloud) return sendResponse({ ok: false, err: "runtime-missing" });
      try {
        const r = await TranscribeCloud.testGroqKey(key, { fetchImpl: (u, o) => fetch(u, o) });
        log("transcribe.groq.test", { ok: r.ok, status: r.status || 0, ms: Date.now() - t0 });
        sendResponse({ ...r, ms: Date.now() - t0 });
      } catch (e) {
        log("transcribe.groq.test.fail", { err: String(e?.message || e) });
        sendResponse({ ok: false, err: String(e?.message || e), ms: Date.now() - t0 });
      }
    })();
    return true;
  }
  if (msg.cmd === "hf-test") {
    (async () => {
      const key = msg && typeof msg.apiKey === "string" ? msg.apiKey.trim() : "";
      const t0 = Date.now();
      if (!TranscribeCloud || !TranscribeCloud.testHuggingFaceKey) {
        return sendResponse({ ok: false, err: "runtime-missing" });
      }
      try {
        const r = await TranscribeCloud.testHuggingFaceKey(key, { fetchImpl: (u, o) => fetch(u, o) });
        log("transcribe.hf.test", { ok: r.ok, status: r.status || 0, ms: Date.now() - t0 });
        sendResponse({ ...r, ms: Date.now() - t0 });
      } catch (e) {
        log("transcribe.hf.test.fail", { err: String(e?.message || e) });
        sendResponse({ ok: false, err: String(e?.message || e), ms: Date.now() - t0 });
      }
    })();
    return true;
  }
  if (msg.cmd === "transcribe-health") {
    (async () => {
      const base = String(msg.sidecarUrl || "").replace(/\/+$/, "");
      if (!base) return sendResponse({ ok: false, err: "no-sidecar-url" });
      const t0 = Date.now();
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 4000);
        const r = await fetch(`${base}/health`, { method: "GET", signal: ctrl.signal });
        clearTimeout(to);
        const json = await r.json().catch(() => null);
        log("transcribe.health", { ok: r.ok, status: r.status, ms: Date.now() - t0 });
        sendResponse({ ok: r.ok, status: r.status, body: json, ms: Date.now() - t0 });
      } catch (e) {
        log("transcribe.health.fail", { err: String(e?.message || e) });
        sendResponse({ ok: false, status: 0, err: String(e?.message || e), ms: Date.now() - t0 });
      }
    })();
    return true;
  }
  if (msg.cmd === "transcribe") {
    (async () => {
      const base = String(msg.sidecarUrl || "").replace(/\/+$/, "");
      const videoUrl = String(msg.videoUrl || "");
      const post = (msg && typeof msg.post === "object" && msg.post) ? msg.post : null;
      const groqKey = msg && typeof msg.groqApiKey === "string" ? msg.groqApiKey.trim() : "";
      const hfKey = msg && typeof msg.hfApiKey === "string" ? msg.hfApiKey.trim() : "";
      const hfFallbackOnRateLimit = !!(msg && msg.hfFallbackOnRateLimit);
      const language = msg.language ? String(msg.language) : "";
      const mode = (msg && typeof msg.transcribeMode === "string" && msg.transcribeMode) || "auto";
      const tStart = Date.now();

      // ---- Tier 1: free transcript (TikTok WebVTT / IG alt-text). ----
      async function tryFreeTranscript(p) {
        if (!Transcripts || !p) return null;
        const free = await Transcripts.fetchFreeTranscript(p, { fetchImpl: fetch });
        if (!free || !free.text) return null;
        const source = free.kind === "alt" ? "ig-alt" : (free.source || "free");
        return { text: free.text, source };
      }

      // ---- Tier 2: Groq Whisper-Large-v3-Turbo (BYOK). ----
      async function tryGroqWhisper(p, key) {
        if (!TranscribeCloud || !key || !p || !p.videoUrl) return null;
        const g = await TranscribeCloud.transcribeWithGroq(p, {
          apiKey: key,
          fetchImpl: (u, o) => fetch(u, o),
          language: language || "en",
        });
        if (g && g.ok && g.text) return { text: g.text, source: "groq-whisper" };
        if (g && g.ok === false) {
          log("transcribe.groq.fail", { id: msg.id, err: g.err, retryAfter: g.retryAfter || null });
        }
        return null;
      }

      // ---- Tier 3: HuggingFace Whisper-Large-v3 (BYOK). ----
      async function tryHuggingFace(p, key, fallbackOnRateLimit, lastTier) {
        if (!TranscribeCloud || !TranscribeCloud.transcribeWithHuggingFace) return null;
        if (!key || !p || !p.videoUrl) return null;
        // Conditional rule: only run after Groq when the user opted in to
        // rate-limit fallback. If Groq wasn't tried at all (no key), HF runs
        // unconditionally.
        if (lastTier === "groq" && !fallbackOnRateLimit) return null;
        const h = await TranscribeCloud.transcribeWithHuggingFace(p, {
          apiKey: key,
          fetchImpl: (u, o) => fetch(u, o),
          groqRateLimited: lastTier === "groq",
          fallbackOnRateLimit,
        });
        if (h && h.ok && h.text) return { text: h.text, source: "hf-whisper" };
        return null;
      }

      // ---- Tier 4: local Whisper sidecar. ----
      async function tryWhisperSidecar(_p) {
        if (!base || !videoUrl) return null;
        const vr = await fetch(videoUrl, { credentials: "omit" });
        if (!vr.ok) throw new Error(`video HTTP ${vr.status}`);
        const blob = await vr.blob();
        const fd = new FormData();
        const fname = `${msg.shortcode || msg.id || "clip"}.mp4`;
        fd.append("file", new File([blob], fname, { type: blob.type || "video/mp4" }));
        if (language) fd.append("language", language);
        if (msg.model) fd.append("model", String(msg.model));
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 5 * 60 * 1000);
        let r;
        try {
          r = await fetch(`${base}/transcribe`, { method: "POST", body: fd, signal: ctrl.signal });
        } finally {
          clearTimeout(to);
        }
        const json = await r.json().catch(() => null);
        if (!r.ok || !json || json.ok === false || !json.text) return null;
        return { text: json.text, source: "whisper" };
      }

      // Track which tier ran most recently so HF can apply its conditional
      // fallback rule. We wrap the tier fns to update `lastTier` after each.
      let lastTier = null;
      const wrap = (name, fn) => async (p) => {
        const r = await fn(p);
        lastTier = name;
        return r;
      };
      const tiers = {
        free: wrap("free", (p) => tryFreeTranscript(p)),
        groq: wrap("groq", (p) => tryGroqWhisper(p, groqKey)),
        hf:   wrap("hf",   (p) => tryHuggingFace(p, hfKey, hfFallbackOnRateLimit, lastTier)),
        sidecar: wrap("sidecar", (p) => tryWhisperSidecar(p)),
      };

      const cascade = TranscribeCascade && TranscribeCascade.runCascade;
      if (!cascade) {
        log("transcribe.cascade.missing", { id: msg.id });
        return sendResponse({ ok: false, err: "cascade-runtime-missing", ms: Date.now() - tStart });
      }

      const result = await cascade({ post, mode, tiers, log });
      const totalMs = Date.now() - tStart;
      if (result.ok) {
        log("transcribe.ok", {
          id: msg.id,
          source: result.source,
          chars: (result.text || "").length,
          tierMs: result.latencyMs,
          ms: totalMs,
          mode,
        });
        const isAlt = result.source === "ig-alt";
        const model = result.source === "groq-whisper" ? "whisper-large-v3-turbo"
          : result.source === "hf-whisper" ? "whisper-large-v3"
          : "";
        return sendResponse({
          ok: true,
          status: 200,
          body: {
            ok: true,
            text: result.text,
            segments: [],
            language: language || "",
            model,
            source: result.source,
            ...(isAlt ? { isAltText: true } : {}),
          },
          source: result.source,
          latencyMs: result.latencyMs,
          ms: totalMs,
          ...(isAlt ? { isAltText: true } : {}),
        });
      }
      log("transcribe.exhausted", { id: msg.id, mode, ms: totalMs });
      sendResponse({ ok: false, err: result.err || "all-tiers-exhausted", ms: totalMs });
    })();
    return true;
  }
  if (msg.cmd === "llm.chat") {
    (async () => {
      const t0 = Date.now();
      const p = msg.payload || {};
      try {
        const r = await llmChat(p);
        sendResponse({ ok: true, body: r });
      } catch (e) {
        const status = e && e.status;
        log("llm.call.fail", { err: String(e?.message || e), status, ms: Date.now() - t0, kind: p.kind });
        sendResponse({ ok: false, status: status || 0, err: String(e?.message || e) });
      }
    })();
    return true;
  }
  if (msg.cmd === "llm.health") {
    (async () => {
      try {
        // Accept either {endpoint} (legacy/Ollama) or {provider, apiKey, endpoint}.
        const r = await llmHealthCheck(msg.payload || {});
        sendResponse({ ok: true, body: r });
      } catch (e) {
        sendResponse({ ok: false, status: e && e.status || 0, err: String(e?.message || e), kind: e && e.kind });
      }
    })();
    return true;
  }
  if (msg.cmd === "llm.clearCache") {
    (async () => {
      try {
        const before = LLM_CACHE.size;
        LLM_CACHE.clear();
        await chrome.storage.local.remove(LLM_CACHE_KEY).catch(() => {});
        log("llm.cache.clear", { entries: before });
        sendResponse({ ok: true, body: { cleared: before } });
      } catch (e) {
        sendResponse({ ok: false, err: String(e?.message || e) });
      }
    })();
    return true;
  }
  if (msg.cmd === "rescrape-now" && msg.username) {
    (async () => {
      const all = await getAllCreators();
      const c = all.find((x) => x.username === String(msg.username).toLowerCase());
      if (!c) return sendResponse({ ok: false, err: "not-tracked" });
      sendResponse({ ok: true });
      scrapeOne(c).catch((e) => log("scrape.fail", { err: String(e) }));
    })();
    return true;
  }
  // -------- Managed-backend API bridge (Step 28) --------
  // Service-worker-side fetch so cookies + the same-origin video fetch with
  // session credentials work without leaking through the page origin.
  if (msg.cmd === "api.config") {
    (async () => {
      const cfg = await chrome.storage.local.get(["fs.api.baseUrl", "fs.api.token"]);
      sendResponse({ ok: true, baseUrl: cfg["fs.api.baseUrl"] || "https://api.feedsorter.app", token: cfg["fs.api.token"] || null });
    })();
    return true;
  }
  if (msg.cmd === "api.set-token" && (typeof msg.token === "string" || msg.token === null)) {
    (async () => {
      await chrome.storage.local.set({ "fs.api.token": msg.token || "" });
      sendResponse({ ok: true });
      // Connect/disconnect both invalidate the cached tier. On connect,
      // refresh from /v1/me so the UI flips to Pro without waiting for the
      // next on-demand request. On disconnect, reset to 'free' so locked
      // features show the upgrade chip immediately.
      if (msg.token) {
        refreshTierFromApi().catch((e) => log("api.tier.refresh.fail", { err: String(e && e.message || e) }));
      } else {
        try { await chrome.storage.local.set({ "fs.api.tier": "free" }); } catch (_) {}
      }
    })();
    return true;
  }
  if (msg.cmd === "api.set-base" && typeof msg.baseUrl === "string") {
    (async () => {
      await chrome.storage.local.set({ "fs.api.baseUrl": msg.baseUrl });
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.cmd === "api.request" && typeof msg.path === "string") {
    (async () => {
      try {
        const cfg = await chrome.storage.local.get(["fs.api.baseUrl", "fs.api.token"]);
        const baseUrl = cfg["fs.api.baseUrl"] || "https://api.feedsorter.app";
        const token = cfg["fs.api.token"] || "";
        const headers = Object.assign({ "content-type": "application/json" }, msg.headers || {});
        if (token) headers.authorization = "Bearer " + token;
        const res = await fetch(baseUrl + msg.path, {
          method: msg.method || "GET",
          headers,
          body: msg.body ? JSON.stringify(msg.body) : undefined,
          credentials: "include",
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) {}
        // Piggy-back tier persistence on the natural /v1/me round-trip the
        // content script makes for the conn-indicator + settings modal. No
        // extra request needed.
        if (msg.path === "/v1/me" && res.ok && json && typeof json.tier === "string") {
          try { await chrome.storage.local.set({ "fs.api.tier": json.tier }); } catch (_) {}
        }
        sendResponse({ ok: res.ok, status: res.status, body: json, raw: json ? null : text });
      } catch (e) {
        sendResponse({ ok: false, err: String(e && e.message || e) });
      }
    })();
    return true;
  }
  if (msg.cmd === "api.transcribe" && typeof msg.postId === "string" && typeof msg.videoUrl === "string") {
    (async () => {
      try {
        const cfg = await chrome.storage.local.get(["fs.api.baseUrl", "fs.api.token"]);
        const baseUrl = cfg["fs.api.baseUrl"] || "https://api.feedsorter.app";
        const token = cfg["fs.api.token"] || "";
        // Fetch the video from the platform CDN with active session credentials,
        // then forward as multipart to our backend.
        const vidRes = await fetch(msg.videoUrl, { credentials: "include" });
        if (!vidRes.ok) throw new Error("video fetch " + vidRes.status);
        const blob = await vidRes.blob();
        const fd = new FormData();
        fd.append("file", blob, msg.postId + ".mp4");
        const headers = {};
        if (token) headers.authorization = "Bearer " + token;
        const res = await fetch(baseUrl + "/v1/posts/" + encodeURIComponent(msg.postId) + "/transcribe", {
          method: "POST",
          headers,
          body: fd,
          credentials: "include",
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) {}
        log("api.transcribe", { ok: res.ok, status: res.status, postId: msg.postId });
        sendResponse({ ok: res.ok, status: res.status, body: json });
      } catch (e) {
        log("api.transcribe.fail", { err: String(e), postId: msg.postId });
        sendResponse({ ok: false, err: String(e && e.message || e) });
      }
    })();
    return true;
  }
  if (msg.cmd === "api.sync-posts") {
    (async () => {
      const t0 = Date.now();
      try {
        const cfg = await chrome.storage.local.get(["fs.api.baseUrl", "fs.api.token"]);
        const baseUrl = cfg["fs.api.baseUrl"] || "https://api.feedsorter.app";
        const token = cfg["fs.api.token"] || "";
        if (!token) {
          console.warn("[fs-bg] sync: not-signed-in");
          sendResponse({ ok: false, err: "not-signed-in" });
          return;
        }

        // Prefer posts passed in the message (page-origin IDB lives in the
        // content script's world, not ours). Fall back to extension-origin
        // IDB only when content.js didn't send any.
        let all;
        if (Array.isArray(msg.posts) && msg.posts.length) {
          all = msg.posts;
          console.log("[fs-bg] sync: using posts from content script", { count: all.length });
        } else {
          all = await getAllFromStore("posts");
          console.log("[fs-bg] sync: read from extension-IDB (fallback)", { count: all.length });
        }
        const creatorNicheMap = await buildCreatorNicheMap();
        // Track which niche source fired for each synced post: the post's
        // own label (set by the post-level cluster pipeline), the creator's
        // (from clusterNiches), or neither. Surfaces in the sync log so we
        // can see whether the bio-first cascade is actually paying off.
        const nicheSrc = { post: 0, creator: 0, none: 0 };
        const mapped = all.map((p) => {
          const out = toSyncPost(p, creatorNicheMap);
          if (!out) return null;
          if (out.niche && typeof p.niche === "string" && p.niche === out.niche) nicheSrc.post++;
          else if (out.niche) nicheSrc.creator++;
          else nicheSrc.none++;
          return out;
        }).filter(Boolean);
        console.log("[fs-bg] sync: creator-niche map", { creators: creatorNicheMap.size, nicheSrc });
        log("sync.niche.breakdown", nicheSrc);
        console.log(
          "[fs-bg] sync: prepared",
          { raw: all.length, mapped: mapped.length, dropped: all.length - mapped.length, baseUrl, sample: mapped[0] }
        );
        if (mapped.length === 0) {
          sendResponse({ ok: true, total: 0, inserted: 0, dropped: 0, batches: 0 });
          return;
        }

        const BATCH = 100;
        const sample = mapped[0];
        let inserted = 0, dropped = 0, batches = 0, lastErr = null, lastStatus = 0;
        for (let i = 0; i < mapped.length; i += BATCH) {
          const slice = mapped.slice(i, i + BATCH);
          const url = baseUrl + "/v1/posts/sync";
          console.log("[fs-bg] sync: POST batch", { batch: batches + 1, count: slice.length, url, firstId: slice[0] && slice[0].id });
          const res = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: "Bearer " + token,
            },
            body: JSON.stringify({ posts: slice }),
            credentials: "include",
          });
          batches++;
          lastStatus = res.status;
          const text = await res.text();
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch (_) {}
          if (!res.ok) {
            lastErr = (json && json.error) || ("http " + res.status);
            console.error("[fs-bg] sync: batch failed", { status: res.status, body: json || text });
            break;
          }
          inserted += (json && json.inserted) || 0;
          dropped += (json && json.dropped) || 0;
          console.log("[fs-bg] sync: batch ok", json);
        }
        const ms = Date.now() - t0;
        log("api.sync", { total: mapped.length, inserted, dropped, batches, ms, status: lastStatus, lastErr });
        console.log("[fs-bg] sync: done", { total: mapped.length, inserted, dropped, batches, ms });
        sendResponse({ ok: !lastErr, total: mapped.length, inserted, dropped, batches, status: lastStatus, sample, err: lastErr });
      } catch (e) {
        console.error("[fs-bg] sync: threw", e);
        log("api.sync.fail", { err: String(e) });
        sendResponse({ ok: false, err: String(e && e.message || e) });
      }
    })();
    return true;
  }
  if (msg.cmd === "api.transcribe-text" && typeof msg.postId === "string" && typeof msg.text === "string") {
    (async () => {
      try {
        const cfg = await chrome.storage.local.get(["fs.api.baseUrl", "fs.api.token"]);
        const baseUrl = cfg["fs.api.baseUrl"] || "https://api.feedsorter.app";
        const token = cfg["fs.api.token"] || "";
        const headers = { "content-type": "application/json" };
        if (token) headers.authorization = "Bearer " + token;
        const res = await fetch(baseUrl + "/v1/posts/" + encodeURIComponent(msg.postId) + "/transcribe", {
          method: "POST",
          headers,
          body: JSON.stringify({
            text: msg.text,
            source: msg.source || "youtube-captions",
            language: msg.language || null,
            segments: msg.segments || null,
            durationS: msg.durationS || null,
          }),
          credentials: "include",
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) {}
        sendResponse({ ok: res.ok, status: res.status, body: json });
      } catch (e) {
        sendResponse({ ok: false, err: String(e && e.message || e) });
      }
    })();
    return true;
  }
});

// -------- Local LLM (Ollama) handlers --------
// Wire-format mirror of src/lib/llm.js. Lives here because background.js is
// a classic-script SW and llm.js is ESM (loaded by content scripts via
// llm-bridge.js + unit tests). Centralizing here gives us in-flight caps
// and a process-wide cache.

const LLM_DEFAULT_ENDPOINT = "http://localhost:11434";
const LLM_DEFAULT_MODEL = "gemma4";
const LLM_DEFAULT_TIMEOUT_MS = 60_000;
const LLM_GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const LLM_GROQ_MODELS_ENDPOINT = "https://api.groq.com/openai/v1/models";
const LLM_DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";
const LLM_DEFAULT_GROQ_FAST_MODEL = "llama-3.1-8b-instant";
const LLM_FAST_KINDS = new Set(["hook", "topic", "hookType", "per-post-analysis", "niche-label"]);
const llmIsFastKind = (k) => LLM_FAST_KINDS.has(String(k || ""));
const llmPickProvider = (p) => {
  if (p && (p.provider === "groq" || p.provider === "ollama")) return p.provider;
  if (p && p.apiKey && String(p.apiKey).trim()) return "groq";
  return "ollama";
};
const LLM_CACHE_KEY = "fs.llm.cache";
const LLM_CACHE = new Map(); // key -> { body, savedAt }
const LLM_CACHE_MAX = 256;

let LLM_INFLIGHT = 0;
let LLM_CONCURRENCY = 2;
const LLM_QUEUE = [];

const llmCanonicalize = (v) => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(llmCanonicalize).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + llmCanonicalize(v[k])).join(",") + "}";
};
const llmPromptHash = (payload) => {
  const s = llmCanonicalize(payload);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return ((h >>> 0).toString(16)).padStart(8, "0");
};

// Load AI settings from storage so SW knows the user's concurrency choice.
const llmLoadSettings = async () => {
  try {
    const r = await chrome.storage.local.get("fs:ai");
    const cfg = r && r["fs:ai"];
    if (cfg && Number(cfg.concurrency) > 0) {
      LLM_CONCURRENCY = Math.max(1, Math.min(16, Number(cfg.concurrency)));
    }
  } catch { /* ignore */ }
};
llmLoadSettings();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes["fs:ai"]) return;
  const cfg = changes["fs:ai"].newValue;
  if (cfg && Number(cfg.concurrency) > 0) {
    LLM_CONCURRENCY = Math.max(1, Math.min(16, Number(cfg.concurrency)));
    log("llm.concurrency.update", { concurrency: LLM_CONCURRENCY });
  }
});

const llmAcquireSlot = () => new Promise((resolve) => {
  const tryGo = () => {
    if (LLM_INFLIGHT < LLM_CONCURRENCY) {
      LLM_INFLIGHT++;
      resolve(() => {
        LLM_INFLIGHT--;
        const next = LLM_QUEUE.shift();
        if (next) next();
      });
      return true;
    }
    return false;
  };
  if (!tryGo()) LLM_QUEUE.push(tryGo);
});

const llmAttachImages = (messages, images) => {
  const out = (messages || []).map((m) => ({ ...m }));
  if (!images || !images.length) return out;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role === "user") { out[i].images = images.slice(); return out; }
  }
  out.push({ role: "user", content: "", images: images.slice() });
  return out;
};

async function* llmIterNdjson(resp) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) { try { yield JSON.parse(line); } catch { /* skip */ } }
    }
  }
  const tail = buf.trim();
  if (tail) { try { yield JSON.parse(tail); } catch { /* ignore */ } }
}

async function llmChat(payload) {
  const provider = llmPickProvider(payload);
  if (provider === "groq") return llmChatGroq(payload);
  return llmChatOllama(payload);
}

async function llmChatOllama(payload) {
  const {
    endpoint = LLM_DEFAULT_ENDPOINT,
    model = LLM_DEFAULT_MODEL,
    messages = [],
    schema = null,
    images = null,
    options = null,
    timeoutMs = LLM_DEFAULT_TIMEOUT_MS,
    kind = "generic",
    postId = null,
    cache = true,
  } = payload || {};
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error("llm.chat: messages[] required");
  }

  const cacheKey = `ollama:${model}:${llmPromptHash({ messages, schema, images })}`;
  if (cache && LLM_CACHE.has(cacheKey)) {
    const hit = LLM_CACHE.get(cacheKey);
    log("llm.call.end", { model, kind, postId, durationMs: 0, tokensIn: hit.body.tokensIn, tokensOut: hit.body.tokensOut, cached: true });
    return { ...hit.body, cached: true };
  }

  const release = await llmAcquireSlot();
  const t0 = Date.now();
  log("llm.call.start", { model, kind, postId, hasSchema: !!schema, hasImages: !!(images && images.length), inflight: LLM_INFLIGHT });

  const ctrl = new AbortController();
  const timer = timeoutMs > 0
    ? setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
    : null;

  try {
    const url = String(endpoint).replace(/\/+$/, "") + "/api/chat";
    const body = { model, messages: llmAttachImages(messages, images), stream: true };
    if (schema) body.format = schema;
    if (options && typeof options === "object") body.options = options;

    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      const err = new Error(`llm.chat ${resp.status}: ${detail.slice(0, 200)}`);
      err.status = resp.status;
      throw err;
    }
    let text = "";
    let tokensIn = 0;
    let tokensOut = 0;
    let modelEcho = model;
    for await (const evt of llmIterNdjson(resp)) {
      if (evt.message && typeof evt.message.content === "string") text += evt.message.content;
      if (typeof evt.model === "string") modelEcho = evt.model;
      if (evt.done) {
        if (typeof evt.prompt_eval_count === "number") tokensIn = evt.prompt_eval_count;
        if (typeof evt.eval_count === "number") tokensOut = evt.eval_count;
      }
    }
    let json = null;
    if (schema) {
      try { json = JSON.parse(text); }
      catch (e) {
        const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (m) { try { json = JSON.parse(m[1]); } catch { /* */ } }
        if (!json) {
          log("llm.json.parse.fail", { kind, postId, sample: text.slice(0, 120) });
          const err = new Error("llm.chat: structured-output JSON parse failed");
          err.text = text;
          throw err;
        }
      }
    }
    const durationMs = Date.now() - t0;
    const out = { text, json, tokensIn, tokensOut, durationMs, model: modelEcho, cached: false };
    if (cache) {
      LLM_CACHE.set(cacheKey, { body: out, savedAt: Date.now() });
      if (LLM_CACHE.size > LLM_CACHE_MAX) {
        const firstKey = LLM_CACHE.keys().next().value;
        if (firstKey) LLM_CACHE.delete(firstKey);
      }
    }
    log("llm.call.end", { provider: "ollama", model: modelEcho, kind, postId, durationMs, tokensIn, tokensOut, cached: false });
    return out;
  } finally {
    if (timer) clearTimeout(timer);
    release();
  }
}

async function llmChatGroq(payload) {
  const {
    apiKey = "",
    model = LLM_DEFAULT_GROQ_MODEL,
    fastModel = LLM_DEFAULT_GROQ_FAST_MODEL,
    messages = [],
    schema = null,
    options = null,
    timeoutMs = LLM_DEFAULT_TIMEOUT_MS,
    kind = "generic",
    postId = null,
    cache = true,
  } = payload || {};
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error("llm.chat: messages[] required");
  }
  const key = String(apiKey || "").trim();
  if (!key) {
    const err = new Error("llm.chat: groq provider requires apiKey");
    err.kind = "config";
    throw err;
  }
  const useModel = llmIsFastKind(kind) ? (fastModel || LLM_DEFAULT_GROQ_FAST_MODEL) : (model || LLM_DEFAULT_GROQ_MODEL);

  // Cache key includes provider+model so Groq calls don't collide with Ollama.
  const cacheKey = `groq:${useModel}:${llmPromptHash({ messages, schema })}`;
  if (cache && LLM_CACHE.has(cacheKey)) {
    const hit = LLM_CACHE.get(cacheKey);
    log("llm.call.end", { provider: "groq", model: useModel, kind, postId, durationMs: 0, cached: true });
    return { ...hit.body, cached: true };
  }

  const release = await llmAcquireSlot();
  const t0 = Date.now();
  log("llm.call.start", { provider: "groq", model: useModel, kind, postId, hasSchema: !!schema, inflight: LLM_INFLIGHT });

  const ctrl = new AbortController();
  const timer = timeoutMs > 0
    ? setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
    : null;

  try {
    const body = { model: useModel, messages, stream: false };
    if (schema) body.response_format = { type: "json_object" };
    if (options && typeof options === "object") {
      if (typeof options.temperature === "number") body.temperature = options.temperature;
      if (typeof options.top_p === "number") body.top_p = options.top_p;
      if (typeof options.max_tokens === "number") body.max_tokens = options.max_tokens;
      else if (typeof options.num_predict === "number") body.max_tokens = options.num_predict;
    }
    const resp = await fetch(LLM_GROQ_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      if (resp.status === 429) {
        const err = new Error(`groq: rate limited${detail ? `: ${detail.slice(0, 160)}` : ""}`);
        err.status = 429; err.kind = "rate-limit"; err.provider = "groq";
        try { const ra = resp.headers.get("retry-after"); if (ra) err.retryAfter = ra; } catch { /* */ }
        throw err;
      }
      if (resp.status === 401 || resp.status === 403) {
        const err = new Error(`groq: auth failed (${resp.status})`);
        err.status = resp.status; err.kind = "auth"; err.provider = "groq";
        throw err;
      }
      const err = new Error(`llm.chat ${resp.status}: ${detail.slice(0, 200)}`);
      err.status = resp.status; err.provider = "groq";
      throw err;
    }
    const raw = await resp.json();
    const choice = Array.isArray(raw && raw.choices) ? raw.choices[0] : null;
    const text = (choice && choice.message && typeof choice.message.content === "string") ? choice.message.content : "";
    const tokensIn = (raw && raw.usage && Number(raw.usage.prompt_tokens)) || 0;
    const tokensOut = (raw && raw.usage && Number(raw.usage.completion_tokens)) || 0;
    const modelEcho = (raw && typeof raw.model === "string") ? raw.model : useModel;
    let json = null;
    if (schema) {
      try { json = JSON.parse(text); }
      catch (e) {
        const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (m) { try { json = JSON.parse(m[1]); } catch { /* */ } }
        if (!json) {
          log("llm.json.parse.fail", { provider: "groq", kind, postId, sample: text.slice(0, 120) });
          const err = new Error("llm.chat: structured-output JSON parse failed");
          err.text = text;
          throw err;
        }
      }
    }
    const durationMs = Date.now() - t0;
    const out = { text, json, tokensIn, tokensOut, durationMs, model: modelEcho, cached: false };
    if (cache) {
      LLM_CACHE.set(cacheKey, { body: out, savedAt: Date.now() });
      if (LLM_CACHE.size > LLM_CACHE_MAX) {
        const firstKey = LLM_CACHE.keys().next().value;
        if (firstKey) LLM_CACHE.delete(firstKey);
      }
    }
    log("llm.call.end", { provider: "groq", model: modelEcho, kind, postId, durationMs, tokensIn, tokensOut, cached: false });
    return out;
  } finally {
    if (timer) clearTimeout(timer);
    release();
  }
}

async function llmHealthCheck(opts) {
  // Back-compat: a string arg is treated as the Ollama endpoint.
  if (typeof opts === "string" || opts == null) {
    return llmHealthCheckOllama(opts || LLM_DEFAULT_ENDPOINT);
  }
  const provider = llmPickProvider(opts);
  if (provider === "groq") return llmHealthCheckGroq(opts);
  return llmHealthCheckOllama(opts.endpoint || LLM_DEFAULT_ENDPOINT);
}

async function llmHealthCheckOllama(endpoint) {
  const base = String(endpoint || LLM_DEFAULT_ENDPOINT).replace(/\/+$/, "");
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 5000);
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/api/tags`, { method: "GET", signal: ctrl.signal });
    if (!r.ok) {
      const err = new Error(`healthCheck: ${r.status}`);
      err.status = r.status;
      throw err;
    }
    const raw = await r.json();
    const models = Array.isArray(raw && raw.models)
      ? raw.models.map((m) => (typeof m === "string" ? m : m.name)).filter(Boolean)
      : [];
    log("llm.health.ok", { provider: "ollama", endpoint: base, models: models.length, ms: Date.now() - t0 });
    return { ok: true, provider: "ollama", models, raw, durationMs: Date.now() - t0 };
  } finally {
    clearTimeout(to);
  }
}

async function llmHealthCheckGroq(opts) {
  const key = String((opts && opts.apiKey) || "").trim();
  if (!key) {
    const err = new Error("healthCheck: groq apiKey required");
    err.kind = "config";
    throw err;
  }
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 5000);
  const t0 = Date.now();
  try {
    const r = await fetch(LLM_GROQ_MODELS_ENDPOINT, {
      method: "GET",
      headers: { "Authorization": `Bearer ${key}` },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const err = new Error(`healthCheck: ${r.status}`);
      err.status = r.status;
      if (r.status === 401 || r.status === 403) err.kind = "auth";
      throw err;
    }
    const raw = await r.json();
    const models = Array.isArray(raw && raw.data)
      ? raw.data.map((m) => (m && typeof m.id === "string" ? m.id : null)).filter(Boolean)
      : [];
    log("llm.health.ok", { provider: "groq", models: models.length, ms: Date.now() - t0 });
    return { ok: true, provider: "groq", models, raw, durationMs: Date.now() - t0 };
  } finally {
    clearTimeout(to);
  }
}

// Cold-boot the alarm if neither install nor startup fired (e.g. first SW
// wake after extension reload during dev).
ensureAlarm();
