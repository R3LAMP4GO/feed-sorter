// Airtable sink — upserts records by `id` so re-syncing the same view
// doesn't dupe rows. Uses the documented `performUpsert` PATCH endpoint;
// up to 10 records per request. Rate limit: 5 req/s per base.
//
// Required Airtable table fields (create them in your base before syncing):
//   id        — Single line text  (the merge key)
//   shortcode — Single line text
//   author    — Single line text
//   desc      — Long text
//   url       — URL
//   cover     — Attachment        (Airtable will fetch the image)
//   coverUrl  — URL               (raw fallback if you don't want attachments)
//   surface   — Single select     (options: profile, reels, explore, graphql)
//   likes, views, comments, score — Number
//   createdAt — Date              (with time, ISO accepted)

(() => {
  const api = window.__fsSinks;
  if (!api) return;

  const NAME = "airtable";
  const RPS = 5;
  const limiter = new api.RateLimiter(RPS);

  const tableUrl = (cfg) =>
    `https://api.airtable.com/v0/${encodeURIComponent(cfg.baseId)}/${encodeURIComponent(cfg.table)}`;

  const headers = (cfg) => ({
    Authorization: `Bearer ${cfg.token}`,
    "Content-Type": "application/json",
  });

  const recordFields = (r) => ({
    id: r.id,
    shortcode: r.shortcode,
    author: r.author,
    desc: r.desc,
    url: r.url,
    cover: r.cover ? [{ url: r.cover }] : [],
    coverUrl: r.cover,
    surface: r.surface,
    likes: r.likes,
    views: r.views,
    comments: r.comments,
    score: r.score,
    createdAt: r.createdISO || undefined,
  });

  const validateCfg = (cfg) => {
    if (!cfg) return "missing config";
    if (!cfg.token) return "missing token";
    if (!cfg.baseId) return "missing baseId";
    if (!cfg.table) return "missing table";
    return "";
  };

  const test = async (cfg) => {
    const err = validateCfg(cfg);
    if (err) return { ok: false, msg: err };
    // GET with maxRecords=1 — cheapest auth probe.
    const r = await limiter.runWithBackoff(() =>
      api.post({
        url: `${tableUrl(cfg)}?maxRecords=1`,
        method: "GET",
        headers: headers(cfg),
      }),
    );
    if (r.ok) return { ok: true, msg: `auth ok (${r.status})`, status: r.status };
    let detail = r.status || r.err;
    try {
      const j = r.json || (r.text && JSON.parse(r.text));
      if (j?.error) detail = `${r.status} ${j.error.type || ""}: ${j.error.message || j.error}`;
    } catch {}
    return { ok: false, msg: `failed: ${detail}`, status: r.status };
  };

  // Generic chunked-PATCH-upsert helper. Used for both legacy + unified tables.
  const upsertRecords = async (cfgLike, table, records, rowsLen, onProgress) => {
    const url = `https://api.airtable.com/v0/${encodeURIComponent(cfgLike.baseId)}/${encodeURIComponent(table)}`;
    const chunks = api.chunk(records, 10);
    let sent = 0;
    const errors = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const body = {
        performUpsert: { fieldsToMergeOn: ["id"] },
        typecast: true,
        records: c.map((r) => ({ fields: r })),
      };
      const r = await limiter.runWithBackoff(() =>
        api.post({ url, method: "PATCH", headers: headers(cfgLike), body }),
      );
      if (r.ok) {
        sent += c.length;
        if (onProgress) for (let j = 0; j < c.length; j++) onProgress(sent - c.length + j + 1, rowsLen, "ok");
      } else {
        let detail = r.status || r.err;
        try {
          const j = r.json || (r.text && JSON.parse(r.text));
          if (j?.error) detail = `${r.status} ${j.error.type || ""}: ${j.error.message || j.error}`;
        } catch {}
        errors.push(`[${table}] chunk ${i}: ${detail}`);
        if (onProgress) for (let j = 0; j < c.length; j++) onProgress(sent + j + 1, rowsLen, "fail");
      }
    }
    return { sent, errors };
  };

  const push = async (rows, cfg, onProgress) => {
    const errMsg = validateCfg(cfg);
    if (errMsg) return { ok: false, sent: 0, failed: rows.length, errors: [errMsg] };
    if (!rows.length) return { ok: true, sent: 0, failed: 0, errors: [] };

    // 1) Legacy per-platform table (existing contract — unchanged).
    const legacyRecords = rows.map(api.mapPost).map(recordFields);
    const legacy = await upsertRecords(cfg, cfg.table, legacyRecords, rows.length, onProgress);

    // 2) Unified cross-platform table — opt-in via cfg.unifiedTable. Same
    //    base + token. Adapter lives in src/lib/unified.js so the TikTok
    //    and Shorts extensions emit identical rows.
    const unifiedApi = (typeof window !== "undefined" && window.__fsUnified) || null;
    let unifiedErrors = [];
    if (cfg.unifiedTable && unifiedApi) {
      const extVer = (chrome.runtime.getManifest?.().version) || "";
      const unifiedRows = rows
        .map((p) => {
          try { return unifiedApi.fromInstagramPost(p, { extensionVersion: extVer }); }
          catch { return null; }
        })
        .filter(Boolean)
        .map(unifiedApi.unifiedToAirtableFields);
      if (unifiedRows.length) {
        const u = await upsertRecords(cfg, cfg.unifiedTable, unifiedRows, unifiedRows.length, null);
        unifiedErrors = u.errors.map((e) => `unified ${e}`);
      }
    }

    const errors = [...legacy.errors, ...unifiedErrors];
    return { ok: errors.length === 0, sent: legacy.sent, failed: rows.length - legacy.sent, errors };
  };

  api.register({ name: NAME, label: "Airtable", test, push });
})();
