// Per-post LLM repurposing: TikTok / YT Shorts / X (Twitter) / LinkedIn.
//
// Pure ES module — no chrome APIs, no DOM. Safe for unit tests; the runtime
// (content.js) calls it through the llm-bridge by passing a `chat` adapter
// and the IDB-backed `store` adapter (the same shape as `window.__fsStore`).
//
// Contract (pinned for the UI/bulk integration):
//
//   rewritePost(post, platforms, {
//     chat,                    // async ({ model, messages, schema, kind, postId, options }) → { json, ... }
//     store = null,            // optional { putRewrite } — when set, persists each result
//     model = "gemma4",        // text-only Gemma; rewrites never need vision
//     voice = null,            // user's OWN voice fingerprint when "me" is set
//     nudge = "",              // optional free-text steering ("more aggressive hook")
//     signal = null,
//     onPlatform = null,       // optional ({ platform, status, result, err }) → void hook
//   }) → Promise<{
//     postId,
//     model,
//     generatedAt,
//     usedVoice: boolean,
//     voiceUsername: string | null,
//     results: { tiktok?, yt_shorts?, x?, linkedin? },
//     errors:  { tiktok?, yt_shorts?, x?, linkedin? },
//   }>
//
// `platforms` is a string[] from PLATFORMS. Order is preserved; calls run
// SEQUENTIALLY (concurrency 1) so we don't thrash the local model.
//
// `voice` shape mirrors src/analysis/voice-fingerprint.js. Pass the USER's
// own fingerprint (the one designated as "me" via the settings flag), NOT
// the source creator's — the whole point is to translate the source into
// the user's own voice.

import { buildSystemPrompt as buildVoiceSystemPrompt } from "./voice-fingerprint.js";

export const PLATFORMS = ["tiktok", "yt_shorts", "x", "linkedin"];

// -------------------- per-platform schemas --------------------

export const TIKTOK_SCHEMA = {
  type: "object",
  properties: {
    hook: { type: "string", description: "Opening line spoken in the first 1.5 seconds (≤12 words)." },
    script: { type: "string", description: "Full voice-over script targeting 30–60 seconds when read aloud (~80–160 words)." },
    hashtags: {
      type: "array",
      items: { type: "string" },
      description: "1–2 hashtags WITHOUT the leading #.",
    },
    cta: { type: "string", description: "One-line call-to-action at the end of the script (≤15 words)." },
  },
  required: ["hook", "script", "hashtags", "cta"],
};

export const YT_SHORTS_SCHEMA = {
  type: "object",
  properties: {
    hook: { type: "string", description: "Opening line in the first second (≤12 words)." },
    script: { type: "string", description: "Full voice-over script targeting 30–50 seconds (~70–130 words). Use retention-optimized cuts: pattern interrupts every 5–8s." },
    onScreenText: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tStart: { type: "number", description: "Start time in seconds (integer-ish)." },
          text: { type: "string", description: "On-screen overlay text (≤6 words, ALL CAPS or sentence case)." },
        },
        required: ["tStart", "text"],
      },
      description: "One overlay every 3–5 seconds across the full duration.",
    },
    cta: { type: "string", description: "One-line CTA (≤15 words). Subscribe / comment / save." },
  },
  required: ["hook", "script", "onScreenText", "cta"],
};

export const X_SCHEMA = {
  type: "object",
  properties: {
    single: { type: "string", description: "Standalone tweet, MUST be ≤280 characters including spaces. No hashtags unless essential." },
    thread: {
      type: "array",
      items: { type: "string" },
      description: "2–5 tweets, each MUST be ≤280 characters. First tweet is the hook; last tweet is the CTA.",
    },
  },
  required: ["single", "thread"],
};

export const LINKEDIN_SCHEMA = {
  type: "object",
  properties: {
    post: { type: "string", description: "200–400 word post. Professional tone. Short paragraphs, line breaks for scannability. End with a question (the CTA)." },
    hashtags: {
      type: "array",
      items: { type: "string" },
      description: "1–3 thoughtful hashtags WITHOUT the leading #.",
    },
  },
  required: ["post", "hashtags"],
};

export const PLATFORM_META = {
  tiktok: {
    label: "TikTok",
    schema: TIKTOK_SCHEMA,
    constraintSummary: [
      "Vertical short-form video script.",
      "Length: 30–60 seconds when read aloud (≈80–160 words).",
      "Hook MUST land in the first 1.5 seconds — front-load the payoff.",
      "Include 1–2 hashtags, no more.",
      "End with one explicit CTA (save, follow, comment).",
    ].join("\n"),
  },
  yt_shorts: {
    label: "YouTube Shorts",
    schema: YT_SHORTS_SCHEMA,
    constraintSummary: [
      "Vertical short-form video script.",
      "Length: 30–50 seconds (≈70–130 words).",
      "Hook MUST land in the first 1 second.",
      "Provide on-screen text suggestions every 3–5 seconds across the entire duration.",
      "Use retention-optimized pattern interrupts every 5–8 seconds.",
      "End with one explicit CTA (subscribe, comment, save).",
    ].join("\n"),
  },
  x: {
    label: "X (Twitter)",
    schema: X_SCHEMA,
    constraintSummary: [
      "Two variants required.",
      "`single`: ONE standalone tweet, ≤280 characters total (incl. spaces). No hashtags unless essential.",
      "`thread`: 2–5 tweets, each ≤280 characters. Tweet 1 is the hook. Tweet N is the CTA.",
      "Be punchy. Short sentences. No emoji unless it carries meaning.",
    ].join("\n"),
  },
  linkedin: {
    label: "LinkedIn",
    schema: LINKEDIN_SCHEMA,
    constraintSummary: [
      "Long-form post.",
      "Length: 200–400 words.",
      "Professional, thoughtful tone — no hype, no bro-speak.",
      "Use short paragraphs (1–3 sentences) with empty lines between them for scannability.",
      "1–3 thoughtful hashtags, returned WITHOUT the leading #.",
      "CTA MUST be framed as an open-ended question at the end of the post.",
    ].join("\n"),
  },
};

const NEUTRAL_SYSTEM = [
  "You are a senior social-media editor.",
  "You repurpose a source post into a polished version for a SPECIFIC platform.",
  "You preserve the source's substance, claims, and key examples.",
  "You DO NOT invent facts not present in the source caption or transcript.",
  "Match the platform's native conventions (length, tone, structure).",
  "Return strict JSON matching the schema. No markdown fences, no commentary.",
].join("\n");

// Build the system message. If `voice` is provided we mimic that voice,
// otherwise we fall back to a neutral editorial system prompt.
export function buildSystemPrompt(voice) {
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
  return NEUTRAL_SYSTEM;
}

const truncate = (s, n) => {
  const t = String(s || "").trim();
  if (!t) return "";
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

// Build the user message for a given platform. Includes:
//   - the original caption (truncated)
//   - the transcript if present (truncated)
//   - the post's hookType / topic / angle from analysis when available
//   - the target platform's constraint summary
//   - optional `nudge` (regenerate-with-nudge)
export function buildUserPrompt(post, platform, { nudge = "" } = {}) {
  const meta = PLATFORM_META[platform];
  if (!meta) throw new Error(`buildUserPrompt: unknown platform "${platform}"`);
  const ai = (post?.ai) || {};
  const author = String((post?.author) || "").trim();
  const caption = truncate(post?.desc, 1200);
  const transcript = truncate(post?.transcript, 2000);

  const lines = [
    `TARGET PLATFORM: ${meta.label}`,
    "",
    "PLATFORM CONSTRAINTS (obey strictly):",
    meta.constraintSummary,
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

  const nudgeStr = String(nudge || "").trim();
  if (nudgeStr) {
    lines.push("", `EDITORIAL NUDGE (apply on top of constraints): ${truncate(nudgeStr, 300)}`);
  }

  lines.push(
    "",
    `Now produce the rewrite for ${meta.label}. Return strict JSON matching the schema.`,
  );

  return lines.filter((l) => l !== null).join("\n");
}

// -------------------- per-platform validators --------------------
//
// We DO NOT throw on validation failure — the LLM may return slightly off
// shapes and we'd rather surface a soft warning than nuke the whole batch.
// Each validator returns an array of { code, msg } warnings; the caller
// attaches them to the result row.

const charLen = (s) => String(s || "").length;

const validateTiktok = (j) => {
  const w = [];
  if (!j || typeof j !== "object") return [{ code: "shape", msg: "missing object" }];
  if (!j.hook) w.push({ code: "missing-hook", msg: "no hook" });
  if (!j.script) w.push({ code: "missing-script", msg: "no script" });
  const wc = String(j.script || "").trim().split(/\s+/).filter(Boolean).length;
  if (wc && (wc < 60 || wc > 200)) w.push({ code: "script-length", msg: `script ${wc} words (target 80–160)` });
  const tags = Array.isArray(j.hashtags) ? j.hashtags : [];
  if (tags.length < 1 || tags.length > 2) w.push({ code: "hashtags", msg: `${tags.length} hashtags (target 1–2)` });
  if (!j.cta) w.push({ code: "missing-cta", msg: "no CTA" });
  return w;
};

const validateYtShorts = (j) => {
  const w = [];
  if (!j || typeof j !== "object") return [{ code: "shape", msg: "missing object" }];
  if (!j.hook) w.push({ code: "missing-hook", msg: "no hook" });
  if (!j.script) w.push({ code: "missing-script", msg: "no script" });
  const wc = String(j.script || "").trim().split(/\s+/).filter(Boolean).length;
  if (wc && (wc < 50 || wc > 170)) w.push({ code: "script-length", msg: `script ${wc} words (target 70–130)` });
  const ost = Array.isArray(j.onScreenText) ? j.onScreenText : [];
  if (ost.length < 4) w.push({ code: "onscreen-sparse", msg: `only ${ost.length} on-screen text cues` });
  if (!j.cta) w.push({ code: "missing-cta", msg: "no CTA" });
  return w;
};

const validateX = (j) => {
  const w = [];
  if (!j || typeof j !== "object") return [{ code: "shape", msg: "missing object" }];
  if (!j.single) w.push({ code: "missing-single", msg: "no single" });
  if (charLen(j.single) > 280) w.push({ code: "single-too-long", msg: `single is ${charLen(j.single)} chars` });
  const thread = Array.isArray(j.thread) ? j.thread : [];
  if (thread.length < 2) w.push({ code: "thread-short", msg: `thread has ${thread.length} tweets` });
  if (thread.length > 5) w.push({ code: "thread-long", msg: `thread has ${thread.length} tweets (max 5)` });
  thread.forEach((t, i) => {
    if (charLen(t) > 280) w.push({ code: "thread-tweet-too-long", msg: `tweet ${i + 1} is ${charLen(t)} chars` });
  });
  return w;
};

const validateLinkedin = (j) => {
  const w = [];
  if (!j || typeof j !== "object") return [{ code: "shape", msg: "missing object" }];
  if (!j.post) w.push({ code: "missing-post", msg: "no post" });
  const wc = String(j.post || "").trim().split(/\s+/).filter(Boolean).length;
  if (wc && (wc < 150 || wc > 500)) w.push({ code: "post-length", msg: `post ${wc} words (target 200–400)` });
  if (j.post && !/\?\s*$/.test(String(j.post).trim())) {
    w.push({ code: "no-question-cta", msg: "post does not end with a question" });
  }
  const tags = Array.isArray(j.hashtags) ? j.hashtags : [];
  if (tags.length < 1 || tags.length > 3) w.push({ code: "hashtags", msg: `${tags.length} hashtags (target 1–3)` });
  return w;
};

const VALIDATORS = {
  tiktok: validateTiktok,
  yt_shorts: validateYtShorts,
  x: validateX,
  linkedin: validateLinkedin,
};

// -------------------- main entry --------------------

const DEFAULT_TEMPERATURE = 0.7; // creative-but-bounded; rewrites need flair

export async function rewritePost(post, platforms, opts = {}) {
  if (!post || !post.id) throw new Error("rewritePost: post.id required");
  const chat = opts.chat;
  if (typeof chat !== "function") {
    throw new Error("rewritePost: opts.chat function required");
  }
  const targets = (Array.isArray(platforms) ? platforms : [])
    .map((p) => String(p || "").toLowerCase().trim())
    .filter((p) => PLATFORMS.includes(p));
  if (!targets.length) {
    throw new Error("rewritePost: at least one valid platform required");
  }
  const model = String(opts.model || "gemma4");
  const voice = opts.voice && typeof opts.voice === "object" ? opts.voice : null;
  const nudge = String(opts.nudge || "");
  const signal = opts.signal || null;
  const store = opts.store || null;
  const onPlatform = typeof opts.onPlatform === "function" ? opts.onPlatform : null;

  const systemMsg = { role: "system", content: buildSystemPrompt(voice) };

  const out = {
    postId: String(post.id),
    model,
    generatedAt: 0,
    usedVoice: !!voice,
    voiceUsername: voice ? (voice.username || null) : null,
    results: {},
    errors: {},
  };

  for (const platform of targets) {
    const meta = PLATFORM_META[platform];
    if (onPlatform) {
      try { onPlatform({ platform, status: "start" }); } catch { /* ignore */ }
    }
    const userMsg = { role: "user", content: buildUserPrompt(post, platform, { nudge }) };
    let json = null;
    let warnings = [];
    let raw = null;
    let durationMs = 0;
    try {
      const t0 = Date.now();
      const r = await chat({
        model,
        messages: [systemMsg, userMsg],
        schema: meta.schema,
        kind: `rewrite:${platform}`,
        postId: post.id,
        options: { temperature: DEFAULT_TEMPERATURE },
        signal,
      });
      durationMs = Date.now() - t0;
      if (!r || !r.json) {
        throw new Error("chat returned no JSON");
      }
      json = r.json;
      raw = r.text || null;
      warnings = VALIDATORS[platform](json);
    } catch (e) {
      const errMsg = String((e?.message) || e);
      out.errors[platform] = errMsg;
      if (onPlatform) {
        try { onPlatform({ platform, status: "fail", err: errMsg }); } catch { /* ignore */ }
      }
      continue;
    }

    const row = {
      postId: String(post.id),
      platform,
      model,
      generatedAt: Date.now(),
      usedVoice: !!voice,
      voiceUsername: voice ? (voice.username || null) : null,
      nudge: nudge || "",
      data: json,
      raw,
      warnings,
      durationMs,
    };
    out.results[platform] = row;

    if (store && typeof store.putRewrite === "function") {
      try { await store.putRewrite(row); }
      catch (e) {
        // Persistence failure is non-fatal; record under errors but keep result.
        out.errors[`${platform}:persist`] = String((e?.message) || e);
      }
    }
    if (onPlatform) {
      try { onPlatform({ platform, status: "ok", result: row }); } catch { /* ignore */ }
    }
  }

  out.generatedAt = Date.now();
  return out;
}

// -------------------- markdown export (bulk) --------------------

const fmtTags = (tags) =>
  (Array.isArray(tags) ? tags : [])
    .map((t) => `#${String(t || "").replace(/^#/, "").trim()}`)
    .filter((s) => s.length > 1)
    .join(" ");

// Render ONE post's rewrite-bundle into a markdown section.
export function renderRewriteMarkdown(post, bundle) {
  const lines = [];
  const author = (post?.author) || "(unknown)";
  const url = (post?.url) || "";
  const score = post && typeof post._score === "number" ? `${post._score.toFixed(2)}×` : "n/a";
  lines.push(`## @${author} — ${score}`);
  if (url) lines.push(`<${url}>`);
  lines.push("");
  if (post?.desc) {
    lines.push("**Original caption:**");
    lines.push(`> ${String(post.desc).replace(/\n/g, "\n> ")}`);
    lines.push("");
  }
  for (const platform of PLATFORMS) {
    const r = bundle?.results?.[platform];
    const meta = PLATFORM_META[platform];
    lines.push(`### ${meta.label}`);
    if (!r) {
      const err = bundle?.errors?.[platform];
      lines.push(`_Failed: ${err || "no result"}_`);
      lines.push("");
      continue;
    }
    const d = r.data || {};
    if (platform === "tiktok") {
      lines.push(`**Hook:** ${d.hook || ""}`);
      lines.push("");
      lines.push("**Script:**");
      lines.push(d.script || "");
      lines.push("");
      lines.push(`**CTA:** ${d.cta || ""}`);
      const tags = fmtTags(d.hashtags);
      if (tags) lines.push(`**Hashtags:** ${tags}`);
    } else if (platform === "yt_shorts") {
      lines.push(`**Hook:** ${d.hook || ""}`);
      lines.push("");
      lines.push("**Script:**");
      lines.push(d.script || "");
      lines.push("");
      lines.push("**On-screen text:**");
      for (const t of (Array.isArray(d.onScreenText) ? d.onScreenText : [])) {
        lines.push(`- t=${t.tStart}s — ${t.text}`);
      }
      lines.push("");
      lines.push(`**CTA:** ${d.cta || ""}`);
    } else if (platform === "x") {
      lines.push("**Single:**");
      lines.push(`> ${String(d.single || "").replace(/\n/g, "\n> ")}`);
      lines.push("");
      lines.push("**Thread:**");
      (Array.isArray(d.thread) ? d.thread : []).forEach((t, i) => {
        lines.push(`${i + 1}. ${t}`);
      });
    } else if (platform === "linkedin") {
      lines.push(d.post || "");
      lines.push("");
      const tags = fmtTags(d.hashtags);
      if (tags) lines.push(`**Hashtags:** ${tags}`);
    }
    if (Array.isArray(r.warnings) && r.warnings.length) {
      lines.push("");
      lines.push(`_warnings: ${r.warnings.map((w) => w.code).join(", ")}_`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// Build the full batch markdown file: one section per post.
export function renderBatchMarkdown(items, { date = new Date() } = {}) {
  const head = [
    `# Repurpose batch — ${date.toISOString().slice(0, 10)}`,
    "",
    `${items.length} post${items.length === 1 ? "" : "s"} · ${PLATFORMS.length} platforms each`,
    "",
    "---",
    "",
  ].join("\n");
  const sections = items.map(({ post, bundle }) => renderRewriteMarkdown(post, bundle));
  return head + sections.join("\n---\n\n");
}
