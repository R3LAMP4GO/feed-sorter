#!/usr/bin/env node
// Offline niche clustering against an exported library.
//
// The production clustering pipeline (background.js → clusterNiches) uses a
// MiniLM model running in a Chrome offscreen document. We can't invoke that
// from a Node shell, so this script reuses the same `cluster.js` algorithms
// (buildCreatorVectors / clusterCreators / labelClusters — all pure) but
// swaps in a hashing-TF-IDF embedFn instead of MiniLM.
//
// Quality vs. production:
//   - TF-IDF clusters on shared vocabulary. Very different creators with
//     overlapping vocabulary may collide; semantically similar creators with
//     different word choices may split.
//   - MiniLM produces better semantic clusters but the broad strokes (which
//     creators belong to which topical niche) match TF-IDF in practice.
// Treat this as a preview of what the production run will reveal.
//
// Usage: node scripts/cluster-niches.mjs <library-export.json> [--sim 0.55] [--min-creators 3]

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
// cluster.js's IIFE wraps `(function(root){...})(typeof self !== "undefined" ? self : this)`.
// The repo's package.json sets "type": "module", so the file is loaded as ESM
// regardless of how we import it — module.exports never resolves. Instead we
// shim a `self` first, then dynamic-import the file for its side effect, and
// pull the API off globalThis.__fsCluster.
if (typeof globalThis.self === "undefined") globalThis.self = globalThis;
await import("../src/lib/cluster.js");
const Cluster = globalThis.__fsCluster;
if (!Cluster) {
  console.error("failed to load src/lib/cluster.js — globalThis.__fsCluster missing");
  process.exit(1);
}

// ---------- argv ----------
const argv = process.argv.slice(2);
if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
  console.log("Usage: node scripts/cluster-niches.mjs <library-export.json> [--sim 0.55] [--min-creators 3]");
  process.exit(argv.length ? 0 : 1);
}
const file = resolve(process.cwd(), argv[0]);
let simThreshold = 0.55;
let minCreators = 3;
let minPostsPerCreator = 1;
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--sim") simThreshold = Number(argv[++i]);
  else if (a === "--min-creators") minCreators = Number(argv[++i]);
  else if (a === "--min-posts") minPostsPerCreator = Number(argv[++i]);
}
if (!existsSync(file)) {
  console.error(`File not found: ${file}`);
  process.exit(2);
}

const raw = JSON.parse(readFileSync(file, "utf8"));
const posts = Array.isArray(raw) ? raw : (raw && raw.posts) || [];
if (!posts.length) {
  console.error("No posts found in input.");
  process.exit(3);
}

// ---------- group by author ----------
const byAuthor = new Map();
for (const p of posts) {
  const a = String((p && p.author) || "").toLowerCase();
  if (!a) continue;
  if (!byAuthor.has(a)) byAuthor.set(a, []);
  byAuthor.get(a).push(p);
}

// Filter out creators with too little volume — they generate noisy singleton
// clusters because TF-IDF on one short caption is meaningless. The production
// pipeline implicitly suffers from the same issue but masks it via MiniLM
// embeddings (which find semantic similarity across thin contexts).
const allCreators = [...byAuthor.keys()];
const eligible = allCreators.filter((u) => (byAuthor.get(u) || []).length >= minPostsPerCreator);
const creators = eligible.map((u) => ({ username: u }));
const dropped = allCreators.length - eligible.length;

console.log(`\ncluster-niches  •  ${file}`);
console.log(`creators: ${creators.length}/${allCreators.length}  •  posts: ${posts.length}  •  sim: ${simThreshold}  •  min-posts/creator: ${minPostsPerCreator}`);
if (dropped > 0) console.log(`(dropped ${dropped} creators with < ${minPostsPerCreator} posts — too thin for TF-IDF)`);
console.log();

// ---------- hashing TF-IDF embedFn ----------
//
// For each text, build a 512-dim vector by:
//   - tokenize via cluster.tokenize (already strips stopwords + #/@ noise)
//   - hash each token to a bucket index in [0, DIM)
//   - accumulate term frequencies
//   - apply IDF after the global vocabulary is known
//
// Cosine similarity on these vectors is a serviceable proxy for semantic
// similarity when documents are short captions.
const DIM = 512;
function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// First pass: compute document frequency over the full corpus of texts that
// will be embedded (so IDF is global).
const allTextsForIDF = [];
for (const c of creators) {
  const top = Cluster.topOutlierPosts(byAuthor.get(c.username) || [], 20);
  for (const p of top) {
    const t = Cluster.captionPlusHook(p);
    if (t) allTextsForIDF.push(t);
  }
}
const docFreq = new Array(DIM).fill(0);
for (const t of allTextsForIDF) {
  const seen = new Set();
  for (const tok of Cluster.tokenize(t)) seen.add(hash32(tok) % DIM);
  for (const idx of seen) docFreq[idx]++;
}
const N = Math.max(1, allTextsForIDF.length);
const idf = docFreq.map((df) => Math.log((1 + N) / (1 + df)) + 1);

const embedFn = async (texts) => {
  const vecs = [];
  for (const t of texts) {
    const v = new Float32Array(DIM);
    const toks = Cluster.tokenize(t);
    for (const tok of toks) {
      const idx = hash32(tok) % DIM;
      v[idx] += 1;
    }
    if (toks.length > 0) {
      const inv = 1 / toks.length;
      for (let i = 0; i < DIM; i++) v[i] = v[i] * inv * idf[i];
    }
    vecs.push(Cluster.normalize(v));
  }
  return vecs;
};

// ---------- run ----------
const t0 = Date.now();
const creatorVecs = await Cluster.buildCreatorVectors(creators, byAuthor, embedFn, 20);
const groups = Cluster.clusterCreators(creatorVecs, simThreshold);
const ms = Date.now() - t0;

// ---------- print ----------
const sized = groups
  .map((g) => ({ ...g, size: g.members.length }))
  .sort((a, b) => b.size - a.size);

console.log(`clustered in ${ms}ms\n`);

let shown = 0;
for (const g of sized) {
  if (g.size < minCreators) continue;
  shown++;
  console.log(`─── ${g.label}  (${g.size} creators)`);
  // Top 8 creators by post count within this cluster
  const ranked = g.members
    .map((u) => ({ u, n: (byAuthor.get(u) || []).length }))
    .sort((a, b) => b.n - a.n)
    .slice(0, 8);
  for (const r of ranked) console.log(`    @${r.u.padEnd(28)} ${r.n} posts`);
  if (g.members.length > 8) console.log(`    … and ${g.members.length - 8} more`);
  console.log();
}

const tail = sized.filter((g) => g.size < minCreators);
const tailCreators = tail.reduce((s, g) => s + g.size, 0);
console.log(`─── tail (${tail.length} clusters with < ${minCreators} creators, ${tailCreators} creators total) ───`);
const singletons = tail.filter((g) => g.size === 1);
console.log(`    singletons: ${singletons.length}`);
console.log(`    unlabeled cluster present: ${groups.some((g) => g.label === "unlabeled")}`);
console.log();

console.log("─── summary ───");
console.log(`  shown clusters (≥${minCreators} creators):  ${shown}`);
console.log(`  total clusters:                       ${groups.length}`);
console.log(`  largest cluster:                      ${sized[0]?.size || 0} creators (${sized[0]?.label || "—"})`);
console.log(`  creators in top-10 clusters:          ${sized.slice(0, 10).reduce((s, g) => s + g.size, 0)} / ${creators.length}`);
console.log();
