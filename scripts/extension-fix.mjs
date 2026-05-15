#!/usr/bin/env node
// Drive Chrome/Brave via the DevTools Protocol to:
//   1. Set the API token + baseUrl in the extension's chrome.storage.local
//   2. Find the active Instagram tab
//   3. Trigger the niche-cluster pipeline (passing posts from the page IDB)
//   4. Poll cluster-meta until it returns or times out
//   5. Print the resulting cluster labels
//
// Requires Brave/Chrome to be launched with --remote-debugging-port=9222.
// No other deps — uses raw WebSocket + HTTP to /json endpoints.

import http from "node:http";
// Node 22+ ships a global WebSocket — no `ws` package needed.

const DEBUG_PORT = 9222;
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6ImRvdXJvZGlnaXRhbG1lZGlhQGdtYWlsLmNvbSIsInRpZXIiOiJwcm8iLCJzdWIiOiJlZDdkNjg4Mi1hNTk3LTRmOWItOTU5MC1hNzhlMGE3YTlhZmQiLCJqdGkiOiI5MzkyNjFiMy1jZWExLTQ1YWUtOTZlYi05YjVlMDg3MzQ0NDEiLCJpYXQiOjE3NzgzNTY4MjEsImlzcyI6ImZlZWRzb3J0ZXIiLCJhdWQiOiJmZWVkc29ydGVyLWFwcCIsImV4cCI6MTc4MDk0ODgyMX0.Eo1ed_eECrnqC5RwbdyIbdhfGDfWR78plmRqCK8DstE";
const API_BASE_URL = "http://localhost:8787";

// ---------- CDP plumbing ----------
const fetchJson = (path) => new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port: DEBUG_PORT, path }, (res) => {
    let buf = "";
    res.on("data", (c) => (buf += c));
    res.on("end", () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
  }).on("error", reject);
});

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.ws.addEventListener = this.ws.addEventListener.bind(this.ws); // pin
    this.id = 0;
    this.pending = new Map();
    // Accumulating set of live execution contexts so we don't rely on
    // ad-hoc listeners (which leak across reloads).
    this.contexts = new Map(); // id -> context
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(e));
    });
    this.ws.addEventListener("message", (ev) => {
      const m = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data));
      if (m.id != null && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(`${m.error.code}: ${m.error.message}`));
        else resolve(m.result);
      }
      if (m.method === "Runtime.executionContextCreated" && m.params?.context) {
        this.contexts.set(m.params.context.id, m.params.context);
      } else if (m.method === "Runtime.executionContextDestroyed" && m.params?.executionContextId != null) {
        this.contexts.delete(m.params.executionContextId);
      } else if (m.method === "Runtime.executionContextsCleared") {
        this.contexts.clear();
      }
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, handler) {
    this.ws.addEventListener("message", (ev) => {
      const m = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data));
      if (m.method === method) handler(m.params);
    });
  }
  async eval(expr, opts = {}) {
    const r = await this.send("Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      ...opts,
    });
    if (r.exceptionDetails) {
      throw new Error("eval failed: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }
  close() { this.ws.close(); }
}

// Find Feed Sorter's content-script isolated world by NAME, scanning the
// CDP's accumulated context map. Multiple extensions can share `background.js`
// SW filenames, so name matching is the reliable disambiguator.
async function findFeedSorterContext(cdp, { wait = 1500 } = {}) {
  await cdp.send("Runtime.enable"); // idempotent; safe to re-call
  const deadline = Date.now() + wait;
  while (Date.now() < deadline) {
    for (const ctx of cdp.contexts.values()) {
      const ad = ctx.auxData || {};
      if (ad.isDefault === false && /feed\s*sorter/i.test(ctx.name || "")) {
        const m = String(ctx.origin || "").match(/^chrome-extension:\/\/([a-z]+)/);
        return { contextId: ctx.id, extensionId: m ? m[1] : null, name: ctx.name };
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

// ---------- main ----------
const main = async () => {
  console.log("[fix] connecting to Brave at :9222 …");
  let targets;
  try { targets = await fetchJson("/json/list"); }
  catch (e) {
    console.error("[fix] failed:", e.message);
    console.error("[fix] is Brave running with --remote-debugging-port=9222?");
    process.exit(1);
  }

  // 1. Find the Instagram tab — we'll evaluate in Feed Sorter's content-script
  //    isolated world, which has the full chrome.* surface for THE RIGHT
  //    extension. Multiple extensions can have a `background.js` SW, so we
  //    can't just match by SW filename.
  let igTab = targets.find((t) => t.type === "page" && /instagram\.com/.test(t.url || ""));
  if (!igTab) {
    // Refresh target list — user may have just opened it.
    targets = await fetchJson("/json/list");
    igTab = targets.find((t) => t.type === "page" && /instagram\.com/.test(t.url || ""));
  }
  if (!igTab) {
    console.error("[fix] no instagram.com tab open. Open instagram.com/explore/ first.");
    process.exit(2);
  }
  console.log("[fix] found IG tab:", igTab.url.slice(0, 80));
  const pageCdp = new CDP(igTab.webSocketDebuggerUrl);
  await pageCdp.ready;

  // Find Feed Sorter's content-script isolated world (by name, not by ext id).
  console.log("[fix] resolving Feed Sorter content-script context …");
  let fs = await findFeedSorterContext(pageCdp);
  if (!fs) {
    console.warn("[fix] Feed Sorter content-script not detected yet. Reloading the IG tab to retrigger injection …");
    await pageCdp.send("Page.enable");
    await pageCdp.send("Page.reload");
    await new Promise((r) => setTimeout(r, 5000));
    fs = await findFeedSorterContext(pageCdp);
  }
  if (!fs) {
    console.error("[fix] Feed Sorter content-script not found. Confirm the extension is enabled and has instagram.com host permission.");
    process.exit(3);
  }
  console.log("[fix] Feed Sorter:", { extensionId: fs.extensionId, contextId: fs.contextId, name: fs.name });

  // Reload the extension to pick up any background.js changes since the SW
  // last booted. chrome.runtime.reload() restarts the SW + reinjects content
  // scripts. We then re-find the context after reload.
  const SHOULD_RELOAD = process.argv.includes("--no-reload") ? false : true;
  if (SHOULD_RELOAD) {
    console.log("[fix] forcing chrome.runtime.reload() + reloading IG page …");
    try {
      await pageCdp.send("Runtime.evaluate", {
        expression: "chrome.runtime.reload()",
        contextId: fs.contextId,
      });
    } catch (e) { /* expected: the eval gets killed by the reload */ }
    // After chrome.runtime.reload(), MV3 does NOT re-inject content scripts
    // into already-loaded tabs — the tab must navigate. Reload the page.
    await new Promise((r) => setTimeout(r, 1500));
    await pageCdp.send("Page.enable");
    // Manually clear our context cache so we don't reuse the stale id.
    pageCdp.contexts.clear();
    await pageCdp.send("Page.reload");
    // Wait for the page to load and for the content script to inject. Poll
    // for a *fresh* Feed Sorter isolated world (the cache was cleared above).
    const deadline = Date.now() + 30000;
    let fs2 = null;
    while (Date.now() < deadline) {
      fs2 = await findFeedSorterContext(pageCdp, { wait: 500 });
      if (fs2 && fs2.contextId !== fs.contextId) break;
      fs2 = null;
      process.stdout.write("r");
    }
    process.stdout.write("\n");
    if (!fs2) { console.error("[fix] Feed Sorter context didn't reappear after reload. Aborting."); process.exit(4); }
    fs.contextId = fs2.contextId;
    console.log("[fix] Feed Sorter (post-reload) contextId:", fs.contextId);
    // Give __fsStore a moment to initialize the IDB connection.
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Helper: eval inside Feed Sorter's isolated world (chrome.* fully bound,
  // and writes go to THE RIGHT extension's storage).
  const csEval = async (expr) => {
    const r = await pageCdp.send("Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      contextId: fs.contextId,
    });
    if (r.exceptionDetails) throw new Error("csEval: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  };

  // 3. Write token + baseUrl from the content-script context (chrome.storage works here).
  console.log("[fix] writing fs.api.token + fs.api.baseUrl from content-script context …");
  const writeResult = await csEval(`new Promise((resolve) => {
    chrome.storage.local.set({
      "fs.api.token": ${JSON.stringify(TOKEN)},
      "fs.api.baseUrl": ${JSON.stringify(API_BASE_URL)},
    }, () => resolve(chrome.runtime.lastError ? chrome.runtime.lastError.message : "ok"));
  })`);
  console.log("[fix] storage write:", writeResult);

  // 4. Read posts from the page IDB (via __fsStore exposed on window by
  //    content.js — lives in the isolated world). Ship to SW for clustering.
  console.log("[fix] reading posts from page IDB …");
  const postCount = await csEval(`(async () => {
    if (!window.__fsStore || typeof window.__fsStore.getAll !== "function") return -1;
    const rows = await window.__fsStore.getAll();
    return rows.length;
  })()`);
  console.log("[fix] posts in page IDB:", postCount);
  if (postCount <= 0) {
    console.warn("[fix] page IDB is empty or store not initialized — wait for IG to load and re-run, or scroll explore to capture posts first.");
    pageCdp.close();
    return;
  }

  console.log("[fix] dispatching cluster-niches-now with", postCount, "posts …");
  const ack = await csEval(`new Promise((resolve) => {
    window.__fsStore.getAll().then((rows) => {
      chrome.runtime.sendMessage(
        { type: "fs-bg", cmd: "cluster-niches-now", posts: rows },
        (resp) => resolve(resp || { ok: false, err: "no-response" })
      );
    });
  })`);
  console.log("[fix] cluster ack:", ack);

  // 4. Poll cluster-meta from the page (which can sendMessage to SW) until lastRunAt advances.
  console.log("[fix] polling cluster-meta (this can take 30-60s on first MiniLM load) …");
  const t0 = Date.now();
  const TIMEOUT_MS = 5 * 60 * 1000;
  let prevAt = 0;
  // Read prevAt
  prevAt = await csEval(`new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "fs-bg", cmd: "cluster-meta" }, (r) => resolve(r?.meta?.lastRunAt || 0));
  })`);
  console.log("[fix] prev cluster lastRunAt:", prevAt);

  while (Date.now() - t0 < TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 2000));
    const meta = await csEval(`new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "fs-bg", cmd: "cluster-meta" }, (r) => resolve(r?.meta || null));
    })`);
    if (meta && meta.lastRunAt && meta.lastRunAt > prevAt) {
      console.log("\n[fix] === CLUSTER COMPLETE ===");
      console.log("ms:           ", meta.ms);
      console.log("creatorCount: ", meta.creatorCount);
      console.log("clusters:     ", meta.clusters?.length || 0);
      if (meta.clusters?.length) {
        console.log("\nclusters (sorted by member count):");
        const sorted = [...meta.clusters].sort((a, b) => (b.members?.length || 0) - (a.members?.length || 0));
        for (const c of sorted.slice(0, 20)) {
          console.log(`  ${String(c.members?.length || 0).padStart(4)}  ${c.label}`);
          if (c.members?.length) console.log(`        ${c.members.slice(0, 5).join(", ")}${c.members.length > 5 ? `, +${c.members.length - 5} more` : ""}`);
        }
      }
      pageCdp.close();
      return;
    }
    process.stdout.write(".");
  }
  console.error("\n[fix] cluster-meta timeout — check SW console for errors.");
  pageCdp.close();
  process.exit(3);
};

main().catch((e) => { console.error("[fix]", e); process.exit(1); });
