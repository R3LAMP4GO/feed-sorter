// Notion sink — creates one page per row in the user's database. Notion's
// public rate limit is ~3 requests/second per integration; we cap to that
// and back off on 429.
//
// Required database properties (create them in Notion before syncing):
//   Name      — Title
//   Author    — Text
//   Caption   — Text
//   URL       — URL
//   id        — Text         (used here just for trace; Notion has no upsert)
//   Likes, Views, Comments, Score — Number
//   Surface   — Select       (auto-creates options when typecast)
//   Date      — Date
//
// Notion has no upsert primitive — re-syncing creates duplicate pages. To
// avoid duplicates, archive the database between syncs or filter the view
// before pressing "Sync now".

(() => {
  const api = window.__fsSinks;
  if (!api) return;

  const NAME = "notion";
  const RPS = 3;
  const NOTION_VERSION = "2022-06-28";
  const limiter = new api.RateLimiter(RPS);

  const headers = (cfg) => ({
    Authorization: `Bearer ${cfg.token}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  });

  const richText = (s) => [{ type: "text", text: { content: String(s || "").slice(0, 1900) } }];

  const pageBody = (r, databaseId) => {
    const properties = {
      Name: { title: richText(r.desc ? r.desc.slice(0, 80) : (r.shortcode || r.id)) },
      Author: { rich_text: richText(r.author) },
      Caption: { rich_text: richText(r.desc) },
      URL: { url: r.url || null },
      id: { rich_text: richText(r.id) },
      Likes: { number: r.likes || 0 },
      Views: { number: r.views || 0 },
      Comments: { number: r.comments || 0 },
      Score: { number: Number((r.score || 0).toFixed(4)) },
      Surface: r.surface ? { select: { name: r.surface } } : { select: null },
    };
    if (r.createdISO) properties.Date = { date: { start: r.createdISO } };
    const body = { parent: { database_id: databaseId }, properties };
    if (r.cover) body.cover = { type: "external", external: { url: r.cover } };
    return body;
  };

  const validateCfg = (cfg) => {
    if (!cfg) return "missing config";
    if (!cfg.token) return "missing token";
    if (!cfg.databaseId) return "missing databaseId";
    return "";
  };

  const test = async (cfg) => {
    const err = validateCfg(cfg);
    if (err) return { ok: false, msg: err };
    // Retrieve database — verifies token + databaseId + grant.
    const r = await limiter.runWithBackoff(() =>
      api.post({
        url: `https://api.notion.com/v1/databases/${encodeURIComponent(cfg.databaseId)}`,
        method: "GET",
        headers: headers(cfg),
      }),
    );
    if (r.ok) return { ok: true, msg: `auth ok (${r.status})`, status: r.status };
    let detail = r.status || r.err;
    try {
      const j = r.json || (r.text && JSON.parse(r.text));
      if (j?.message) detail = `${r.status} ${j.code || ""}: ${j.message}`;
    } catch {}
    return { ok: false, msg: `failed: ${detail}`, status: r.status };
  };

  const push = async (rows, cfg, onProgress) => {
    const errMsg = validateCfg(cfg);
    if (errMsg) return { ok: false, sent: 0, failed: rows.length, errors: [errMsg] };
    if (!rows.length) return { ok: true, sent: 0, failed: 0, errors: [] };

    const mapped = rows.map(api.mapPost);
    let sent = 0;
    const errors = [];
    for (let i = 0; i < mapped.length; i++) {
      const r = mapped[i];
      const resp = await limiter.runWithBackoff(() =>
        api.post({
          url: "https://api.notion.com/v1/pages",
          method: "POST",
          headers: headers(cfg),
          body: pageBody(r, cfg.databaseId),
        }),
      );
      if (resp.ok) {
        sent++;
        if (onProgress) onProgress(i + 1, mapped.length, "ok");
      } else {
        let detail = resp.status || resp.err;
        try {
          const j = resp.json || (resp.text && JSON.parse(resp.text));
          if (j?.message) detail = `${resp.status} ${j.code || ""}: ${j.message}`;
        } catch {}
        errors.push(`row ${i} (${r.id}): ${detail}`);
        if (onProgress) onProgress(i + 1, mapped.length, "fail");
      }
    }
    return { ok: errors.length === 0, sent, failed: mapped.length - sent, errors };
  };

  api.register({ name: NAME, label: "Notion", test, push });
})();
