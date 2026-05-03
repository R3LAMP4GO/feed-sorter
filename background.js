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

// -------- raw-IDB helpers (creators store) --------
const DB_NAME = "feed-sorter";
const DB_VERSION = 5;
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
  try {
    const creators = await getAllCreators();
    if (creators.length < 2) {
      log("cluster.skip", { reason: "too-few-creators", n: creators.length });
      await chrome.storage.local.set({ [CLUSTER_META_KEY]: { lastRunAt: Date.now(), creatorCount: creators.length, clusters: [] } });
      return { ok: true, clusters: [], reason: "too-few-creators" };
    }
    const posts = await getAllFromStore(POST_STORE);
    const byAuthor = new Map();
    for (const p of posts) {
      if (!p || !p.author) continue;
      const k = String(p.author).toLowerCase();
      if (!byAuthor.has(k)) byAuthor.set(k, []);
      byAuthor.get(k).push(p);
    }
    log("cluster.embed.start", { creators: creators.length, posts: posts.length });
    const creatorVecs = await Cluster.buildCreatorVectors(creators, byAuthor, embedViaOffscreen, 20);
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
    log("cluster.done", { ms: meta.ms, clusters: groups.length });
    return { ok: true, clusters: groups, ms: meta.ms };
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
      try { await clusterNiches({ simThreshold: msg.simThreshold }); } catch (e) { log("cluster.fail", { err: String(e) }); }
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
      if (!base || !videoUrl) return sendResponse({ ok: false, err: "missing-args" });
      const t0 = Date.now();
      try {
        // Fetch the IG CDN video from the SW (no page CSP, no referer leak).
        const vr = await fetch(videoUrl, { credentials: "omit" });
        if (!vr.ok) throw new Error(`video HTTP ${vr.status}`);
        const blob = await vr.blob();
        const fd = new FormData();
        const fname = `${msg.shortcode || msg.id || "clip"}.mp4`;
        fd.append("file", new File([blob], fname, { type: blob.type || "video/mp4" }));
        if (msg.language) fd.append("language", String(msg.language));
        if (msg.model) fd.append("model", String(msg.model));
        // Whisper on a 60s reel can take ~30-60s on CPU; allow up to 5min.
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 5 * 60 * 1000);
        const r = await fetch(`${base}/transcribe`, { method: "POST", body: fd, signal: ctrl.signal });
        clearTimeout(to);
        const json = await r.json().catch(() => null);
        if (!r.ok || !json || json.ok === false) {
          const err = (json && json.err) || `HTTP ${r.status}`;
          log("transcribe.post.fail", { err, status: r.status, ms: Date.now() - t0, id: msg.id });
          return sendResponse({ ok: false, status: r.status, err, ms: Date.now() - t0 });
        }
        log("transcribe.post", {
          ok: true,
          status: r.status,
          chars: (json.text || "").length,
          segs: (json.segments || []).length,
          lang: json.language,
          ms: Date.now() - t0,
          id: msg.id,
        });
        sendResponse({ ok: true, status: r.status, body: json, ms: Date.now() - t0 });
      } catch (e) {
        log("transcribe.fail", { err: String(e?.message || e), id: msg.id });
        sendResponse({ ok: false, status: 0, err: String(e?.message || e), ms: Date.now() - t0 });
      }
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
        const r = await llmHealthCheck(msg.payload && msg.payload.endpoint);
        sendResponse({ ok: true, body: r });
      } catch (e) {
        sendResponse({ ok: false, status: e && e.status || 0, err: String(e?.message || e) });
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
});

// -------- Local LLM (Ollama) handlers --------
// Wire-format mirror of src/lib/llm.js. Lives here because background.js is
// a classic-script SW and llm.js is ESM (loaded by content scripts via
// llm-bridge.js + unit tests). Centralizing here gives us in-flight caps
// and a process-wide cache.

const LLM_DEFAULT_ENDPOINT = "http://localhost:11434";
const LLM_DEFAULT_MODEL = "gemma4";
const LLM_DEFAULT_TIMEOUT_MS = 60_000;
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

  const cacheKey = `${model}:${llmPromptHash({ messages, schema, images })}`;
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
    log("llm.call.end", { model: modelEcho, kind, postId, durationMs, tokensIn, tokensOut, cached: false });
    return out;
  } finally {
    if (timer) clearTimeout(timer);
    release();
  }
}

async function llmHealthCheck(endpoint) {
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
    log("llm.health.ok", { endpoint: base, models: models.length, ms: Date.now() - t0 });
    return { ok: true, models, raw, durationMs: Date.now() - t0 };
  } finally {
    clearTimeout(to);
  }
}

// Cold-boot the alarm if neither install nor startup fired (e.g. first SW
// wake after extension reload during dev).
ensureAlarm();
