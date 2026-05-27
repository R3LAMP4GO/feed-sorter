// Per-post relevance score for a given user.
//
// Combines four orthogonal signals into a single 0..1 score that sorts the
// library and prioritizes the ASR / LLM transcription queue:
//
//   1. format match     — dot product of post.formatScores against the
//                          user's preferred-format weight vector.
//   2. niche match       — exact or fuzzy match between post.niche and the
//                          user's stated niches.
//   3. outlier strength  — post.outlier (post views ÷ author median),
//                          normalized through a soft saturating curve.
//   4. velocity          — accelerating + recently-posted bonus.
//
// Plus boosts: pinned posts, posts the user has interacted with, and a small
// platform-shape factor (e.g. tighter caps on Explore-page items because
// they're firehose noise unless they cleared the outlier bar).
//
// Default user preferences correspond to the "Hybrid" learning mode from the
// architecture conversation: equal format weights, no niche filter, outlier
// dominates. Override by passing `userPrefs`.

const DEFAULT_PREFS = Object.freeze({
  formatWeights: {},        // label → 0..1, missing labels default to 0.5
  niches: [],               // string[] — the user's chosen niches (lowercase)
  nicheStrictness: 0.5,     // 0 = format-only, 1 = niche-must-match
  weights: Object.freeze({  // mode mixer
    format: 0.25,
    niche: 0.20,
    outlier: 0.40,
    velocity: 0.15,
  }),
});

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Sigmoid-ish saturation for outlier scores. An outlier of 1× = baseline,
// 2× ≈ 0.62, 5× ≈ 0.93, 10× → 1. Avoids one viral post dominating forever.
const saturateOutlier = (x) => {
  if (!Number.isFinite(x) || x <= 0) return 0;
  return 1 - Math.exp(-Math.log(2) * (x - 1));
};

/**
 * Score a post's relevance for a given user.
 * @param {object} post — must include `formatScores` (object), and ideally
 *   `niche`, `outlier`, `velocity`, `pinned`, `surface`.
 * @param {object} userPrefs — see DEFAULT_PREFS shape; missing keys merge.
 * @returns {{
 *   score: number,
 *   components: { format: number, niche: number, outlier: number, velocity: number },
 *   reason: string  // one-line human explainer ("outlier 4.2× • format-match 0.7")
 * }}
 */
export function scoreRelevance(post, userPrefs = {}) {
  const prefs = mergePrefs(userPrefs);
  const w = prefs.weights;

  // ---- 1. format match ----
  const fScores = (post?.formatScores) || {};
  let formatNum = 0;
  let formatDen = 0;
  for (const [label, conf] of Object.entries(fScores)) {
    const wLabel = label in prefs.formatWeights ? prefs.formatWeights[label] : 0.5;
    formatNum += conf * wLabel;
    formatDen += conf;
  }
  const format = formatDen > 0 ? clamp01(formatNum / formatDen) : 0;

  // ---- 2. niche match ----
  let niche = 0;
  if (prefs.niches.length === 0) {
    // No niche preference set — neutral 0.5 so it neither helps nor hurts.
    niche = 0.5;
  } else {
    const postNiche = String((post?.niche) || "").toLowerCase().trim();
    if (!postNiche) {
      // Post has no niche label — penalize slightly under strictness.
      niche = 0.5 - 0.5 * prefs.nicheStrictness;
    } else if (prefs.niches.some((n) => n === postNiche)) {
      niche = 1;
    } else if (prefs.niches.some((n) => postNiche.includes(n) || n.includes(postNiche))) {
      // Partial substring match (cheap fuzzy) — half credit.
      niche = 0.6;
    } else {
      niche = 1 - prefs.nicheStrictness; // strict mode: 0; loose mode: 1.
    }
  }
  niche = clamp01(niche);

  // ---- 3. outlier strength ----
  const outlierRaw = Number((post?.outlier) || 0);
  const outlier = saturateOutlier(outlierRaw);

  // ---- 4. velocity ----
  // post.velocity is computed by src/store.js read path; expect a number where
  // > 0 means accelerating. Saturate for the same reason as outlier.
  const velRaw = Number((post?.velocity) || 0);
  const velocity = velRaw > 0 ? clamp01(1 - Math.exp(-velRaw / 2)) : 0;

  // ---- mix ----
  const score = clamp01(
    w.format * format +
    w.niche * niche +
    w.outlier * outlier +
    w.velocity * velocity
  );

  // ---- boosts ----
  let boosted = score;
  if (post?.pinned) boosted = clamp01(boosted + 0.20);
  if (post?.meta && post.meta.status === "saved") boosted = clamp01(boosted + 0.10);
  if (post && post.surface === "explore" && outlierRaw < 1.5) {
    // Explore firehose: dampen unless the post has cleared a meaningful bar.
    boosted = boosted * 0.7;
  }

  const reason = explain({ format, niche, outlier, velocity, outlierRaw });

  return {
    score: boosted,
    components: { format, niche, outlier, velocity },
    reason,
  };
}

/**
 * Sort a list of posts by relevance descending. Pure — does not mutate.
 * Useful directly: `byRelevance(posts, prefs).slice(0, N)`.
 */
export function byRelevance(posts, userPrefs = {}) {
  return [...posts]
    .map((p) => ({ post: p, ...scoreRelevance(p, userPrefs) }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Pick the top-N posts by relevance. Convenience for the transcription queue
 * gate: `topByRelevance(eligible, prefs, 200)`.
 */
export function topByRelevance(posts, userPrefs, n) {
  const ranked = byRelevance(posts, userPrefs);
  return ranked.slice(0, Math.max(0, Number(n) || 0)).map((r) => r.post);
}

// ----- internals -----

function mergePrefs(p) {
  const m = { ...DEFAULT_PREFS, ...(p || {}) };
  m.formatWeights = { ...DEFAULT_PREFS.formatWeights, ...(p?.formatWeights) };
  m.niches = Array.isArray(p?.niches)
    ? p.niches.map((n) => String(n).toLowerCase().trim()).filter(Boolean)
    : [];
  m.nicheStrictness = Number.isFinite(p?.nicheStrictness)
    ? clamp01(p.nicheStrictness)
    : DEFAULT_PREFS.nicheStrictness;
  m.weights = { ...DEFAULT_PREFS.weights, ...((p?.weights) || {}) };
  return m;
}

function explain({ format, niche, outlier, velocity, outlierRaw }) {
  const parts = [];
  if (outlierRaw >= 1.5) parts.push(`outlier ${outlierRaw.toFixed(1)}×`);
  if (format >= 0.6) parts.push(`format-match ${format.toFixed(2)}`);
  if (niche >= 0.9) parts.push("niche-match");
  if (velocity >= 0.5) parts.push("accelerating");
  return parts.join(" • ") || "baseline";
}

// Expose three preset modes that map cleanly onto the three personas from
// the architecture conversation. A consumer can do
//   const prefs = LEARNING_MODES.personalBrand({ niches: ["fitness"] });
export const LEARNING_MODES = {
  // Personal brand: study delivery patterns. Format dominates, niche permissive.
  personalBrand: (override = {}) => mergePrefs({
    weights: { format: 0.45, niche: 0.05, outlier: 0.40, velocity: 0.10 },
    nicheStrictness: 0.1,
    ...override,
  }),
  // Niche operator: study what works in my lane. Niche dominates, format flexible.
  nicheOperator: (override = {}) => mergePrefs({
    weights: { format: 0.10, niche: 0.45, outlier: 0.35, velocity: 0.10 },
    nicheStrictness: 0.85,
    ...override,
  }),
  // Hybrid (default): balanced.
  hybrid: (override = {}) => mergePrefs({ ...override }),
};

export const _internals = { saturateOutlier, mergePrefs };
