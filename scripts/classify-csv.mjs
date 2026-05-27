#!/usr/bin/env node
// Fast local JSON → CSV classifier for exported Feed Sorter libraries.
// Default mode is deterministic rules only. Optional --llm refines only rows
// where category/format confidence is low, using local Ollama via src/lib/llm.js.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chat, DEFAULT_ENDPOINT, DEFAULT_MODEL } from "../src/lib/llm.js";
import { CATEGORY_LABELS, FORMAT_LABELS, classifyForCsv, buildClassificationText } from "../src/analysis/post-analysis.js";

const USAGE = "Usage: node scripts/classify-csv.mjs <library-export.json> [--out file.csv] [--llm] [--min-confidence 0.45] [--model gemma4] [--endpoint http://localhost:11434]\n\nInput JSON shape: either an array of post rows, or { posts: [...] }.\nDefault output is CSV on stdout; --out writes to a file.";

const argv = process.argv.slice(2);
if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
  console.log(USAGE);
  process.exit(argv.length ? 0 : 1);
}

const flags = {
  input: "",
  out: "",
  llm: false,
  minConfidence: 0.45,
  model: DEFAULT_MODEL,
  endpoint: DEFAULT_ENDPOINT,
};

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--out") flags.out = String(argv[++i] || "");
  else if (arg === "--llm") flags.llm = true;
  else if (arg === "--min-confidence") flags.minConfidence = Number(argv[++i]);
  else if (arg === "--model") flags.model = String(argv[++i] || DEFAULT_MODEL);
  else if (arg === "--endpoint") flags.endpoint = String(argv[++i] || DEFAULT_ENDPOINT);
  else if (!flags.input) flags.input = arg;
  else {
    console.error(`Unknown argument: ${arg}`);
    process.exit(2);
  }
}

if (!Number.isFinite(flags.minConfidence)) flags.minConfidence = 0.45;
const inputPath = resolve(process.cwd(), flags.input);
if (!existsSync(inputPath)) {
  console.error(`File not found: ${inputPath}`);
  process.exit(2);
}

const raw = JSON.parse(readFileSync(inputPath, "utf8"));
const posts = Array.isArray(raw) ? raw : Array.isArray(raw?.posts) ? raw.posts : [];
if (!posts.length) {
  console.error("No posts found in input.");
  process.exit(3);
}

const csvEscape = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
const transcriptText = (post) => {
  if (typeof post?.transcript === "string" && post.transcript.trim()) return post.transcript;
  if (Array.isArray(post?.transcriptSegments)) {
    return post.transcriptSegments.map((s) => String(s?.text || "").trim()).filter(Boolean).join(" ");
  }
  return "";
};
const transcriptSegmentsText = (post) => {
  const segs = Array.isArray(post?.transcriptSegments) ? post.transcriptSegments : [];
  return segs.map((s) => {
    const start = Number.isFinite(Number(s?.start)) ? Number(s.start).toFixed(2) : "";
    const end = Number.isFinite(Number(s?.end)) ? Number(s.end).toFixed(2) : "";
    const text = String(s?.text || "").trim();
    return start || end ? `[${start}-${end}] ${text}` : text;
  }).filter(Boolean).join(" | ");
};
const isoDate = (seconds) => seconds ? new Date(Number(seconds) * 1000).toISOString() : "";
const fmtConfidence = (value) => value == null || value === "" ? "" : Number(value || 0).toFixed(2);
const lowConfidence = (row) => Number(row.categoryConfidence || 0) < flags.minConfidence || Number(row.formatConfidence || 0) < flags.minConfidence;

const LLM_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: CATEGORY_LABELS },
    niche: { type: "string", description: "2-4 lowercase words, bounded and specific" },
    contentFormat: { type: "string", enum: [...FORMAT_LABELS, "other"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["category", "niche", "contentFormat", "confidence"],
};

const LLM_SYSTEM = [
  "Classify one short-form social post for spreadsheet filtering.",
  `category MUST be one of: ${CATEGORY_LABELS.join(", ")}.`,
  `contentFormat MUST be one of: ${[...FORMAT_LABELS, "other"].join(", ")}.`,
  "niche MUST be 2-4 lowercase words. Return strict JSON only.",
].join("\n");

const trimForLlm = (text) => {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > 6000 ? `${clean.slice(0, 6000)}…` : clean;
};

const normalizeLlmLabel = (value, allowed, fallback) => {
  const label = String(value || "").toLowerCase().trim();
  return allowed.includes(label) ? label : fallback;
};

const normalizeNiche = (value, fallback) => String(value || fallback || "")
  .toLowerCase()
  .replace(/[_-]+/g, " ")
  .replace(/[^a-z0-9\s&/]+/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .split(" ")
  .slice(0, 4)
  .join(" ");

async function refineWithLlm(post, base) {
  const user = trimForLlm(buildClassificationText(post));
  if (!user) return base;
  const result = await chat({
    endpoint: flags.endpoint,
    model: flags.model,
    schema: LLM_SCHEMA,
    kind: "csv-classification",
    postId: post.id || null,
    options: { temperature: 0.1 },
    messages: [
      { role: "system", content: LLM_SYSTEM },
      { role: "user", content: user },
    ],
  });
  const json = result?.json ? result.json : null;
  if (!json) return base;
  const category = normalizeLlmLabel(json.category, CATEGORY_LABELS, base.category);
  const contentFormat = normalizeLlmLabel(json.contentFormat, [...FORMAT_LABELS, "other"], base.contentFormat);
  const confidence = Math.max(0, Math.min(1, Number(json.confidence) || 0));
  return {
    ...base,
    category,
    niche: normalizeNiche(json.niche, base.niche || category),
    contentFormat,
    format: base.visualFormat && base.visualFormat !== "other" ? base.visualFormat : contentFormat,
    categoryConfidence: Math.max(Number(base.categoryConfidence) || 0, confidence),
    formatConfidence: Math.max(Number(base.formatConfidence) || 0, confidence),
    classificationSource: "llm",
    classificationAt: Date.now(),
  };
}

const rows = [];
let refined = 0;
let llmFailed = 0;
for (const post of posts) {
  let classification = classifyForCsv(post);
  if (flags.llm && lowConfidence(classification)) {
    try {
      classification = await refineWithLlm(post, classification);
      refined++;
    } catch (err) {
      llmFailed++;
      console.error(`LLM refinement failed for ${post?.id || "unknown"}: ${String(err?.message || err)}`);
    }
  }
  rows.push({ post, classification });
}

const columns = [
  ["id", ({ post }) => post?.id || ""],
  ["creator", ({ post }) => post?.author || post?.username || ""],
  ["category", ({ classification }) => classification.category],
  ["niche", ({ classification }) => classification.niche],
  ["format", ({ classification }) => classification.format],
  ["contentFormat", ({ classification }) => classification.contentFormat],
  ["visualFormat", ({ classification }) => classification.visualFormat],
  ["categoryConfidence", ({ classification }) => fmtConfidence(classification.categoryConfidence)],
  ["formatConfidence", ({ classification }) => fmtConfidence(classification.formatConfidence)],
  ["classificationSource", ({ classification }) => classification.classificationSource],
  ["caption", ({ post }) => post?.desc || ""],
  ["transcript", ({ post }) => transcriptText(post)],
  ["transcriptSegments", ({ post }) => transcriptSegmentsText(post)],
  ["views", ({ post }) => post?.views || 0],
  ["likes", ({ post }) => post?.likes || 0],
  ["comments", ({ post }) => post?.comments || 0],
  ["url", ({ post }) => post?.url || ""],
  ["createdAt", ({ post }) => isoDate(post?.createTime)],
  ["platform", ({ post }) => post?.platform || ""],
  ["surface", ({ post }) => post?.surface || ""],
];

const csv = `${[
  columns.map(([name]) => csvEscape(name)).join(","),
  ...rows.map((row) => columns.map(([, value]) => csvEscape(value(row))).join(",")),
].join("\r\n")}\r\n`;

if (flags.out) {
  const outPath = resolve(process.cwd(), flags.out);
  writeFileSync(outPath, csv, "utf8");
  console.error(`Wrote ${rows.length} rows to ${outPath}${flags.llm ? ` (${refined} LLM refined, ${llmFailed} failed)` : ""}`);
} else {
  process.stdout.write(csv);
  if (flags.llm) console.error(`LLM refined ${refined} rows; failed ${llmFailed}.`);
}
