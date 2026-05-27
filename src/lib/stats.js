// Pure aggregation helpers for the stats sidebar. Mirrors the logic
// embedded in content.js so the math is unit-testable in isolation.
//
// All inputs are post objects already enriched with `_score`, `cpr`,
// `vph` (views/hour since posted), and `mediaType`/`isReel`/`carouselCount`
// flags. On Explore the outlier `_score` is intentionally 0 (no per-author
// baseline) — `makeScoreOf` falls back to a vph-relative ratio so stats
// stay meaningful instead of collapsing to 0% / 0× across the board.

import { median } from "./scoring.js";

export const HASHTAG_RE = /#([\w_]+)/g;

export const formatOf = (p) => {
  if (p.isReel || p.mediaType === 2) return "reel";
  if (p.mediaType === 8 || (p.carouselCount || 0) > 1) return "carousel";
  return "single";
};

// Build a `scoreOf` accessor for the given list. When every post has a
// real `_score`, it just reads that. When `_score` is 0 (Explore), it
// falls back to `vph / median(vph)` so 1.0 = average pace, ≥2 = double
// the median pace — same scale as outlier so downstream "≥2× outlier"
// thresholds keep working.
export const makeScoreOf = (list) => {
  const vphMed = median((list || []).map((p) => p.vph || 0).filter((x) => x > 0));
  return (p) => {
    const s = Number(p?._score) || 0;
    if (s > 0) return s;
    const v = Number(p?.vph) || 0;
    if (vphMed > 0 && v > 0) return v / vphMed;
    return 0;
  };
};

export const computeFormatStats = (list, scoreOf = (p) => p._score || 0) => {
  const buckets = { reel: [], carousel: [], single: [] };
  for (const p of list) buckets[formatOf(p)].push(p);
  return ["reel", "carousel", "single"].map((f) => {
    const items = buckets[f];
    const views = items.map((p) => p.views || 0).filter((x) => x > 0);
    const med = median(views);
    const outliers = items.filter((p) => scoreOf(p) >= 2).length;
    const pct = items.length ? (outliers / items.length) * 100 : 0;
    return { format: f, n: items.length, medianViews: med, outlierPct: pct };
  });
};

export const computeHashtagLift = (
  list,
  { minN = 3, top = 15, scoreOf = (p) => p._score || 0 } = {},
) => {
  const counts = new Map();
  const sums = new Map();
  let allSum = 0;
  let allN = 0;
  for (const p of list) {
    const s = scoreOf(p);
    allSum += s; allN++;
    const desc = p.desc || "";
    const seen = new Set();
    HASHTAG_RE.lastIndex = 0;
    let m;
    while ((m = HASHTAG_RE.exec(desc)) !== null) {
      const t = m[1].toLowerCase();
      if (seen.has(t)) continue;
      seen.add(t);
      counts.set(t, (counts.get(t) || 0) + 1);
      sums.set(t, (sums.get(t) || 0) + s);
    }
  }
  const rows = [];
  for (const [t, n] of counts) {
    if (n < minN) continue;
    const meanWith = sums.get(t) / n;
    const remN = allN - n;
    const meanWithout = remN > 0 ? (allSum - sums.get(t)) / remN : 0;
    const lift = meanWithout > 0 ? meanWith / meanWithout : (meanWith > 0 ? Number.POSITIVE_INFINITY : 0);
    rows.push({ tag: t, n, lift, meanWith });
  }
  rows.sort((a, b) => b.lift - a.lift);
  return rows.slice(0, top);
};

// Curated stopword list. Intentionally English-leaning and pragmatic —
// strips grammatical glue ("the", "and", "i", "you"), social-media fluff
// ("follow", "like", "share", "comment", "subscribe", "link"), and
// generic verbs/adjectives that don't differentiate niche. Niche-specific
// nouns (workout, recipe, vfx, finance) are left in.
export const STOPWORDS = new Set([
  // Articles / pronouns / aux verbs / prepositions
  "the","a","an","of","to","in","on","at","for","with","by","from","as","is",
  "are","was","were","be","been","being","am","do","does","did","done","doing",
  "have","has","had","having","will","would","could","should","may","might",
  "must","can","cant","cannot","wont","dont","didnt","im","ive","its","you",
  "your","youre","youll","youve","they","them","their","theirs","theyre","we",
  "our","ours","us","he","she","him","her","his","hers","this","that","these",
  "those","there","here","what","which","who","whom","whose","when","where",
  "why","how","not","no","nor","but","or","if","then","than","so","just",
  "very","too","really","because","while","about","into","over","under",
  "after","before","again","more","most","much","such","own","same","other",
  "some","any","all","each","every","both","few","many","only","also","ever",
  "still","now","ever","never","always","sometimes",
  // Filler conjunctions and copy-paste glue
  "and","yet","up","down","out","off","through","between","among",
  "via","upon","onto","across","around","without","within","along",
  "though","although","unless","until","since","whether",
  // Social-platform fluff
  "follow","followers","following","like","likes","liked","share","shared",
  "comment","comments","subscribe","subscribed","subscriber","subscribers",
  "link","bio","tag","tagged","mention","reels","reel","post","posted",
  "video","videos","content","check","watch","tap","click","swipe","save",
  "saved","new","todays","today","yesterday","tomorrow","day","week","month",
  "year","time","life","make","made","get","got","getting","gets","go","going",
  "went","let","lets","want","wanted","need","needed","know","known","see",
  "seen","said","say","says","one","two","three","first","last","next","best",
  "good","great","nice","amazing","awesome","love","loved","loves","hate",
  "thing","things","stuff","way","ways","lot","lots","little","big","small",
  "okay","ok","yeah","yes","yep","nope",
]);

// Tokenize a caption into normalized lowercase word stems suitable for
// frequency counting. Strips URLs, hashtags (handled separately), @mentions,
// emoji, numbers, and punctuation. Keeps Unicode letters so non-English
// niche terms aren't dropped by accident.
const URL_RE = /https?:\/\/\S+/g;
const TAG_RE = /[#@][\w_]+/g;
const WORD_RE = /\p{L}[\p{L}\p{M}']{2,}/gu;
export const captionWords = (text) => {
  const cleaned = String(text || "")
    .replace(URL_RE, " ")
    .replace(TAG_RE, " ")
    .toLowerCase();
  const out = [];
  for (const m of cleaned.matchAll(WORD_RE)) {
    const w = m[0].replace(/'$/, "").replace(/^'/, "");
    if (w.length < 3) continue;
    if (STOPWORDS.has(w)) continue;
    out.push(w);
  }
  return out;
};

// Top keywords by post-frequency. Same shape as computeHashtagLift so the
// UI can render them the same way (chip + count + lift). Lift is computed
// against `scoreOf` like hashtags.
export const computeKeywords = (
  list,
  { minN = 3, top = 15, scoreOf = (p) => p._score || 0, stopwords = STOPWORDS } = {},
) => {
  const counts = new Map();
  const sums = new Map();
  let allSum = 0;
  let allN = 0;
  for (const p of list) {
    const s = scoreOf(p);
    allSum += s; allN++;
    const seen = new Set();
    for (const w of captionWords(p.desc || "")) {
      if (stopwords?.has(w)) continue;
      if (seen.has(w)) continue;
      seen.add(w);
      counts.set(w, (counts.get(w) || 0) + 1);
      sums.set(w, (sums.get(w) || 0) + s);
    }
  }
  const rows = [];
  for (const [w, n] of counts) {
    if (n < minN) continue;
    const meanWith = sums.get(w) / n;
    const remN = allN - n;
    const meanWithout = remN > 0 ? (allSum - sums.get(w)) / remN : 0;
    const lift = meanWithout > 0 ? meanWith / meanWithout : (meanWith > 0 ? Number.POSITIVE_INFINITY : 0);
    rows.push({ word: w, n, lift, meanWith });
  }
  rows.sort((a, b) => b.n - a.n || (b.lift || 0) - (a.lift || 0));
  return rows.slice(0, top);
};

export const computeCaptionHist = (list, nb = 20, scoreOf = (p) => p._score || 0) => {
  const lens = list.map((p) => (p.desc || "").length).filter((x) => x > 0);
  const maxLen = lens.length ? Math.max(...lens) : 1;
  const minExp = 0;
  const maxExp = Math.max(1, Math.log10(maxLen + 1));
  const out = new Array(nb).fill(0);
  const non = new Array(nb).fill(0);
  for (const p of list) {
    const len = (p.desc || "").length;
    if (len <= 0) continue;
    const exp = Math.log10(len);
    let b = Math.floor(((exp - minExp) / (maxExp - minExp || 1)) * nb);
    if (b < 0) b = 0;
    if (b >= nb) b = nb - 1;
    if (scoreOf(p) >= 2) out[b]++;
    else non[b]++;
  }
  return { out, non, nb, maxLen };
};

export const computeCprStats = (list) => {
  const cprs = list.map((p) => p.cpr || 0).filter((x) => x > 0);
  return {
    median: median(cprs),
    mean: cprs.length ? cprs.reduce((a, b) => a + b, 0) / cprs.length : 0,
    n: cprs.length,
  };
};

export const cprOf = (p) => (p.comments || 0) / Math.max(p.likes || 0, 1) * 1000;

export const computeCadence = (list, scoreOf = (p) => p._score || 0) => {
  const cell = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ n: 0, sum: 0 }))
  );
  for (const p of list) {
    if (!p.createTime) continue;
    const d = new Date(p.createTime * 1000);
    cell[d.getDay()][d.getHours()].n++;
    cell[d.getDay()][d.getHours()].sum += scoreOf(p);
  }
  return cell;
};

export const computeStats = (list) => {
  const scoreOf = makeScoreOf(list);
  return {
    total: list.length,
    authors: new Set(list.map((p) => p.author).filter(Boolean)).size,
    formats: computeFormatStats(list, scoreOf),
    hashtags: computeHashtagLift(list, { scoreOf }),
    keywords: computeKeywords(list, { scoreOf }),
    hist: computeCaptionHist(list, 20, scoreOf),
    cpr: computeCprStats(list),
    cadence: computeCadence(list, scoreOf),
  };
};
