// IIFE mirror of src/lib/relevance.js for content scripts.
// Keep in lock-step. Tests for the ESM module cover both — the runtime is a
// near-verbatim transliteration.
//
// Exposes globalThis.__fsRelevance = {
//   scoreRelevance, byRelevance, topByRelevance, LEARNING_MODES,
//   scoreRelevanceFromPost  // helper that derives formatScores on the fly
// }.
//
// Depends on globalThis.__fsPostAnalysis.scoreFormats for posts that don't
// already carry `formatScores` (which they won't, until the server populates
// them on sync).

(function (root) {
  const DEFAULT_PREFS = Object.freeze({
    formatWeights: {},
    niches: [],
    nicheStrictness: 0.5,
    weights: Object.freeze({
      format: 0.25, niche: 0.20, outlier: 0.40, velocity: 0.15,
    }),
  });

  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

  const saturateOutlier = (x) => {
    if (!Number.isFinite(x) || x <= 0) return 0;
    return 1 - Math.exp(-Math.log(2) * (x - 1));
  };

  function mergePrefs(p) {
    const m = { ...DEFAULT_PREFS, ...(p || {}) };
    m.formatWeights = { ...DEFAULT_PREFS.formatWeights, ...(p && p.formatWeights) };
    m.niches = Array.isArray(p && p.niches)
      ? p.niches.map((n) => String(n).toLowerCase().trim()).filter(Boolean)
      : [];
    m.nicheStrictness = Number.isFinite(p && p.nicheStrictness)
      ? clamp01(p.nicheStrictness)
      : DEFAULT_PREFS.nicheStrictness;
    m.weights = { ...DEFAULT_PREFS.weights, ...((p && p.weights) || {}) };
    return m;
  }

  function explain(c, outlierRaw) {
    const parts = [];
    if (outlierRaw >= 1.5) parts.push(`outlier ${outlierRaw.toFixed(1)}×`);
    if (c.format >= 0.6) parts.push(`format-match ${c.format.toFixed(2)}`);
    if (c.niche >= 0.9) parts.push("niche-match");
    if (c.velocity >= 0.5) parts.push("accelerating");
    return parts.join(" • ") || "baseline";
  }

  function scoreRelevance(post, userPrefs) {
    const prefs = mergePrefs(userPrefs);
    const w = prefs.weights;

    const fScores = (post && post.formatScores) || {};
    let formatNum = 0, formatDen = 0;
    for (const label in fScores) {
      const conf = fScores[label];
      const wLabel = label in prefs.formatWeights ? prefs.formatWeights[label] : 0.5;
      formatNum += conf * wLabel;
      formatDen += conf;
    }
    const format = formatDen > 0 ? clamp01(formatNum / formatDen) : 0;

    let niche = 0;
    if (prefs.niches.length === 0) {
      niche = 0.5;
    } else {
      const postNiche = String((post && post.niche) || "").toLowerCase().trim();
      if (!postNiche) niche = 0.5 - 0.5 * prefs.nicheStrictness;
      else if (prefs.niches.some((n) => n === postNiche)) niche = 1;
      else if (prefs.niches.some((n) => postNiche.includes(n) || n.includes(postNiche))) niche = 0.6;
      else niche = 1 - prefs.nicheStrictness;
    }
    niche = clamp01(niche);

    // Use _score (computeOutliers) when post.outlier isn't directly set —
    // the overlay populates _score in filtered() before sort runs.
    const outlierRaw = Number(
      (post && (post.outlier != null ? post.outlier : post._score)) || 0
    );
    const outlier = saturateOutlier(outlierRaw);

    // velocityViewsPerHr is the field overlay sort already uses for "Velocity";
    // fall back to .velocity for parity with the ESM signature.
    const velRaw = Number(
      (post && (post.velocity != null ? post.velocity : post.velocityViewsPerHr)) || 0
    );
    const velocity = velRaw > 0 ? clamp01(1 - Math.exp(-velRaw / Math.max(1, velRaw < 100 ? 2 : 1000))) : 0;

    const score = clamp01(
      w.format * format + w.niche * niche + w.outlier * outlier + w.velocity * velocity
    );

    let boosted = score;
    if (post && post.pinned) boosted = clamp01(boosted + 0.20);
    if (post && post.meta && post.meta.status === "saved") boosted = clamp01(boosted + 0.10);
    if (post && post.surface === "explore" && outlierRaw < 1.5) boosted = boosted * 0.7;

    const components = { format, niche, outlier, velocity };
    return { score: boosted, components, reason: explain(components, outlierRaw) };
  }

  // Convenience: derive formatScores from caption on-the-fly when not present.
  // Caches per post id+desc to avoid recomputing within a sort.
  const _formatCache = new Map();
  function _formatScoresFor(post) {
    if (post && post.formatScores) return post.formatScores;
    const id = (post && post.id) || "";
    const key = id + "|" + ((post && post.desc) || "").length;
    let cached = _formatCache.get(key);
    if (cached) return cached;
    const fn = (root.__fsPostAnalysis && root.__fsPostAnalysis.scoreFormats) || null;
    cached = fn ? fn(post) : {};
    _formatCache.set(key, cached);
    if (_formatCache.size > 5000) {
      // bound the cache; oldest entries drop first.
      const firstKey = _formatCache.keys().next().value;
      _formatCache.delete(firstKey);
    }
    return cached;
  }

  function scoreRelevanceFromPost(post, userPrefs) {
    const augmented = post && !post.formatScores
      ? Object.assign({}, post, { formatScores: _formatScoresFor(post) })
      : post;
    return scoreRelevance(augmented, userPrefs);
  }

  function byRelevance(posts, userPrefs) {
    return (posts || [])
      .map((p) => Object.assign({ post: p }, scoreRelevanceFromPost(p, userPrefs)))
      .sort((a, b) => b.score - a.score);
  }

  function topByRelevance(posts, userPrefs, n) {
    const ranked = byRelevance(posts, userPrefs);
    return ranked.slice(0, Math.max(0, Number(n) || 0)).map((r) => r.post);
  }

  const LEARNING_MODES = {
    personalBrand: (over) => mergePrefs(Object.assign({
      weights: { format: 0.45, niche: 0.05, outlier: 0.40, velocity: 0.10 },
      nicheStrictness: 0.1,
    }, over || {})),
    nicheOperator: (over) => mergePrefs(Object.assign({
      weights: { format: 0.10, niche: 0.45, outlier: 0.35, velocity: 0.10 },
      nicheStrictness: 0.85,
    }, over || {})),
    hybrid: (over) => mergePrefs(over || {}),
  };

  // Reset hook for tests / cache busting on collect.end.
  function _resetCache() { _formatCache.clear(); }

  root.__fsRelevance = {
    scoreRelevance,
    scoreRelevanceFromPost,
    byRelevance,
    topByRelevance,
    LEARNING_MODES,
    _resetCache,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
