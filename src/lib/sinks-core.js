// Pure sink helpers — mapping + rate limiting. Tested with vitest.
// No `chrome.*` references; browser glue lives in src/sinks/*.

/**
 * Common slim row shape sent over the wire to every sink.
 * Mirrors content.js `slimPost` so external systems see one schema.
 */
export const mapPost = (p) => ({
  id: String(p.id || ""),
  shortcode: String(p.shortcode || ""),
  author: String(p.author || ""),
  desc: String(p.desc || "").slice(0, 1000),
  createTime: Number(p.createTime || 0),
  createdISO: p.createTime ? new Date(p.createTime * 1000).toISOString() : "",
  surface: String(p.surface || ""),
  likes: Number(p.likes || 0),
  views: Number(p.views || 0),
  comments: Number(p.comments || 0),
  score: Number(p._score || p.score || 0),
  url: String(p.url || ""),
  cover: String(p.cover || ""),
  videoUrl: String(p.videoUrl || ""),
});

/**
 * Token-bucket-ish rate limiter: enforces minimum interval between calls
 * and applies exponential backoff on 429/5xx via `runWithBackoff`.
 */
export class RateLimiter {
  constructor(rps = 5) {
    this.minIntervalMs = Math.max(1, Math.floor(1000 / rps));
    this._next = 0;
  }
  async wait() {
    const now = Date.now();
    const slot = Math.max(now, this._next);
    this._next = slot + this.minIntervalMs;
    const delay = slot - now;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  }
  /** retry on 429 / 5xx with exponential backoff (cap 4 attempts). */
  async runWithBackoff(fn, { attempts = 4, baseMs = 500 } = {}) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      await this.wait();
      const r = await fn();
      if (r?.ok) return r;
      const s = (r?.status) || 0;
      const transient = s === 429 || (s >= 500 && s < 600) || s === 0;
      lastErr = r;
      if (!transient) return r;
      // honour Retry-After if present (seconds)
      const ra = r?.retryAfter ? Number(r.retryAfter) * 1000 : 0;
      const backoff = Math.max(ra, baseMs * 2 ** i);
      await new Promise((res) => setTimeout(res, backoff));
    }
    return lastErr || { ok: false, status: 0, err: "exhausted" };
  }
}

// -------- Airtable mapping --------

/** Build an Airtable upsert body for a chunk of mapped rows (≤10). */
export const airtableUpsertBody = (rows) => ({
  performUpsert: { fieldsToMergeOn: ["id"] },
  typecast: true,
  records: rows.map((r) => ({
    fields: {
      id: r.id,
      shortcode: r.shortcode,
      author: r.author,
      desc: r.desc,
      url: r.url,
      cover: r.cover ? [{ url: r.cover }] : [], // Attachment field
      coverUrl: r.cover, // plain URL field as fallback
      surface: r.surface,
      likes: r.likes,
      views: r.views,
      comments: r.comments,
      score: r.score,
      createdAt: r.createdISO || undefined,
    },
  })),
});

export const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// -------- Notion mapping --------

const notionRich = (s) => [{ type: "text", text: { content: String(s || "").slice(0, 1900) } }];

/** Build a Notion page body for one mapped row. */
export const notionPageBody = (r, databaseId) => {
  const props = {
    Name: { title: notionRich(r.desc ? r.desc.slice(0, 80) : (r.shortcode || r.id)) },
    Author: { rich_text: notionRich(r.author) },
    Caption: { rich_text: notionRich(r.desc) },
    URL: { url: r.url || null },
    id: { rich_text: notionRich(r.id) },
    Likes: { number: r.likes || 0 },
    Views: { number: r.views || 0 },
    Comments: { number: r.comments || 0 },
    Score: { number: Number((r.score || 0).toFixed(4)) },
    Surface: r.surface ? { select: { name: r.surface } } : { select: null },
  };
  if (r.createdISO) props.Date = { date: { start: r.createdISO } };
  const body = { parent: { database_id: databaseId }, properties: props };
  if (r.cover) body.cover = { type: "external", external: { url: r.cover } };
  return body;
};

// -------- Sheets mapping --------

/** Apps Script gets `{rows: [{...}]}` — keep keys flat + stable for sheet columns. */
export const sheetsPayload = (rows) => ({
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
