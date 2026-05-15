// Classic-script (IIFE) mirror of src/analysis/niche-cluster-posts.js for
// the content script. MV3 content scripts can't import ES modules, so the
// pure-module logic is duplicated here. Keep this in lock-step with
// src/analysis/niche-cluster-posts.js — the pure module is the spec
// (tests live against it); this is the runtime.
//
// Exposes window.__fsNicheCluster = { clusterPostsByNiche, labelClusters }.

(function attach(global) {
  if (global.__fsNicheCluster) return;

  const HASHTAG_RE = /#([\w_]+)/g;

  const wordCount = (s) => {
    const t = String(s || "").trim();
    if (!t) return 0;
    return t.split(/\s+/).filter(Boolean).length;
  };
  const captionOf = (post) => String((post && (post.caption ?? post.desc)) || "");
  const transcriptOf = (post) => {
    if (!post) return "";
    if (typeof post.transcript === "string" && post.transcript) return post.transcript;
    const segs = Array.isArray(post.transcriptSegments) ? post.transcriptSegments : null;
    if (segs && segs.length) return segs.map((s) => String((s && s.text) || "")).join(" ");
    return "";
  };
  const hashtagsOf = (post) => {
    if (!post) return [];
    if (Array.isArray(post.hashtags)) return post.hashtags.map((t) => String(t).replace(/^#/, "")).filter(Boolean);
    const out = [];
    const s = captionOf(post);
    HASHTAG_RE.lastIndex = 0;
    let m;
    while ((m = HASHTAG_RE.exec(s))) out.push(m[1]);
    return out;
  };

  const l2norm = (v) => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; return Math.sqrt(s) || 1; };
  const normalize = (v) => {
    const n = l2norm(v);
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
    return out;
  };
  const cosineSim = (a, b) => {
    let s = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
  };
  const meanVec = (vecs) => {
    if (!vecs.length) return null;
    const dim = vecs[0].length;
    const out = new Float32Array(dim);
    for (const v of vecs) for (let i = 0; i < dim; i++) out[i] += v[i];
    for (let i = 0; i < dim; i++) out[i] /= vecs.length;
    return normalize(out);
  };

  const agglomerative = (vectors, distanceThreshold) => {
    const n = vectors.length;
    if (!n) return [];
    if (n === 1) return [[0]];
    let dist = Array.from({ length: n }, () => new Float64Array(n));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const d = 1 - cosineSim(vectors[i], vectors[j]);
      dist[i][j] = d; dist[j][i] = d;
    }
    const clusters = vectors.map((_, i) => [i]);
    const sizes = new Array(n).fill(1);
    while (clusters.length > 1) {
      let bestD = Infinity, bi = -1, bj = -1;
      for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
        const d = dist[i][j];
        if (d < bestD) { bestD = d; bi = i; bj = j; }
      }
      if (bestD > distanceThreshold) break;
      const sa = sizes[bi], sb = sizes[bj], sab = sa + sb;
      const newRow = new Float64Array(clusters.length);
      for (let k = 0; k < clusters.length; k++) {
        if (k === bi || k === bj) continue;
        newRow[k] = (sa * dist[bi][k] + sb * dist[bj][k]) / sab;
      }
      for (let k = 0; k < clusters.length; k++) { dist[bi][k] = newRow[k]; dist[k][bi] = newRow[k]; }
      dist[bi][bi] = 0;
      clusters[bi] = clusters[bi].concat(clusters[bj]);
      sizes[bi] = sab;
      clusters.splice(bj, 1);
      sizes.splice(bj, 1);
      dist = dist.filter((_, idx) => idx !== bj).map((row) => {
        const r = new Float64Array(row.length - 1);
        let w = 0;
        for (let k = 0; k < row.length; k++) { if (k === bj) continue; r[w++] = row[k]; }
        return r;
      });
    }
    return clusters;
  };

  const majorityNiche = (labels) => {
    const counts = new Map();
    for (const l of labels) { if (!l) continue; counts.set(l, (counts.get(l) || 0) + 1); }
    let best = null, bestN = 0;
    for (const [l, n] of counts) if (n > bestN) { best = l; bestN = n; }
    return best;
  };

  async function clusterPostsByNiche(posts, opts = {}) {
    if (!Array.isArray(posts)) throw new Error("clusterPostsByNiche: posts[] required");
    const embedFn = opts.embedFn;
    if (typeof embedFn !== "function") throw new Error("clusterPostsByNiche: opts.embedFn function required");
    const getAuthorPosts = typeof opts.getAuthorPosts === "function" ? opts.getAuthorPosts : null;
    const signal = opts.signal || null;
    const distanceThreshold = Number.isFinite(opts.distanceThreshold) ? opts.distanceThreshold : 0.4;
    const minWordsForText = Number.isFinite(opts.minWordsForText) ? opts.minWordsForText : 8;
    const minHashtags = Number.isFinite(opts.minHashtags) ? opts.minHashtags : 2;
    const minLabeledPosts = Number.isFinite(opts.minLabeledPosts) ? opts.minLabeledPosts : 3;
    const throwIfAborted = () => { if (signal && signal.aborted) throw new Error("clusterPostsByNiche: aborted"); };

    const eligible = [], inherited = [], deferred = [];
    for (const post of posts) {
      if (!post || !post.id) continue;
      const id = post.id;
      const caption = captionOf(post);
      const transcript = transcriptOf(post);
      const textWords = wordCount(caption) + wordCount(transcript);
      if (textWords >= minWordsForText) {
        const text = transcript ? `${caption} ${transcript}`.trim() : caption.trim();
        eligible.push({ id, basis: "text", text });
        continue;
      }
      const tags = hashtagsOf(post);
      if (tags.length >= minHashtags) {
        eligible.push({ id, basis: "tags", text: tags.map((t) => `#${t}`).join(" ") });
        continue;
      }
      if (getAuthorPosts && post.author) {
        throwIfAborted();
        const others = (await getAuthorPosts(post.author)) || [];
        const labels = [];
        for (const o of others) {
          if (!o || o.id === id) continue;
          const niche = o.niche || (o.ai && o.ai.niche) || null;
          if (niche) labels.push(niche);
        }
        if (labels.length >= minLabeledPosts) {
          const niche = majorityNiche(labels);
          if (niche) { inherited.push({ id, niche, basis: "author" }); continue; }
        }
      }
      deferred.push(id);
    }

    let clusters = [];
    if (eligible.length) {
      throwIfAborted();
      const raw = await embedFn(eligible.map((e) => e.text));
      if (!Array.isArray(raw) || raw.length !== eligible.length) {
        throw new Error("clusterPostsByNiche: embedFn returned wrong shape");
      }
      const vectors = raw.map((v) => normalize(v instanceof Float32Array ? v : new Float32Array(v)));
      const groups = agglomerative(vectors, distanceThreshold);
      clusters = groups.map((idxs, ci) => {
        const memberVecs = idxs.map((i) => vectors[i]);
        const centroid = meanVec(memberVecs);
        let bestSim = -Infinity, bestIdx = idxs[0];
        for (const i of idxs) {
          const s = cosineSim(vectors[i], centroid);
          if (s > bestSim) { bestSim = s; bestIdx = i; }
        }
        const basisCounts = new Map();
        for (const i of idxs) { const b = eligible[i].basis; basisCounts.set(b, (basisCounts.get(b) || 0) + 1); }
        let basis = "text", bestN = -1;
        for (const [b, n] of basisCounts) if (n > bestN) { basis = b; bestN = n; }
        return {
          id: ci,
          memberIds: idxs.map((i) => eligible[i].id),
          representativeId: eligible[bestIdx].id,
          basis,
          vectors: memberVecs,
        };
      });
    }
    return { clusters, inherited, deferred };
  }

  // ---------- labelClusters ----------
  const fnv1a = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  const nearestKToCentroid = (cluster, k) => {
    const ids = Array.isArray(cluster.memberIds) ? cluster.memberIds : [];
    const vecs = Array.isArray(cluster.vectors) ? cluster.vectors : [];
    if (!ids.length) return [];
    if (!vecs.length || vecs.length !== ids.length) return ids.slice(0, k);
    const centroid = meanVec(vecs);
    if (!centroid) return ids.slice(0, k);
    const scored = ids.map((id, i) => ({ id, sim: cosineSim(vecs[i], centroid) }));
    scored.sort((a, b) => b.sim - a.sim);
    return scored.slice(0, k).map((s) => s.id);
  };
  const cacheKeyForExemplars = (exemplarIds) => `niche-label::${fnv1a([...exemplarIds].map(String).sort().join("|"))}`;
  const MAX_CAPTION_CHARS = 400;
  const snipCaption = (s) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length > MAX_CAPTION_CHARS ? t.slice(0, MAX_CAPTION_CHARS) + "…" : t;
  };
  const buildLabelPrompt = (captions) =>
    "Given these 3 captions from posts that cluster together, label this group with a short niche name (1-3 words). Output ONLY the label.\n\n" +
    captions.map((c, i) => `${i + 1}. ${snipCaption(c) || "(no caption)"}`).join("\n");
  const extractLabel = (resp) => {
    let raw = "";
    if (typeof resp === "string") raw = resp;
    else if (resp && typeof resp === "object") raw = String(resp.text ?? resp.label ?? resp.content ?? "");
    raw = raw.trim().replace(/^["'`\s]+|["'`\s]+$/g, "");
    raw = raw.replace(/^\d+[.)]\s*/, "");
    raw = raw.split(/\r?\n/)[0].trim();
    if (raw.length > 50) raw = raw.slice(0, 50).trim();
    return raw;
  };

  async function labelClusters(clusters, opts = {}) {
    if (!Array.isArray(clusters)) throw new Error("labelClusters: clusters[] required");
    const chat = opts.chat;
    if (typeof chat !== "function") throw new Error("labelClusters: opts.chat function required");
    const getPost = opts.getPost;
    if (typeof getPost !== "function") throw new Error("labelClusters: opts.getPost function required");
    const signal = opts.signal || null;
    const cache = (opts.cache && typeof opts.cache.get === "function" && typeof opts.cache.set === "function")
      ? opts.cache
      : { get: async () => null, set: async () => {} };
    const setPostNiche = typeof opts.setPostNiche === "function" ? opts.setPostNiche : null;
    const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
    const now = typeof opts.now === "function" ? opts.now : () => Date.now();
    const throwIfAborted = () => { if (signal && signal.aborted) throw new Error("labelClusters: aborted"); };

    const out = [];
    let i = 0;
    const total = clusters.length;
    for (const cluster of clusters) {
      i += 1;
      if (!cluster || !Array.isArray(cluster.memberIds) || !cluster.memberIds.length) {
        out.push(cluster);
        if (onProgress) try { onProgress({ done: i, total, skipped: true }); } catch {}
        continue;
      }
      throwIfAborted();
      const exemplarIds = nearestKToCentroid(cluster, 3);
      if (!exemplarIds.length) { out.push(cluster); continue; }
      const cacheKey = cacheKeyForExemplars(exemplarIds);
      let label = null, fromCache = false;
      try {
        const cached = await cache.get(cacheKey);
        if (cached && typeof cached === "string" && cached.trim()) { label = cached.trim(); fromCache = true; }
        else if (cached && typeof cached === "object" && typeof cached.label === "string" && cached.label.trim()) {
          label = cached.label.trim(); fromCache = true;
        }
      } catch {}
      if (!label) {
        const captions = [];
        for (const id of exemplarIds) {
          const post = await getPost(id);
          captions.push(captionOf(post));
        }
        const prompt = buildLabelPrompt(captions);
        const representativeId = cluster.representativeId || exemplarIds[0];
        throwIfAborted();
        const resp = await chat({
          messages: [{ role: "user", content: prompt }],
          kind: "niche-label",
          postId: representativeId,
          schema: { type: "string", maxLength: 50 },
        });
        label = extractLabel(resp);
        if (label) { try { await cache.set(cacheKey, label); } catch {} }
      }
      const labeled = { ...cluster, label: label || null, labeledAt: now(), fromCache };
      out.push(labeled);
      if (label && setPostNiche) {
        for (const id of cluster.memberIds) {
          try { await setPostNiche(id, label, cluster.basis || "text"); } catch {}
        }
      }
      if (onProgress) try { onProgress({ done: i, total, label, fromCache }); } catch {}
    }
    return out;
  }

  global.__fsNicheCluster = { clusterPostsByNiche, labelClusters };
})(typeof window !== "undefined" ? window : globalThis);
