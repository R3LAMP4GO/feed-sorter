// Niche auto-clustering helpers — embedding I/O, agglomerative clustering on
// cosine similarity, and tf-idf cluster labeling. Intentionally framework-free
// so the same module is loadable from background.js (importScripts) and the
// content-script via `<script>` tag (re-exports onto globalThis.__fsCluster).
//
// Algorithm summary:
//   1. Per creator: average MiniLM embeddings of top-N outlier captions+hooks
//      → unit-normalized "creator vector".
//   2. Agglomerative clustering with cosine-distance threshold (1 - 0.65 = 0.35).
//      Single-linkage merge: O(n^3) on distance matrix; n ~ tracked creators
//      (≤ a few hundred), well within budget.
//   3. Per cluster: tf-idf over member captions (treating each *cluster* as a
//      document); pick top-K terms as the niche label.

(function (root) {
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);

  // Float32Array <-> base64 (JSON-safe for IDB; smaller than number[] JSON).
  const f32ToB64 = (vec) => {
    const f32 = vec instanceof Float32Array ? vec : new Float32Array(vec);
    const u8 = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
    let bin = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  };
  const b64ToF32 = (s) => {
    if (!s || typeof s !== "string") return null;
    const bin = atob(s);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
  };

  const l2norm = (v) => {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * v[i];
    return Math.sqrt(s) || 1;
  };
  const normalize = (v) => {
    const n = l2norm(v);
    const out = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
    return out;
  };

  const meanVec = (vecs) => {
    if (!vecs.length) return null;
    const dim = vecs[0].length;
    const out = new Float32Array(dim);
    for (const v of vecs) {
      for (let i = 0; i < dim; i++) out[i] += v[i];
    }
    for (let i = 0; i < dim; i++) out[i] /= vecs.length;
    return normalize(out);
  };

  const cosine = (a, b) => {
    let s = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s; // assumes inputs already unit-normalized
  };

  // Outlier score: likes / authorMedianLikes, fallback to raw likes.
  const topOutlierPosts = (posts, n) => {
    const byA = new Map();
    for (const p of posts) {
      if (!p?.author) continue;
      if (!byA.has(p.author)) byA.set(p.author, []);
      byA.get(p.author).push(Number(p.likes || 0));
    }
    const med = new Map();
    for (const [k, vs] of byA) {
      const s = [...vs].sort((a, b) => a - b);
      const m = Math.floor(s.length / 2);
      med.set(k, s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
    }
    const scored = posts
      .filter((p) => p && (p.desc || "").trim().length > 0)
      .map((p) => {
        const base = med.get(p.author) || 0;
        const score = base > 0 ? (Number(p.likes || 0) / base) : Number(p.likes || 0);
        return { p, score };
      })
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, n).map((x) => x.p);
  };

  // First line of caption (the "hook"); strips emoji-heavy noise.
  const extractHook = (desc) =>
    String(desc || "").split("\n")[0].slice(0, 200).trim();

  const captionPlusHook = (post) => {
    const desc = String(post?.desc || "").trim();
    if (!desc) return "";
    const hook = extractHook(desc);
    // Repeat hook so it gets weighted ~2x in the embedding.
    return `${hook}\n${desc}`;
  };

  // ---------- agglomerative clustering ----------
  // Single-linkage on cosine distance. Returns Array<Array<number>> of indices.
  const cluster = (vectors, simThreshold = 0.65) => {
    const n = vectors.length;
    if (!n) return [];
    if (n === 1) return [[0]];
    const distThresh = 1 - simThreshold;
    // Each item starts as its own cluster.
    const clusters = vectors.map((_, i) => [i]);
    // Pre-compute similarity matrix.
    const sim = Array.from({ length: n }, () => new Float32Array(n));
    for (let i = 0; i < n; i++) {
      sim[i][i] = 1;
      for (let j = i + 1; j < n; j++) {
        const s = cosine(vectors[i], vectors[j]);
        sim[i][j] = s;
        sim[j][i] = s;
      }
    }
    // Cluster-pair similarity = max member-pair similarity (single-linkage).
    const pairSim = (a, b) => {
      let best = -Infinity;
      for (const i of a) for (const j of b) if (sim[i][j] > best) best = sim[i][j];
      return best;
    };
    while (clusters.length > 1) {
      let bestSim = -Infinity, bi = -1, bj = -1;
      for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
          const s = pairSim(clusters[i], clusters[j]);
          if (s > bestSim) { bestSim = s; bi = i; bj = j; }
        }
      }
      if (bestSim < 1 - distThresh) break;
      const merged = clusters[bi].concat(clusters[bj]);
      clusters.splice(bj, 1);
      clusters.splice(bi, 1);
      clusters.push(merged);
    }
    return clusters;
  };

  // ---------- tf-idf labeling ----------
  // Stopwords trimmed to short list — plenty for IG-caption noise reduction.
  const STOP = new Set((
    "the a an and or but if to of in on for at by from with as is are was were be been being have has had do does did will would can could should may might just so this that these those i you he she it we they me him her us them my your his their our its mine yours theirs not no nor too very than then there here when where why how what which who whom about into through during before after above below up down out off over under again further once also like get got go going gonna come came back way thing things make made one two three about really only still even ever new way day days time times today now today new like im just dont cant didnt wont gotta let lets thats theyre youre were ive were us all any each every some most more less few many much because while since though although however whether what's it's that's etc"
  ).split(/\s+/));

  const TOKEN_RE = /[a-z0-9]{3,20}/g;

  const tokenize = (text) => {
    const t = String(text || "").toLowerCase();
    const out = [];
    let m;
    while ((m = TOKEN_RE.exec(t))) {
      const tok = m[0];
      if (STOP.has(tok)) continue;
      if (/^\d+$/.test(tok)) continue;
      out.push(tok);
    }
    return out;
  };

  const labelClusters = (clusterCaptions, topK = 3) => {
    const docs = clusterCaptions.map((cap) => tokenize(cap.join(" ")));
    const N = docs.length;
    const df = new Map();
    for (const doc of docs) {
      const seen = new Set(doc);
      for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    }
    const labels = [];
    for (const doc of docs) {
      const tf = new Map();
      for (const t of doc) tf.set(t, (tf.get(t) || 0) + 1);
      const total = doc.length || 1;
      const scored = [];
      for (const [t, c] of tf) {
        const idf = Math.log((1 + N) / (1 + (df.get(t) || 0))) + 1;
        scored.push([t, (c / total) * idf]);
      }
      scored.sort((a, b) => b[1] - a[1]);
      const top = scored.slice(0, topK).map((x) => x[0]);
      labels.push(top.length ? top.join(" / ") : "misc");
    }
    return labels;
  };

  // ---------- end-to-end ----------
  // Inputs: creators[], postsByAuthor: Map<usernameLower, post[]>,
  //         embedFn(texts) → vectors[].
  // Returns: { creators: [{username, embedding(b64), niche, members}], clusters: [{ label, members }] }
  const buildCreatorVectors = async (creators, postsByAuthor, embedFn, topN = 20) => {
    const inputs = []; // { username, texts:[] }
    for (const c of creators) {
      const u = String(c.username || "").toLowerCase();
      const posts = postsByAuthor.get(u) || [];
      const top = topOutlierPosts(posts, topN);
      const texts = top.map(captionPlusHook).filter(Boolean);
      inputs.push({ username: u, texts });
    }
    // Flatten for batched embedding, then group back.
    const flat = [];
    const offsets = [];
    for (const inp of inputs) {
      offsets.push(flat.length);
      for (const t of inp.texts) flat.push(t);
    }
    let vectors = [];
    if (flat.length) vectors = await embedFn(flat);
    const out = [];
    for (let i = 0; i < inputs.length; i++) {
      const start = offsets[i];
      const end = (i + 1 < inputs.length ? offsets[i + 1] : flat.length);
      const vecs = vectors.slice(start, end).map((v) => normalize(new Float32Array(v)));
      const mean = vecs.length ? meanVec(vecs) : null;
      out.push({ username: inputs[i].username, vector: mean, captions: inputs[i].texts });
    }
    return out;
  };

  const clusterCreators = (creatorVectors, simThreshold = 0.65) => {
    // Filter out creators with no embedding (no captions).
    const usable = creatorVectors.filter((c) => c.vector);
    const skipped = creatorVectors.filter((c) => !c.vector);
    const groups = cluster(usable.map((c) => c.vector), simThreshold);
    const clusterCaptions = groups.map((g) => g.flatMap((idx) => usable[idx].captions));
    const labels = labelClusters(clusterCaptions);
    const out = [];
    groups.forEach((g, ci) => {
      out.push({
        label: labels[ci],
        members: g.map((idx) => usable[idx].username),
      });
    });
    if (skipped.length) {
      out.push({ label: "unlabeled", members: skipped.map((c) => c.username) });
    }
    return out;
  };

  const api = {
    f32ToB64, b64ToF32, normalize, meanVec, cosine,
    topOutlierPosts, captionPlusHook, extractHook,
    cluster, labelClusters, tokenize,
    buildCreatorVectors, clusterCreators,
  };

  // Dual export: globalThis (for content-script + service-worker importScripts)
  // and ESM (for unit tests via vitest).
  root.__fsCluster = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : this);
