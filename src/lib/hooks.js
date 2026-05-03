// Hook similarity helpers — extract a normalized "hook" (first line of caption,
// stripped) and compute trigram-Jaccard similarity between hooks. Used to find
// when one creator reuses a hook that was an outlier on another creator.

export const extractHook = (desc) => {
  const first = String(desc || "").split("\n")[0].slice(0, 80).toLowerCase();
  return first.replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
};

// Pad with two spaces so 1–2 char tokens still produce some n-grams.
export const trigrams = (s) => {
  const t = `  ${String(s || "")}  `;
  const out = new Set();
  if (t.length < 3) return out;
  for (let i = 0; i <= t.length - 3; i++) out.add(t.slice(i, i + 3));
  return out;
};

export const jaccard = (a, b) => {
  if (!a || !b || !a.size || !b.size) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (big.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 0;
};

// `historical` — array of posts with at least { id, author, hook, _score, createTime }.
// Returns matches: { newPostId, histPostId, similarity, ... } meeting all thresholds.
export const findHookMatches = (newPost, historical, opts = {}) => {
  const minSimilarity = opts.minSimilarity ?? 0.6;
  const minHistScore = opts.minHistScore ?? 3;
  const newHook = newPost?.hook;
  if (!newHook) return [];
  const newAuthor = String(newPost.author || "").toLowerCase();
  const a = trigrams(newHook);
  const out = [];
  for (const h of historical) {
    if (!h || !h.hook || !h.id || h.id === newPost.id) continue;
    if ((Number(h._score) || 0) < minHistScore) continue;
    const histAuthor = String(h.author || "").toLowerCase();
    if (!histAuthor || histAuthor === newAuthor) continue;
    const sim = jaccard(a, trigrams(h.hook));
    if (sim < minSimilarity) continue;
    out.push({
      newPostId: newPost.id,
      newAuthor,
      newHook,
      newCreateTime: newPost.createTime || 0,
      histPostId: h.id,
      histAuthor,
      histHook: h.hook,
      histScore: Number(h._score) || 0,
      histCreateTime: h.createTime || 0,
      similarity: sim,
    });
  }
  // Best match per pair already unique by (newPostId, histPostId).
  out.sort((x, y) => y.similarity - x.similarity);
  return out;
};
