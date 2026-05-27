// Headline feature: one-click "outlier → multi-platform content pack" pipeline.
//
// Pure ES module — no chrome APIs, no DOM, no globals. Every side effect is
// injected so the orchestrator is fully unit-testable AND can be driven from
// the content script (browser context) or the background SW interchangeably.
//
// All AI runs LOCALLY:
//   - download   ← chrome.downloads (or browser fetch) via injected adapter
//   - transcribe ← faster-whisper sidecar at http://localhost:8787  (096ead1c)
//   - diagnose   ← Ollama multimodal Gemma at http://localhost:11434 (63ce6a86)
//   - rewrite    ← Ollama text Gemma + voice fingerprint        (a041ff13 + 92a84b4a)
//
// One entry point:
//
//   runRepurposePipeline({
//     posts,                       // pre-filtered, score-sorted Post[]
//     minScore = 2,                // floor for inclusion
//     count = 10,                  // top-N cap
//     platforms = PLATFORMS,
//     date = new Date(),
//     adapters: {
//       download,                  // ({post, folder, filename}) → {filename, bytes}
//       writeFile,                 // ({path, content}) → void  (text artifacts)
//       transcribe,                // ({post, folder, signal}) → {text, segments, language, model}
//       diagnose,                  // ({post, signal}) → diagnosis row
//       rewrite,                   // ({post, platforms, signal, onPlatform}) → bundle
//       health,                    // ({signal}) → {ollama:{ok, models, model}, whisper:{ok, model}}
//       store,                     // { getStep, putStep } sentinel cache for resume
//     },
//     signal,                      // AbortSignal — checked between every step
//     onEvent,                     // (evt) => void — progress stream
//   }) → Promise<{
//     ok: boolean,
//     completed: number,
//     skipped: number,
//     failed: number,
//     items: Array<{ post, folder, steps, errors, durationMs }>,
//     durationMs,
//     averagePerPostMs,            // moving avg of finished posts (for ETA)
//   }>
//
// Concurrency = 1. Whisper and multimodal Gemma both compete for CPU/GPU on
// a single dev machine; running >1 post in parallel just thrashes.

export const PLATFORMS = ["tiktok", "yt_shorts", "x", "linkedin"];

export const STEPS = ["download", "transcribe", "diagnose", "rewrite", "readme"];

// Per-platform sentinel ids stored alongside the main step ids.
export const platformStep = (platform) => `rewrite:${platform}`;

// -------------------- helpers (pure, exported for tests) --------------------

export const ymd = (d = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

const SAFE_SEG_RE = /[^A-Za-z0-9._-]+/g;
export const sanitizeSeg = (s) =>
  String(s || "").trim().replace(SAFE_SEG_RE, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "x";

export const folderForPost = (post, { date = new Date(), root = "feed-sorter-ig" } = {}) => {
  const author = sanitizeSeg(post?.author || "unknown");
  const sc = sanitizeSeg((post && (post.shortcode || post.id)) || "post");
  return `${root}/repurpose-${ymd(date)}/${author}-${sc}`;
};

// Carry over OPTION-specified candidates → ranked picks.
export const selectCandidates = (posts, { minScore = 2, count = 10 } = {}) => {
  const list = (Array.isArray(posts) ? posts : []).filter(
    (p) => p?.id && Number(p._score || 0) >= Number(minScore || 0),
  );
  // Score-desc; the caller usually pre-sorts but we don't trust it.
  list.sort((a, b) => (Number(b._score) || 0) - (Number(a._score) || 0));
  return list.slice(0, Math.max(1, count | 0));
};

// Throws if the AbortSignal has fired. Used between every awaitable hop so
// cancel takes effect within ≤1 step boundary.
export const throwIfAborted = (signal) => {
  if (signal?.aborted) {
    const e = new Error("aborted");
    e.name = "AbortError";
    throw e;
  }
};

// -------------------- artifact renderers (pure) --------------------

const fmtTags = (tags) =>
  (Array.isArray(tags) ? tags : [])
    .map((t) => `#${String(t || "").replace(/^#/, "").trim()}`)
    .filter((s) => s.length > 1)
    .join(" ");

export function renderTranscriptText(tx) {
  if (!tx || !tx.text) return "";
  return `${String(tx.text).trim()}\n`;
}

export function renderTranscriptJson(tx) {
  return `${JSON.stringify(
    {
      text: String((tx?.text) || ""),
      language: String((tx?.language) || ""),
      model: String((tx?.model) || ""),
      segments: Array.isArray(tx?.segments) ? tx.segments : [],
    },
    null,
    2,
  )}\n`;
}

export function renderDiagnosisMarkdown(post, dx) {
  if (!dx) return "_no diagnosis_\n";
  const lines = [
    `# Outlier diagnosis — @${(post?.author) || "unknown"}`,
    "",
    `- **Hook strength:** ${dx.hookStrength}/10`,
    `- **Visual hook strength:** ${dx.visualHookStrength}/10`,
    `- **Topic novelty:** ${dx.topicNovelty}/10`,
    `- **Emotional driver:** ${dx.emotionalDriver || ""}`,
    `- **Structural pattern:** ${dx.structuralPattern || ""}`,
    "",
    "## Why it overperformed",
    "",
    String(dx.hypothesis || "").trim(),
    "",
    `_model: ${dx.model || "?"}_`,
    "",
  ];
  return lines.join("\n");
}

export function renderPlatformMarkdown(platform, row) {
  if (!row || !row.data) {
    return `_No ${platform} rewrite generated._\n`;
  }
  const d = row.data;
  const lines = [];
  if (platform === "tiktok") {
    lines.push("# TikTok", "", `**Hook:** ${d.hook || ""}`, "", "## Script", "", d.script || "", "", `**CTA:** ${d.cta || ""}`);
    const tags = fmtTags(d.hashtags);
    if (tags) lines.push("", `**Hashtags:** ${tags}`);
  } else if (platform === "yt_shorts") {
    lines.push("# YouTube Shorts", "", `**Hook:** ${d.hook || ""}`, "", "## Script", "", d.script || "", "", "## On-screen text", "");
    for (const t of (Array.isArray(d.onScreenText) ? d.onScreenText : [])) {
      lines.push(`- t=${Number(t.tStart) || 0}s — ${t.text || ""}`);
    }
    lines.push("", `**CTA:** ${d.cta || ""}`);
  } else if (platform === "x") {
    lines.push("# X (Twitter)", "", "## Single", "", `> ${String(d.single || "").replace(/\n/g, "\n> ")}`, "", "## Thread", "");
    (Array.isArray(d.thread) ? d.thread : []).forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  } else if (platform === "linkedin") {
    lines.push("# LinkedIn", "", String(d.post || ""));
    const tags = fmtTags(d.hashtags);
    if (tags) lines.push("", `**Hashtags:** ${tags}`);
  } else {
    lines.push(`# ${platform}`, "", "```json", JSON.stringify(d, null, 2), "```");
  }
  if (Array.isArray(row.warnings) && row.warnings.length) {
    lines.push("", `_warnings: ${row.warnings.map((w) => w.code || w).join(", ")}_`);
  }
  lines.push("");
  return lines.join("\n");
}

export const PLATFORM_FILENAME = {
  tiktok: "tiktok.md",
  yt_shorts: "shorts.md",
  x: "x.md",
  linkedin: "linkedin.md",
};

const fmtNum = (n) => {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
};

export function renderReadme(post, { folder, voice, diagnosis, bundle, transcript, platforms }) {
  const lines = [];
  const score = post && typeof post._score === "number" ? `${post._score.toFixed(2)}×` : "n/a";
  lines.push(`# @${(post?.author) || "unknown"} — ${score}`);
  if (post?.url) lines.push("", `<${post.url}>`);
  lines.push("");
  lines.push("## Stats");
  lines.push("");
  lines.push(`- Score: **${score}** (basis: ${post?._scoreBasis || "n/a"})`);
  lines.push(`- Likes: ${fmtNum(post?.likes)}`);
  lines.push(`- Views: ${fmtNum(post?.views)}`);
  lines.push(`- Comments: ${fmtNum(post?.comments)}`);
  if (post?.createTime) {
    const d = new Date(post.createTime > 1e12 ? post.createTime : post.createTime * 1000);
    lines.push(`- Posted: ${d.toISOString().slice(0, 10)}`);
  }
  lines.push("");
  if (post?.desc) {
    lines.push("## Original caption");
    lines.push("");
    lines.push(`> ${String(post.desc).replace(/\n/g, "\n> ")}`);
    lines.push("");
  }
  lines.push("## Artifacts");
  lines.push("");
  lines.push("- `source.mp4` — original video");
  if (transcript) lines.push("- `transcript.txt` / `transcript.json` — Whisper transcript");
  if (diagnosis) lines.push("- `diagnosis.md` — multimodal Gemma diagnosis");
  for (const p of (platforms || PLATFORMS)) {
    const ok = bundle?.results?.[p];
    const fn = PLATFORM_FILENAME[p] || `${p}.md`;
    lines.push(`- \`${fn}\` — ${p}${ok ? "" : " _(failed)_"}`);
  }
  lines.push("");
  lines.push("## Pipeline");
  lines.push("");
  if (voice?.username) {
    lines.push(`- Voice fingerprint: \`@${voice.username}\` (generated ${voice.generatedAt ? new Date(voice.generatedAt).toISOString().slice(0, 10) : "?"})`);
  } else {
    lines.push(`- Voice fingerprint: _none_ (set "Me" in Settings to repurpose in your own voice)`);
  }
  lines.push(`- Folder: \`${folder}\``);
  lines.push("");
  return lines.join("\n");
}

// -------------------- health gate --------------------

export class PipelineHealthError extends Error {
  constructor(message, parts) {
    super(message);
    this.name = "PipelineHealthError";
    this.parts = parts || {};
  }
}

export async function checkHealth({ health, signal } = {}) {
  if (typeof health !== "function") {
    throw new Error("checkHealth: health() adapter required");
  }
  const r = await health({ signal });
  const ollama = (r?.ollama) || { ok: false };
  const whisper = (r?.whisper) || { ok: false };
  if (!ollama.ok || !whisper.ok) {
    const bad = [];
    if (!ollama.ok) bad.push(`Ollama (${ollama.err || "unreachable"})`);
    if (!whisper.ok) bad.push(`Whisper sidecar (${whisper.err || "unreachable"})`);
    throw new PipelineHealthError(
      `Local AI services not reachable: ${bad.join(", ")}. See README → "Local AI setup".`,
      { ollama, whisper },
    );
  }
  return { ollama, whisper };
}

// -------------------- store sentinel adapter (resume) --------------------

// Default no-op store: every getStep returns null so nothing is skipped.
const NULL_STORE = {
  getStep: async () => null,
  putStep: async () => undefined,
};

const wrapStore = (store) => {
  if (!store || typeof store !== "object") return NULL_STORE;
  return {
    getStep: typeof store.getStep === "function"
      ? (id, step) => Promise.resolve(store.getStep(id, step))
      : NULL_STORE.getStep,
    putStep: typeof store.putStep === "function"
      ? (id, step, payload) => Promise.resolve(store.putStep(id, step, payload))
      : NULL_STORE.putStep,
  };
};

// -------------------- core --------------------

const safeEvent = (onEvent, evt) => {
  if (typeof onEvent !== "function") return;
  try { onEvent(evt); } catch { /* swallow — telemetry must never crash the pipeline */ }
};

// Run one step with sentinel-based resume + abort + progress emission.
// Returns { value, skipped }. Errors propagate up so the caller can decide
// whether the whole post fails or only this step is recorded as failed.
async function runStep({ post, step, fn, store, onEvent, signal }) {
  throwIfAborted(signal);
  const cached = await store.getStep(post.id, step);
  if (cached) {
    safeEvent(onEvent, { type: "step.skip", postId: post.id, step, cached: true });
    return { value: cached, skipped: true };
  }
  safeEvent(onEvent, { type: "step.start", postId: post.id, step });
  const t0 = Date.now();
  let value;
  try {
    value = await fn();
  } catch (e) {
    const err = String((e?.message) || e);
    safeEvent(onEvent, { type: "step.fail", postId: post.id, step, err, durationMs: Date.now() - t0 });
    throw e;
  }
  await store.putStep(post.id, step, { at: Date.now() });
  safeEvent(onEvent, { type: "step.ok", postId: post.id, step, durationMs: Date.now() - t0 });
  return { value, skipped: false };
}

export async function runRepurposePipeline({
  posts = [],
  minScore = 2,
  count = 10,
  platforms = PLATFORMS,
  date = new Date(),
  adapters = {},
  signal = null,
  onEvent = null,
} = {}) {
  const t0 = Date.now();
  const {
    download,
    writeFile,
    transcribe,
    diagnose,
    rewrite,
    health,
    store: rawStore,
    voice = null,
  } = adapters;

  for (const [name, fn] of Object.entries({ download, writeFile, transcribe, diagnose, rewrite })) {
    if (typeof fn !== "function") {
      throw new Error(`runRepurposePipeline: adapters.${name} required`);
    }
  }
  const store = wrapStore(rawStore);
  const targetPlatforms = (Array.isArray(platforms) ? platforms : PLATFORMS)
    .map((p) => String(p || "").toLowerCase().trim())
    .filter((p) => PLATFORMS.includes(p));
  if (!targetPlatforms.length) throw new Error("runRepurposePipeline: at least one platform required");

  // 1) Health gate — fail loud BEFORE downloading anything.
  if (typeof health === "function") {
    safeEvent(onEvent, { type: "health.check" });
    const status = await checkHealth({ health, signal });
    safeEvent(onEvent, { type: "health.ok", ollama: status.ollama, whisper: status.whisper });
  }

  // 2) Pick the top-N outliers.
  const picks = selectCandidates(posts, { minScore, count });
  safeEvent(onEvent, { type: "batch.start", total: picks.length, minScore, count, platforms: targetPlatforms });

  if (!picks.length) {
    safeEvent(onEvent, { type: "batch.empty", minScore });
    return {
      ok: true,
      completed: 0,
      skipped: 0,
      failed: 0,
      items: [],
      durationMs: Date.now() - t0,
      averagePerPostMs: 0,
    };
  }

  const items = [];
  const durations = []; // moving average source
  let completed = 0;
  let failed = 0;
  let skipped = 0;

  // Concurrency = 1. Both Whisper and the multimodal model peg local CPU/GPU.
  for (let idx = 0; idx < picks.length; idx++) {
    if (signal?.aborted) {
      safeEvent(onEvent, { type: "batch.aborted", at: idx, total: picks.length });
      break;
    }
    const post = picks[idx];
    const folder = folderForPost(post, { date });
    const item = {
      post,
      folder,
      steps: { download: null, transcribe: null, diagnose: null, rewrite: null, readme: null },
      errors: {},
      durationMs: 0,
    };
    const tPost = Date.now();
    safeEvent(onEvent, { type: "post.start", index: idx, total: picks.length, postId: post.id, folder });

    try {
      // 2a) Download.
      const dl = await runStep({
        post, step: "download", store, onEvent, signal,
        fn: () => download({ post, folder, filename: `${folder}/source.mp4`, signal }),
      });
      item.steps.download = dl.value || { filename: `${folder}/source.mp4` };
      if (dl.skipped) skipped++;

      // 2b) Transcribe.
      const tx = await runStep({
        post, step: "transcribe", store, onEvent, signal,
        fn: async () => {
          const r = await transcribe({ post, folder, signal });
          await writeFile({ path: `${folder}/transcript.txt`, content: renderTranscriptText(r) });
          await writeFile({ path: `${folder}/transcript.json`, content: renderTranscriptJson(r) });
          return r;
        },
      });
      item.steps.transcribe = tx.value;
      if (tx.skipped) skipped++;

      // Hydrate the post with the transcript so downstream steps see it.
      if (tx.value?.text && !post.transcript) post.transcript = tx.value.text;

      // 2c) Diagnose.
      const dx = await runStep({
        post, step: "diagnose", store, onEvent, signal,
        fn: async () => {
          const d = await diagnose({ post, signal });
          await writeFile({ path: `${folder}/diagnosis.md`, content: renderDiagnosisMarkdown(post, d) });
          return d;
        },
      });
      item.steps.diagnose = dx.value;
      if (dx.skipped) skipped++;

      // 2d) Rewrite per platform — emits per-platform progress for the modal.
      const bundle = await runStep({
        post, step: "rewrite", store, onEvent, signal,
        fn: async () => {
          const b = await rewrite({
            post,
            platforms: targetPlatforms,
            signal,
            onPlatform: (evt) => safeEvent(onEvent, {
              type: "rewrite.platform",
              postId: post.id,
              ...evt,
            }),
          });
          // Write each platform's markdown; missing ones get a stub explaining failure.
          for (const platform of targetPlatforms) {
            const row = b?.results?.[platform];
            const err = b?.errors?.[platform];
            const md = row
              ? renderPlatformMarkdown(platform, row)
              : `# ${platform}\n\n_Generation failed: ${err || "no result"}_\n`;
            await writeFile({ path: `${folder}/${PLATFORM_FILENAME[platform] || `${platform}.md`}`, content: md });
          }
          return b;
        },
      });
      item.steps.rewrite = bundle.value;
      if (bundle.skipped) skipped++;

      // 2e) README — always rewritten last (cheap, ties everything together).
      const rd = await runStep({
        post, step: "readme", store, onEvent, signal,
        fn: async () => {
          const md = renderReadme(post, {
            folder,
            voice,
            diagnosis: item.steps.diagnose,
            bundle: item.steps.rewrite,
            transcript: item.steps.transcribe,
            platforms: targetPlatforms,
          });
          await writeFile({ path: `${folder}/README.md`, content: md });
          return { at: Date.now() };
        },
      });
      item.steps.readme = rd.value;
      if (rd.skipped) skipped++;

      completed++;
      const dur = Date.now() - tPost;
      item.durationMs = dur;
      durations.push(dur);
      safeEvent(onEvent, { type: "post.ok", index: idx, total: picks.length, postId: post.id, durationMs: dur });
    } catch (e) {
      const errMsg = String((e?.message) || e);
      const aborted = (e && e.name === "AbortError") || (signal?.aborted);
      item.errors._fatal = errMsg;
      item.durationMs = Date.now() - tPost;
      if (aborted) {
        safeEvent(onEvent, { type: "post.aborted", index: idx, total: picks.length, postId: post.id });
        items.push(item);
        break;
      }
      failed++;
      safeEvent(onEvent, { type: "post.fail", index: idx, total: picks.length, postId: post.id, err: errMsg });
    }
    items.push(item);
  }

  const averagePerPostMs = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : 0;
  const result = {
    ok: failed === 0 && (signal ? !signal.aborted : true),
    completed,
    skipped,
    failed,
    items,
    durationMs: Date.now() - t0,
    averagePerPostMs,
    aborted: !!(signal?.aborted),
  };
  safeEvent(onEvent, { type: "batch.end", ...result });
  return result;
}
