// Cross-platform dashboard. Fetches the unified Airtable table and renders
// outliers using a per-platform median (so a TikTok view count doesn't
// out-rank an IG view count just because the absolute numbers differ).
//
// Read-only: never writes back to Airtable.

// Loaded as a classic <script>; depends on unified.js having registered
// itself on globalThis.__fsUnified before this file runs.
const Unified = globalThis.__fsUnified;
if (!Unified) throw new Error("unified.js not loaded");

const CFG_KEY = "fs.dashboard";
const SINKS_KEY = "fs.sinks";

const $ = (sel) => document.querySelector(sel);
const tbody = $("#grid tbody");
const statusEl = $("#status");

const state = {
  cfg: { token: "", baseId: "", table: "UnifiedPosts" },
  rows: [],
  loadedAt: 0,
};

// ---------- chrome.storage helpers ----------
function getStorage(key) {
  return new Promise((resolve) => {
    if (!globalThis.chrome?.storage?.local) return resolve(null);
    chrome.storage.local.get(key, (r) => resolve(r && r[key]));
  });
}
function setStorage(key, val) {
  return new Promise((resolve) => {
    if (!globalThis.chrome?.storage?.local) return resolve();
    chrome.storage.local.set({ [key]: val }, () => resolve());
  });
}

async function loadCfg() {
  const c = await getStorage(CFG_KEY);
  if (c && typeof c === "object") Object.assign(state.cfg, c);
  $("#cfg-token").value = state.cfg.token || "";
  $("#cfg-base").value = state.cfg.baseId || "";
  $("#cfg-table").value = state.cfg.table || "UnifiedPosts";
}

async function importFromIgSink() {
  const all = await getStorage(SINKS_KEY);
  const at = all && all.airtable;
  if (!at || !at.token) {
    setStatus("No Airtable creds found in IG extension config.", true);
    return;
  }
  state.cfg = {
    token: at.token,
    baseId: at.baseId,
    table: at.unifiedTable || "UnifiedPosts",
  };
  $("#cfg-token").value = state.cfg.token;
  $("#cfg-base").value = state.cfg.baseId;
  $("#cfg-table").value = state.cfg.table;
  await setStorage(CFG_KEY, state.cfg);
  setStatus("Imported. Loading rows…");
  await loadRows();
}

// ---------- Airtable list (paginated) ----------
async function airtableList(cfg) {
  const url0 = `https://api.airtable.com/v0/${encodeURIComponent(cfg.baseId)}/${encodeURIComponent(cfg.table)}?pageSize=100`;
  const headers = { Authorization: `Bearer ${cfg.token}` };
  const out = [];
  let url = url0;
  let safety = 50; // 5000 records cap
  while (url && safety-- > 0) {
    const r = await fetch(url, { headers, credentials: "omit" });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      throw new Error(`airtable ${r.status}: ${t.slice(0, 200)}`);
    }
    const j = await r.json();
    for (const rec of j.records || []) out.push(rec.fields || {});
    url = j.offset
      ? `${url0}&offset=${encodeURIComponent(j.offset)}`
      : null;
  }
  return out;
}

function setStatus(msg, isErr) {
  statusEl.textContent = msg;
  statusEl.style.color = isErr ? "#c00" : "";
}

async function loadRows() {
  const cfg = state.cfg;
  if (!cfg.token || !cfg.baseId || !cfg.table) {
    setStatus("Set Airtable token + base id + table name in Settings.", true);
    $("#settings").classList.remove("hidden");
    return;
  }
  setStatus("Loading from Airtable…");
  try {
    const raw = await airtableList(cfg);
    // Coerce types — Airtable returns strings/numbers based on field config.
    state.rows = raw.map((r) => ({
      id: String(r.id || ""),
      platform: String(r.platform || ""),
      author: String(r.author || ""),
      url: String(r.url || ""),
      createTime: Number(r.createTime || 0),
      views: Number(r.views || 0),
      likes: Number(r.likes || 0),
      comments: Number(r.comments || 0),
      shares: Number(r.shares || 0),
      saves: Number(r.saves || 0),
      durationSec: Number(r.durationSec || 0),
      transcript: String(r.transcript || ""),
      hookType: String(r.hookType || ""),
      sourceExtensionVersion: String(r.sourceExtensionVersion || ""),
    }));
    state.loadedAt = Date.now();
    render();
  } catch (e) {
    setStatus(`Load failed: ${e.message || e}`, true);
  }
}

// ---------- render ----------
function fmt(n) {
  if (!n) return "0";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n));
}
function fmtDate(s) {
  if (!s) return "";
  const d = new Date(s * 1000);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}
function scoreCls(s) {
  if (s >= 5) return "score-hi";
  if (s >= 2) return "score-mid";
  return "";
}

function render() {
  const platform = $("#f-platform").value;
  const metric = $("#f-metric").value;
  const minScore = Number($("#f-min").value) || 0;
  const q = $("#f-q").value.trim().toLowerCase();
  const sortKey = $("#f-sort").value;

  let rows = state.rows;
  if (platform) rows = rows.filter((r) => r.platform === platform);

  // Per-platform median outlier scoring — same formula as IG ext but
  // baselined against each platform's own median.
  rows = Unified.computeCrossPlatformOutliers(rows, metric);

  if (minScore > 0) rows = rows.filter((r) => r._score >= minScore);
  if (q) {
    rows = rows.filter((r) =>
      (r.author || "").toLowerCase().includes(q) ||
      (r.transcript || "").toLowerCase().includes(q),
    );
  }

  if (sortKey === "score") rows.sort((a, b) => b._score - a._score);
  else if (sortKey === "createTime") rows.sort((a, b) => b.createTime - a.createTime);
  else rows.sort((a, b) => (Number(b[sortKey]) || 0) - (Number(a[sortKey]) || 0));

  // Medians strip
  const medEl = $("#medians");
  const byPf = new Map();
  for (const r of state.rows) {
    if (!byPf.has(r.platform)) byPf.set(r.platform, []);
    if (r[metric] > 0) byPf.get(r.platform).push(r[metric]);
  }
  medEl.innerHTML = [...byPf.entries()]
    .map(([p, v]) => `<span class="pill">${p}: median ${metric}=${fmt(Unified.median(v))} (n=${v.length})</span>`)
    .join("");

  tbody.innerHTML = rows.slice(0, 500).map((r, i) => `
    <tr>
      <td class="num">${i + 1}</td>
      <td><span class="pf pf-${r.platform}">${r.platform}</span></td>
      <td class="author">@${r.author || "?"}</td>
      <td class="num ${scoreCls(r._score)}">${r._score ? r._score.toFixed(2) + "×" : "—"}</td>
      <td class="num">${fmt(r.views)}</td>
      <td class="num">${fmt(r.likes)}</td>
      <td class="num">${fmt(r.comments)}</td>
      <td class="num">${fmt(r.shares)}</td>
      <td>${fmtDate(r.createTime)}</td>
      <td>${r.hookType || ""}</td>
      <td>${r.url ? `<a href="${r.url}" target="_blank" rel="noopener">open</a>` : ""}</td>
    </tr>
  `).join("");

  setStatus(`${rows.length} rows · ${state.rows.length} loaded · ${new Date(state.loadedAt).toLocaleTimeString()}`);
}

// ---------- wiring ----------
$("#settings-toggle").addEventListener("click", () => {
  $("#settings").classList.toggle("hidden");
});
$("#cfg-save").addEventListener("click", async () => {
  state.cfg = {
    token: $("#cfg-token").value.trim(),
    baseId: $("#cfg-base").value.trim(),
    table: $("#cfg-table").value.trim() || "UnifiedPosts",
  };
  await setStorage(CFG_KEY, state.cfg);
  await loadRows();
});
$("#cfg-import").addEventListener("click", importFromIgSink);
$("#reload").addEventListener("click", loadRows);
for (const id of ["f-platform", "f-metric", "f-min", "f-q", "f-sort"]) {
  document.getElementById(id).addEventListener("input", () => {
    if (state.rows.length) render();
  });
}

(async () => {
  await loadCfg();
  if (state.cfg.token && state.cfg.baseId) await loadRows();
  else {
    $("#settings").classList.remove("hidden");
    setStatus("Configure Airtable in Settings to begin.");
  }
})();
