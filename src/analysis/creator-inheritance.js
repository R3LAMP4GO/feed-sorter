// Creator-level format inheritance.
//
// On platforms where captions are sparse (Instagram especially) the cheap
// text-only classifier returns "(no labels)" for the majority of a creator's
// posts. But a creator's format mix is highly stable over time — a fitness
// talking-head creator does talking-head reels even on the posts where they
// didn't bother with a caption.
//
// Strategy:
//   1. For each creator with at least N captioned posts, compute their
//      `formatProfile` — the average per-label confidence across posts where
//      scoreFormats produced any signal.
//   2. For any post by that creator whose own scores are weak (top label below
//      a confidence floor), MERGE the creator profile in at a damped weight
//      (default 0.7) and mark each inherited label `inferred: true`.
//
// Pure ESM, no DOM, no chrome APIs. Used by scripts/classify-test.mjs and the
// server-side classification pipeline. Unit-tested in
// tests/unit/creator-inheritance.test.js.

import { scoreFormats, FORMAT_LABELS } from "./post-analysis.js";

const DEFAULT_MIN_SAMPLE = 5;
const DEFAULT_INHERIT_WEIGHT = 0.7;
const DEFAULT_OWN_FLOOR = 0.4;

const authorOf = (p) => String((p && (p.author || p.username)) || "").toLowerCase();
const _hasOwnSignal = (p) => {
  const desc = String((p?.desc) || "").trim();
  return desc.length > 0;
};

/**
 * Compute one creator profile from a list of their posts.
 * Only posts whose own scoreFormats produces at least one label above 0.15
 * count toward the average. The denominator is the number of contributing
 * posts, not the total — one outlier no-signal post shouldn't dilute the mean.
 *
 * @param {Array} posts — all posts by a single creator
 * @returns {{
 *   sampleSize: number,           // contributing posts
 *   totalPosts: number,           // total posts seen for this creator
 *   profile: Object<string,number> // label → avg confidence
 * } | null}
 */
export function computeCreatorProfile(posts) {
  if (!Array.isArray(posts) || posts.length === 0) return null;
  const sums = {};
  let contributors = 0;
  for (const p of posts) {
    const s = scoreFormats(p);
    const keys = Object.keys(s);
    if (keys.length === 0) continue;
    contributors++;
    for (const k of keys) sums[k] = (sums[k] || 0) + s[k];
  }
  if (contributors === 0) return { sampleSize: 0, totalPosts: posts.length, profile: {} };
  const profile = {};
  for (const [k, sum] of Object.entries(sums)) {
    profile[k] = sum / contributors;
  }
  return { sampleSize: contributors, totalPosts: posts.length, profile };
}

/**
 * Compute creator profiles for an entire library.
 * @param {Array} posts
 * @param {{minSample?: number}} opts
 * @returns {Map<string, ReturnType<typeof computeCreatorProfile>>}
 */
export function computeCreatorProfiles(posts, opts = {}) {
  const minSample = Number.isFinite(opts.minSample) ? opts.minSample : DEFAULT_MIN_SAMPLE;
  const byAuthor = new Map();
  for (const p of posts || []) {
    const a = authorOf(p);
    if (!a) continue;
    if (!byAuthor.has(a)) byAuthor.set(a, []);
    byAuthor.get(a).push(p);
  }
  const out = new Map();
  for (const [a, rows] of byAuthor) {
    const prof = computeCreatorProfile(rows);
    if (!prof) continue;
    if (prof.sampleSize < minSample) continue;
    out.set(a, prof);
  }
  return out;
}

/**
 * Apply creator inheritance to a single post.
 * Merge logic:
 *   - Compute the post's own scoreFormats. Find its top label confidence.
 *   - If top >= ownFloor (default 0.4), the post speaks for itself; return
 *     own scores untouched, no `inferred` flag.
 *   - Otherwise, merge the creator profile at `inheritWeight` (default 0.7).
 *     For each label in the creator profile, take MAX(own, profile×weight).
 *     Mark labels that exceeded their own value via inheritance with
 *     `inferred: true` in the parallel `inferred` map.
 *
 * @returns {{
 *   scores: Object<string,number>,
 *   inferred: Object<string,boolean>,
 *   inheritedFromCreator: boolean,
 *   ownTop: number
 * }}
 */
export function applyCreatorInheritance(post, creatorProfiles, opts = {}) {
  const ownFloor = Number.isFinite(opts.ownFloor) ? opts.ownFloor : DEFAULT_OWN_FLOOR;
  const inheritWeight = Number.isFinite(opts.inheritWeight) ? opts.inheritWeight : DEFAULT_INHERIT_WEIGHT;

  const own = scoreFormats(post);
  const ownTop = Object.values(own).reduce((m, v) => (v > m ? v : m), 0);

  if (ownTop >= ownFloor) {
    return { scores: own, inferred: {}, inheritedFromCreator: false, ownTop };
  }

  const a = authorOf(post);
  const creator = creatorProfiles && (creatorProfiles.get ? creatorProfiles.get(a) : creatorProfiles[a]);
  if (!creator || !creator.profile) {
    return { scores: own, inferred: {}, inheritedFromCreator: false, ownTop };
  }

  const merged = { ...own };
  const inferred = {};
  for (const [label, profConf] of Object.entries(creator.profile)) {
    const damped = profConf * inheritWeight;
    if (damped < 0.15) continue; // honor the noise floor
    if (!(label in merged) || merged[label] < damped) {
      merged[label] = damped;
      inferred[label] = true;
    }
  }
  return { scores: merged, inferred, inheritedFromCreator: true, ownTop };
}

export const _CONSTANTS = {
  DEFAULT_MIN_SAMPLE,
  DEFAULT_INHERIT_WEIGHT,
  DEFAULT_OWN_FLOOR,
};

// Re-export for convenience so callers don't need a second import.
export { FORMAT_LABELS };
