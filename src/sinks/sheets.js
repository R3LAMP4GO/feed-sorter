// Google Sheets sink — POSTs `{rows: [...]}` to a user-provided Apps Script
// web-app URL. No OAuth: the Apps Script is the auth boundary (the user's
// own deployment, executed as them).
//
// User pastes the deployment URL in Settings → Sinks → Google Sheets. See
// README for the copy-paste Apps Script template.

(() => {
  const api = window.__fsSinks;
  if (!api) return;

  const NAME = "sheets";
  const limiter = new api.RateLimiter(5); // local rate cap; Apps Script is generous

  const buildPayload = (rows) => ({
    source: "feed-sorter-ig",
    generatedAt: new Date().toISOString(),
    rows: rows.map((r) => ({
      id: r.id,
      shortcode: r.shortcode,
      author: r.author,
      desc: r.desc,
      url: r.url,
      cover: r.cover,
      videoUrl: r.videoUrl,
      surface: r.surface,
      likes: r.likes,
      views: r.views,
      comments: r.comments,
      score: r.score,
      createdAt: r.createdISO,
    })),
  });

  const test = async (cfg) => {
    if (!cfg || !cfg.url) return { ok: false, msg: "set the Apps Script web-app URL first" };
    const r = await limiter.runWithBackoff(() =>
      api.post({ url: cfg.url, body: { ...buildPayload([]), test: true } }),
    );
    return { ok: !!r.ok, msg: r.ok ? `ping ok (${r.status})` : `failed: ${r.status || r.err}`, status: r.status };
  };

  const push = async (rows, cfg, onProgress) => {
    if (!cfg || !cfg.url) return { ok: false, sent: 0, failed: rows.length, errors: ["no-url"] };
    if (!rows.length) return { ok: true, sent: 0, failed: 0, errors: [] };
    // Apps Script accepts the whole batch in one POST (it iterates server-side).
    // Chunk anyway so we surface progress and stay under URL/body limits (~50MB
    // hard cap, but we cap at 500 rows per request for sanity).
    const chunks = api.chunk(rows.map(api.mapPost), 500);
    let sent = 0;
    const errors = [];
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const r = await limiter.runWithBackoff(() =>
        api.post({ url: cfg.url, body: buildPayload(c) }),
      );
      if (r.ok) {
        sent += c.length;
        if (onProgress) for (let j = 0; j < c.length; j++) onProgress(sent - c.length + j + 1, rows.length, "ok");
      } else {
        errors.push(`chunk ${i}: ${r.status || r.err}`);
        if (onProgress) for (let j = 0; j < c.length; j++) onProgress(sent + j + 1, rows.length, "fail");
      }
    }
    return { ok: errors.length === 0, sent, failed: rows.length - sent, errors };
  };

  api.register({ name: NAME, label: "Google Sheets", test, push });
})();
