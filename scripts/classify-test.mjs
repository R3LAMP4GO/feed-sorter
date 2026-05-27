#!/usr/bin/env node
// CLI test harness for scoreFormats — runs the cheap text-only classifier
// over an exported library JSON and prints a human-readable report.
//
// Usage:
//   node scripts/classify-test.mjs <library-export.json> [--creator <username>] [--min-confidence 0.4]
//
// Input JSON shape: either an array of post rows, or { posts: [...] }.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { scoreFormats, FORMAT_LABELS } from "../src/analysis/post-analysis.js";
import { computeCreatorProfiles, applyCreatorInheritance } from "../src/analysis/creator-inheritance.js";

// ---------- argv ----------
const argv = process.argv.slice(2);
if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
  console.log("Usage: node scripts/classify-test.mjs <library-export.json> [--creator <username>] [--min-confidence 0.4] [--inherit]");
  console.log("  --inherit  enable creator-level label inheritance (fills caption-less posts)");
  process.exit(argv.length ? 0 : 1);
}
const file = resolve(process.cwd(), argv[0]);
const flags = {};
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--creator") { flags.creator = String(argv[++i] || "").toLowerCase(); }
  else if (a === "--min-confidence") { flags.minConf = Number(argv[++i]); }
  else if (a === "--inherit") { flags.inherit = true; }
}
const minConf = Number.isFinite(flags.minConf) ? flags.minConf : 0.4;

if (!existsSync(file)) {
  console.error(`File not found: ${file}`);
  console.error("Hit the \"Export library\" button in the extension overlay, then point this script at the downloaded JSON.");
  process.exit(2);
}

// ---------- load ----------
const raw = JSON.parse(readFileSync(file, "utf8"));
const posts = Array.isArray(raw) ? raw : Array.isArray(raw?.posts) ? raw.posts : [];
if (!posts.length) {
  console.error("No posts found in input.");
  process.exit(3);
}

// ---------- helpers ----------
const nameOf = (p) => String((p && (p.author || p.username)) || "(unknown)").toLowerCase();
const captionOf = (p) => String((p?.desc) || "").replace(/\s+/g, " ").trim();
const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const sortLabels = (scores) => Object.entries(scores).sort(([, a], [, b]) => b - a);
const fmtScore = (v) => v.toFixed(2);
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : "—");

// ---------- per-post classification ----------
const filtered = flags.creator
  ? posts.filter((p) => nameOf(p) === flags.creator || nameOf(p).includes(flags.creator))
  : posts;

if (flags.creator && !filtered.length) {
  console.error(`No posts found for creator "${flags.creator}".`);
  console.error("Top creators in this export:");
  const counts = new Map();
  for (const p of posts) counts.set(nameOf(p), (counts.get(nameOf(p)) || 0) + 1);
  const top = Array.from(counts.entries()).sort(([, a], [, b]) => b - a).slice(0, 15);
  for (const [name, n] of top) console.error(`  ${n.toString().padStart(4)}  @${name}`);
  process.exit(4);
}

// Build creator profiles from the FULL library (not just the filtered subset)
// so inheritance for a single creator still has the rest of the library to
// learn from. Then classify with optional inheritance.
const creatorProfiles = flags.inherit ? computeCreatorProfiles(posts) : null;
const classified = filtered.map((p) => {
  if (flags.inherit) {
    const r = applyCreatorInheritance(p, creatorProfiles);
    return { post: p, scores: r.scores, inferred: r.inferred, inheritedFromCreator: r.inheritedFromCreator };
  }
  return { post: p, scores: scoreFormats(p), inferred: {}, inheritedFromCreator: false };
});

// ---------- aggregate ----------
const labelCounts = Object.fromEntries(FORMAT_LABELS.map((l) => [l, 0]));
const labelConfSum = Object.fromEntries(FORMAT_LABELS.map((l) => [l, 0]));
let postsWithAnyConfident = 0;
let postsMultiLabel = 0;
let _postsZero = 0;
const byCreator = new Map();
const spotlight = []; // multi-label posts above min-confidence

for (const { post, scores } of classified) {
  const above = Object.entries(scores).filter(([, v]) => v >= minConf);
  if (above.length === 0) _postsZero++;
  else postsWithAnyConfident++;
  if (above.length >= 2) {
    postsMultiLabel++;
    spotlight.push({ post, scores });
  }
  for (const [label, v] of Object.entries(scores)) {
    if (v >= minConf) labelCounts[label] = (labelCounts[label] || 0) + 1;
    labelConfSum[label] = (labelConfSum[label] || 0) + v;
  }
  const creator = nameOf(post);
  if (!byCreator.has(creator)) byCreator.set(creator, []);
  byCreator.get(creator).push({ post, scores });
}

// ---------- inheritance summary ----------
let inheritedPosts = 0;
for (const c of classified) if (c.inheritedFromCreator) inheritedPosts++;

// ---------- print ----------
const N = classified.length;
const bar = (n, max, width = 20) => {
  const w = max ? Math.round((n / max) * width) : 0;
  return "█".repeat(w) + "·".repeat(width - w);
};

console.log(`\nclassify-test  •  ${file}`);
console.log(`posts: ${N}${flags.creator ? `  (filter: @${flags.creator})` : ""}  •  min-confidence: ${minConf}${flags.inherit ? `  •  creator-inheritance: ON (${inheritedPosts} inherited)` : ""}\n`);

// ---------- creator section ----------
const creatorEntries = Array.from(byCreator.entries()).sort(([, a], [, b]) => b.length - a.length);
console.log("─── creators (by post count) ───");
for (const [creator, rows] of creatorEntries.slice(0, flags.creator ? 999 : 25)) {
  // Per-creator label averages
  const sums = {};
  for (const { scores } of rows) {
    for (const [k, v] of Object.entries(scores)) sums[k] = (sums[k] || 0) + v;
  }
  const avgs = Object.entries(sums)
    .map(([k, s]) => [k, s / rows.length])
    .sort(([, a], [, b]) => b - a);
  const top3 = avgs.slice(0, 3).map(([k, v]) => `${k} ${fmtScore(v)}`).join("  ");
  // Histogram (count where conf >= minConf)
  const hist = {};
  for (const { scores } of rows) {
    for (const [k, v] of Object.entries(scores)) {
      if (v >= minConf) hist[k] = (hist[k] || 0) + 1;
    }
  }
  const histStr = Object.entries(hist)
    .sort(([, a], [, b]) => b - a)
    .map(([k, n]) => `${k}:${n}`)
    .join("  ");
  console.log(`@${creator.padEnd(28)} ${rows.length.toString().padStart(4)} posts`);
  console.log(`  top3: ${top3 || "(none)"}`);
  if (histStr) console.log(`  hist: ${histStr}`);
}
if (!flags.creator && creatorEntries.length > 25) {
  console.log(`  … and ${creatorEntries.length - 25} more creators`);
}

// ---------- spotlight ----------
console.log("\n─── multi-label spotlight ───");
const spotSorted = spotlight
  .map((row) => {
    const top2 = sortLabels(row.scores).slice(0, 2);
    return { ...row, dominance: top2.length === 2 ? top2[1][1] : 0 };
  })
  .sort((a, b) => b.dominance - a.dominance)
  .slice(0, flags.creator ? 9999 : 30);

for (const { post, scores, inferred } of spotSorted) {
  const labels = sortLabels(scores).map(([k, v]) => `${k}:${fmtScore(v)}${inferred?.[k] ? "*" : ""}`).join("  ");
  console.log(`  ${post.id || "?"}  @${nameOf(post)}`);
  console.log(`    ${truncate(captionOf(post), 100)}`);
  console.log(`    ${labels}`);
}
if (flags.inherit && spotSorted.length) console.log("  (* = inferred from creator profile)");
if (!spotSorted.length) console.log("  (none)");

// ---------- creator detail (--creator only) ----------
if (flags.creator) {
  console.log("\n─── per-post detail ───");
  for (const { post, scores, inferred, inheritedFromCreator } of classified) {
    const labels = sortLabels(scores).map(([k, v]) => `${k}:${fmtScore(v)}${inferred?.[k] ? "*" : ""}`).join("  ");
    const tag = inheritedFromCreator ? " [inherited]" : "";
    console.log(`  ${post.id || "?"}  ${post.durationSec ? `${post.durationSec}s` : "??"}  views=${post.views ?? "?"}${tag}`);
    console.log(`    ${truncate(captionOf(post), 140)}`);
    console.log(`    ${labels || "(no labels above noise floor)"}`);
  }
  if (flags.inherit) console.log("  (* = inferred from creator profile, [inherited] = post had no own signal)");
}

// ---------- aggregate stats ----------
// Tiered confidence buckets — "confident" (>= minConf, default 0.4) is the
// label we'd display unfaded; "hint" (>= 0.2) is the low-confidence chip we'd
// show greyed-out; "none" is the truly-unknown pile.
let postsWithHint = 0;
for (const { scores } of classified) {
  if (Object.values(scores).some((v) => v >= 0.2)) postsWithHint++;
}

console.log("\n─── aggregate ───");
console.log(`  any-confident-label   (>= ${minConf}):   ${postsWithAnyConfident.toString().padStart(5)}  (${pct(postsWithAnyConfident, N)})`);
console.log(`  any-hint-label        (>= 0.2):   ${postsWithHint.toString().padStart(5)}  (${pct(postsWithHint, N)})`);
console.log(`  multi-label           (>= ${minConf}):   ${postsMultiLabel.toString().padStart(5)}  (${pct(postsMultiLabel, N)})`);
console.log(`  no-label-at-all       (« 0.2):   ${(N - postsWithHint).toString().padStart(5)}  (${pct(N - postsWithHint, N)})  ← truly the "?" pile`);
console.log("");

const maxCount = Math.max(...Object.values(labelCounts), 1);
console.log("  label distribution (count where confidence ≥ min):");
const labelRows = Object.entries(labelCounts)
  .map(([k, n]) => [k, n, labelConfSum[k] / Math.max(1, N)])
  .sort(([, a], [, b]) => b - a);
for (const [label, count, avgConf] of labelRows) {
  console.log(`    ${label.padEnd(14)} ${count.toString().padStart(5)}  ${bar(count, maxCount)}  avg=${fmtScore(avgConf)}`);
}
console.log("");
