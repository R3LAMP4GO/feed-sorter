// Classic-script (IIFE) mirror of src/pipeline.js for the content script.
// MV3 content scripts can't import ES modules, so the orchestrator logic is
// duplicated here. Keep this file in lock-step with src/pipeline.js — the
// pure module is the spec (tests live against it); this is the runtime.
//
// Exposes window.__fsPipeline.runRepurposePipeline(...) — same contract.

(function attach(global) {
  if (global.__fsPipeline) return;

  const PLATFORMS = ["tiktok", "yt_shorts", "x", "linkedin"];
  const STEPS = ["download", "transcribe", "diagnose", "rewrite", "readme"];
  const PLATFORM_FILENAME = {
    tiktok: "tiktok.md",
    yt_shorts: "shorts.md",
    x: "x.md",
    linkedin: "linkedin.md",
  };

  const ymd = (d) => {
    d = d || new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  const SAFE_SEG_RE = /[^A-Za-z0-9._-]+/g;
  const sanitizeSeg = (s) =>
    String(s || "").trim().replace(SAFE_SEG_RE, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "x";
  const folderForPost = (post, opts) => {
    opts = opts || {};
    const root = opts.root || "feed-sorter-ig";
    const author = sanitizeSeg(post && post.author || "unknown");
    const sc = sanitizeSeg((post && (post.shortcode || post.id)) || "post");
    return `${root}/repurpose-${ymd(opts.date)}/${author}-${sc}`;
  };
  const selectCandidates = (posts, opts) => {
    opts = opts || {};
    const minScore = Number(opts.minScore || 0);
    const count = Math.max(1, (opts.count | 0) || 10);
    const list = (Array.isArray(posts) ? posts : []).filter(
      (p) => p && p.id && Number(p._score || 0) >= minScore,
    );
    list.sort((a, b) => (Number(b._score) || 0) - (Number(a._score) || 0));
    return list.slice(0, count);
  };

  const fmtTags = (tags) => (Array.isArray(tags) ? tags : [])
    .map((t) => "#" + String(t || "").replace(/^#/, "").trim())
    .filter((s) => s.length > 1).join(" ");

  const renderTranscriptText = (tx) => (!tx || !tx.text) ? "" : (String(tx.text).trim() + "\n");
  const renderTranscriptJson = (tx) => JSON.stringify({
    text: String((tx && tx.text) || ""),
    language: String((tx && tx.language) || ""),
    model: String((tx && tx.model) || ""),
    segments: Array.isArray(tx && tx.segments) ? tx.segments : [],
  }, null, 2) + "\n";

  const renderDiagnosisMarkdown = (post, dx) => {
    if (!dx) return "_no diagnosis_\n";
    return [
      `# Outlier diagnosis — @${(post && post.author) || "unknown"}`, "",
      `- **Hook strength:** ${dx.hookStrength}/10`,
      `- **Visual hook strength:** ${dx.visualHookStrength}/10`,
      `- **Topic novelty:** ${dx.topicNovelty}/10`,
      `- **Emotional driver:** ${dx.emotionalDriver || ""}`,
      `- **Structural pattern:** ${dx.structuralPattern || ""}`, "",
      "## Why it overperformed", "",
      String(dx.hypothesis || "").trim(), "",
      `_model: ${dx.model || "?"}_`, "",
    ].join("\n");
  };

  const renderPlatformMarkdown = (platform, row) => {
    if (!row || !row.data) return `_No ${platform} rewrite generated._\n`;
    const d = row.data;
    const lines = [];
    if (platform === "tiktok") {
      lines.push("# TikTok", "", `**Hook:** ${d.hook || ""}`, "", "## Script", "", d.script || "", "", `**CTA:** ${d.cta || ""}`);
      const t = fmtTags(d.hashtags); if (t) lines.push("", `**Hashtags:** ${t}`);
    } else if (platform === "yt_shorts") {
      lines.push("# YouTube Shorts", "", `**Hook:** ${d.hook || ""}`, "", "## Script", "", d.script || "", "", "## On-screen text", "");
      for (const t of (Array.isArray(d.onScreenText) ? d.onScreenText : [])) {
        lines.push(`- t=${Number(t.tStart) || 0}s — ${t.text || ""}`);
      }
      lines.push("", `**CTA:** ${d.cta || ""}`);
    } else if (platform === "x") {
      lines.push("# X (Twitter)", "", "## Single", "", "> " + String(d.single || "").replace(/\n/g, "\n> "), "", "## Thread", "");
      (Array.isArray(d.thread) ? d.thread : []).forEach((t, i) => lines.push(`${i + 1}. ${t}`));
    } else if (platform === "linkedin") {
      lines.push("# LinkedIn", "", String(d.post || ""));
      const t = fmtTags(d.hashtags); if (t) lines.push("", `**Hashtags:** ${t}`);
    } else {
      lines.push(`# ${platform}`, "", "```json", JSON.stringify(d, null, 2), "```");
    }
    if (Array.isArray(row.warnings) && row.warnings.length) {
      lines.push("", `_warnings: ${row.warnings.map((w) => w.code || w).join(", ")}_`);
    }
    lines.push("");
    return lines.join("\n");
  };

  const fmtNum = (n) => {
    const v = Number(n) || 0;
    if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
    if (v >= 1_000) return (v / 1_000).toFixed(1) + "K";
    return String(v);
  };
  const renderReadme = (post, opts) => {
    opts = opts || {};
    const lines = [];
    const score = post && typeof post._score === "number" ? `${post._score.toFixed(2)}×` : "n/a";
    lines.push(`# @${(post && post.author) || "unknown"} — ${score}`);
    if (post && post.url) lines.push("", `<${post.url}>`);
    lines.push("", "## Stats", "");
    lines.push(`- Score: **${score}** (basis: ${post && post._scoreBasis || "n/a"})`);
    lines.push(`- Likes: ${fmtNum(post && post.likes)}`);
    lines.push(`- Views: ${fmtNum(post && post.views)}`);
    lines.push(`- Comments: ${fmtNum(post && post.comments)}`);
    if (post && post.createTime) {
      const d = new Date(post.createTime > 1e12 ? post.createTime : post.createTime * 1000);
      lines.push(`- Posted: ${d.toISOString().slice(0, 10)}`);
    }
    lines.push("");
    if (post && post.desc) {
      lines.push("## Original caption", "", "> " + String(post.desc).replace(/\n/g, "\n> "), "");
    }
    lines.push("## Artifacts", "");
    lines.push("- `source.mp4` — original video");
    if (opts.transcript) lines.push("- `transcript.txt` / `transcript.json` — Whisper transcript");
    if (opts.diagnosis) lines.push("- `diagnosis.md` — multimodal Gemma diagnosis");
    for (const p of (opts.platforms || PLATFORMS)) {
      const ok = opts.bundle && opts.bundle.results && opts.bundle.results[p];
      const fn = PLATFORM_FILENAME[p] || `${p}.md`;
      lines.push(`- \`${fn}\` — ${p}${ok ? "" : " _(failed)_"}`);
    }
    lines.push("", "## Pipeline", "");
    if (opts.voice && opts.voice.username) {
      lines.push(`- Voice fingerprint: \`@${opts.voice.username}\` (generated ${opts.voice.generatedAt ? new Date(opts.voice.generatedAt).toISOString().slice(0, 10) : "?"})`);
    } else {
      lines.push(`- Voice fingerprint: _none_ (set "Me" in Settings to repurpose in your own voice)`);
    }
    lines.push(`- Folder: \`${opts.folder}\``, "");
    return lines.join("\n");
  };

  function PipelineHealthError(message, parts) {
    const e = new Error(message);
    e.name = "PipelineHealthError";
    e.parts = parts || {};
    return e;
  }

  const throwIfAborted = (signal) => {
    if (signal && signal.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
  };

  const NULL_STORE = { getStep: () => Promise.resolve(null), putStep: () => Promise.resolve() };
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

  const safeEvent = (onEvent, evt) => {
    if (typeof onEvent !== "function") return;
    try { onEvent(evt); } catch { /* swallow */ }
  };

  async function checkHealth(opts) {
    const health = opts && opts.health;
    if (typeof health !== "function") throw new Error("checkHealth: health() adapter required");
    const r = await health({ signal: opts.signal || null });
    const ollama = (r && r.ollama) || { ok: false };
    const whisper = (r && r.whisper) || { ok: false };
    if (!ollama.ok || !whisper.ok) {
      const bad = [];
      if (!ollama.ok) bad.push(`Ollama (${ollama.err || "unreachable"})`);
      if (!whisper.ok) bad.push(`Whisper sidecar (${whisper.err || "unreachable"})`);
      throw PipelineHealthError(
        `Local AI services not reachable: ${bad.join(", ")}. See README → "Local AI setup".`,
        { ollama, whisper },
      );
    }
    return { ollama, whisper };
  }

  async function runStep(ctx) {
    const { post, step, fn, store, onEvent, signal } = ctx;
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
      const err = String((e && e.message) || e);
      safeEvent(onEvent, { type: "step.fail", postId: post.id, step, err, durationMs: Date.now() - t0 });
      throw e;
    }
    await store.putStep(post.id, step, { at: Date.now() });
    safeEvent(onEvent, { type: "step.ok", postId: post.id, step, durationMs: Date.now() - t0 });
    return { value, skipped: false };
  }

  async function runRepurposePipeline(opts) {
    opts = opts || {};
    const t0 = Date.now();
    const adapters = opts.adapters || {};
    const { download, writeFile, transcribe, diagnose, rewrite, health, voice } = adapters;
    const required = { download, writeFile, transcribe, diagnose, rewrite };
    for (const k of Object.keys(required)) {
      if (typeof required[k] !== "function") throw new Error(`runRepurposePipeline: adapters.${k} required`);
    }
    const store = wrapStore(adapters.store);
    const targetPlatforms = (Array.isArray(opts.platforms) ? opts.platforms : PLATFORMS)
      .map((p) => String(p || "").toLowerCase().trim())
      .filter((p) => PLATFORMS.indexOf(p) >= 0);
    if (!targetPlatforms.length) throw new Error("runRepurposePipeline: at least one platform required");

    const signal = opts.signal || null;
    const onEvent = opts.onEvent || null;
    const date = opts.date || new Date();

    if (typeof health === "function") {
      safeEvent(onEvent, { type: "health.check" });
      const status = await checkHealth({ health, signal });
      safeEvent(onEvent, { type: "health.ok", ollama: status.ollama, whisper: status.whisper });
    }

    const picks = selectCandidates(opts.posts || [], { minScore: opts.minScore || 2, count: opts.count || 10 });
    safeEvent(onEvent, {
      type: "batch.start",
      total: picks.length,
      minScore: opts.minScore || 2,
      count: opts.count || 10,
      platforms: targetPlatforms,
    });
    if (!picks.length) {
      safeEvent(onEvent, { type: "batch.empty", minScore: opts.minScore || 2 });
      return { ok: true, completed: 0, skipped: 0, failed: 0, items: [], durationMs: Date.now() - t0, averagePerPostMs: 0, aborted: false };
    }

    const items = [];
    const durations = [];
    let completed = 0, failed = 0, skipped = 0;

    for (let idx = 0; idx < picks.length; idx++) {
      if (signal && signal.aborted) {
        safeEvent(onEvent, { type: "batch.aborted", at: idx, total: picks.length });
        break;
      }
      const post = picks[idx];
      const folder = folderForPost(post, { date });
      const item = {
        post, folder,
        steps: { download: null, transcribe: null, diagnose: null, rewrite: null, readme: null },
        errors: {}, durationMs: 0,
      };
      const tPost = Date.now();
      safeEvent(onEvent, { type: "post.start", index: idx, total: picks.length, postId: post.id, folder });

      try {
        const dl = await runStep({
          post, step: "download", store, onEvent, signal,
          fn: () => download({ post, folder, filename: `${folder}/source.mp4`, signal }),
        });
        item.steps.download = dl.value || { filename: `${folder}/source.mp4` };
        if (dl.skipped) skipped++;

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
        if (tx.value && tx.value.text && !post.transcript) post.transcript = tx.value.text;

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

        const bundle = await runStep({
          post, step: "rewrite", store, onEvent, signal,
          fn: async () => {
            const b = await rewrite({
              post,
              platforms: targetPlatforms,
              signal,
              onPlatform: (evt) => safeEvent(onEvent, { type: "rewrite.platform", postId: post.id, ...evt }),
            });
            for (const platform of targetPlatforms) {
              const row = b && b.results && b.results[platform];
              const err = b && b.errors && b.errors[platform];
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

        const rd = await runStep({
          post, step: "readme", store, onEvent, signal,
          fn: async () => {
            const md = renderReadme(post, {
              folder, voice,
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
        const errMsg = String((e && e.message) || e);
        const aborted = (e && e.name === "AbortError") || (signal && signal.aborted);
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
      completed, skipped, failed, items,
      durationMs: Date.now() - t0,
      averagePerPostMs,
      aborted: !!(signal && signal.aborted),
    };
    safeEvent(onEvent, Object.assign({ type: "batch.end" }, result));
    return result;
  }

  global.__fsPipeline = {
    PLATFORMS,
    STEPS,
    PLATFORM_FILENAME,
    folderForPost,
    sanitizeSeg,
    ymd,
    selectCandidates,
    runRepurposePipeline,
    checkHealth,
    renderReadme,
    renderDiagnosisMarkdown,
    renderPlatformMarkdown,
    renderTranscriptText,
    renderTranscriptJson,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
