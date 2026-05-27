// Niche post-clustering tests. Uses a deterministic stub embedFn that maps
// keyword presence onto a small fixed-dim space — no MiniLM model loading.
import { describe, it, expect } from "vitest";
import { clusterPostsByNiche, labelClusters, __internals } from "../../src/analysis/niche-cluster-posts.js";

// Three semantic axes: fitness, finance, comedy. Each dim is the count of
// matching keywords (case-insensitive substring), with a tiny constant so
// the zero-vector never reaches the normalizer.
const FIT = ["squat", "deadlift", "biceps", "abs", "glute", "workout", "protein", "fitness", "macros", "reps"];
const FIN = ["stocks", "portfolio", "etf", "dividend", "fund", "bonds", "yield", "finance", "invest", "interest"];
const COM = ["joke", "laugh", "skit", "improv", "sketch", "parody", "standup", "comedy", "punchline", "bit"];

const stubEmbed = async (texts) => texts.map((t) => {
  const lo = String(t).toLowerCase();
  let f = 0;
  let n = 0;
  let c = 0;
  for (const w of FIT) if (lo.includes(w)) f++;
  for (const w of FIN) if (lo.includes(w)) n++;
  for (const w of COM) if (lo.includes(w)) c++;
  return [f + 0.001, n + 0.001, c + 0.001];
});

const post = (over) => ({
  id: `p_${Math.random().toString(36).slice(2, 8)}`,
  author: "anon",
  desc: "",
  transcript: "",
  hashtags: [],
  ...over,
});

describe("clusterPostsByNiche", () => {
  it("strong-text posts cluster into the right semantic group", async () => {
    const posts = [
      post({ id: "f1", desc: "squat workout reps and macros for protein gains every week" }),
      post({ id: "f2", desc: "deadlift biceps abs glute training routine for fitness gains" }),
      post({ id: "f3", desc: "protein macros workout fitness reps every single day matters" }),
      post({ id: "n1", desc: "stocks portfolio etf dividend fund bonds yield interest invest" }),
      post({ id: "n2", desc: "invest portfolio yield bonds dividend fund stocks interest etf" }),
      post({ id: "n3", desc: "finance interest stocks invest fund bonds yield etf dividend" }),
    ];
    const { clusters, inherited, deferred } = await clusterPostsByNiche(posts, { embedFn: stubEmbed });
    expect(deferred).toEqual([]);
    expect(inherited).toEqual([]);
    expect(clusters.length).toBe(2);
    const groups = clusters.map((c) => [...c.memberIds].sort()).sort((a, b) => a[0].localeCompare(b[0]));
    expect(groups[0]).toEqual(["f1", "f2", "f3"]);
    expect(groups[1]).toEqual(["n1", "n2", "n3"]);
    for (const c of clusters) {
      expect(c.basis).toBe("text");
      expect(c.memberIds).toContain(c.representativeId);
      expect(c.vectors.length).toBe(c.memberIds.length);
    }
  });

  it("tag-only posts use the 'tags' basis", async () => {
    // Caption has too few words → text basis fails. Hashtags array supplies signal.
    const posts = [
      post({ id: "t1", desc: "yo", hashtags: ["fitness", "protein", "workout"] }),
      post({ id: "t2", desc: "hi", hashtags: ["macros", "reps", "fitness"] }),
      post({ id: "t3", desc: "💪", hashtags: ["squat", "deadlift", "abs"] }),
    ];
    const { clusters, deferred, inherited } = await clusterPostsByNiche(posts, { embedFn: stubEmbed });
    expect(deferred).toEqual([]);
    expect(inherited).toEqual([]);
    expect(clusters.length).toBe(1);
    expect(clusters[0].basis).toBe("tags");
    expect([...clusters[0].memberIds].sort()).toEqual(["t1", "t2", "t3"]);
  });

  it("inherits niche from author when text/tags signal is too weak", async () => {
    const labeledByAuthor = new Map([
      ["jane", [
        { id: "old1", author: "jane", niche: "fitness" },
        { id: "old2", author: "jane", niche: "fitness" },
        { id: "old3", author: "jane", niche: "fitness" },
        { id: "old4", author: "jane", niche: "finance" },
      ]],
    ]);
    const getAuthorPosts = async (author) => labeledByAuthor.get(author) || [];
    const sparse = post({ id: "sparse1", author: "jane", desc: "yo", hashtags: ["only"] });
    const { clusters, inherited, deferred } = await clusterPostsByNiche([sparse], {
      embedFn: stubEmbed, getAuthorPosts,
    });
    expect(clusters).toEqual([]);
    expect(deferred).toEqual([]);
    expect(inherited).toEqual([{ id: "sparse1", niche: "fitness", basis: "author" }]);
  });

  it("defers posts with no usable signal", async () => {
    const posts = [
      post({ id: "d1", author: "ghost", desc: "yo" }),
      post({ id: "d2", author: "nobody", desc: "", hashtags: ["only"] }),
    ];
    // No getAuthorPosts → author fallback unavailable.
    const { clusters, inherited, deferred } = await clusterPostsByNiche(posts, { embedFn: stubEmbed });
    expect(clusters).toEqual([]);
    expect(inherited).toEqual([]);
    expect([...deferred].sort()).toEqual(["d1", "d2"]);
  });

  it("bounds cluster count: 3 distinct semantic groups → 3 clusters", async () => {
    const mk = (prefix, words, n) => Array.from({ length: n }, (_, i) => post({
      id: `${prefix}${i}`,
      desc: `${words.join(" ")} routine ${words[i % words.length]} progress every week training`,
    }));
    const posts = [
      ...mk("f", FIT.slice(0, 6), 5),
      ...mk("n", FIN.slice(0, 6), 5),
      ...mk("c", COM.slice(0, 6), 5),
    ];
    const { clusters, deferred } = await clusterPostsByNiche(posts, { embedFn: stubEmbed });
    expect(deferred).toEqual([]);
    expect(clusters.length).toBe(3);
    expect(clusters.every((c) => c.memberIds.length === 5)).toBe(true);
    // Each cluster's members all share the same prefix (all-fit / all-fin / all-com).
    for (const c of clusters) {
      const prefixes = new Set(c.memberIds.map((id) => id[0]));
      expect(prefixes.size).toBe(1);
    }
  });

  it("represents each cluster with the post nearest the centroid", async () => {
    // Two clear members + one noisy outlier biased toward another axis.
    const posts = [
      post({ id: "core1", desc: "squat deadlift reps biceps abs glute workout training routine" }),
      post({ id: "core2", desc: "squat deadlift reps biceps abs glute workout training routine" }),
      post({ id: "edge",  desc: "squat deadlift reps biceps abs glute workout joke laugh standup" }),
    ];
    const { clusters } = await clusterPostsByNiche(posts, { embedFn: stubEmbed });
    expect(clusters.length).toBe(1);
    expect(["core1", "core2"]).toContain(clusters[0].representativeId);
  });
});

describe("clusterPostsByNiche internals", () => {
  it("agglomerative respects distance threshold", () => {
    const v = (...n) => __internals.normalize(new Float32Array(n));
    const vecs = [v(1, 0), v(0.99, 0.05), v(0, 1), v(0.05, 0.99)];
    const groups = __internals.agglomerative(vecs, 0.4);
    expect(groups.length).toBe(2);
    expect(groups.map((g) => g.length).sort()).toEqual([2, 2]);
  });

  it("majorityNiche picks the most-frequent label", () => {
    expect(__internals.majorityNiche(["a", "b", "a", "c", "a"])).toBe("a");
    expect(__internals.majorityNiche([])).toBe(null);
  });
});

describe("labelClusters", () => {
  // Build a fake clusters[] in the shape clusterPostsByNiche returns.
  const v = (...n) => __internals.normalize(new Float32Array(n));
  const mkCluster = (id, memberIds, vectors, basis = "text") => ({
    id,
    memberIds,
    representativeId: memberIds[0],
    basis,
    vectors,
  });

  it("calls chat exactly once per cluster, never per post", async () => {
    const clusters = [
      mkCluster(0, ["a1", "a2", "a3", "a4"], [v(1, 0, 0), v(0.95, 0.1, 0), v(0.9, 0.2, 0), v(0.6, 0.5, 0.1)]),
      mkCluster(1, ["b1", "b2", "b3"],       [v(0, 1, 0), v(0.1, 0.95, 0), v(0.05, 0.99, 0)]),
    ];
    const captions = {
      a1: "deadlift squat reps biceps protein workout fitness",
      a2: "squat reps macros workout fitness training",
      a3: "protein workout reps glutes routine fitness",
      a4: "random extra fitness",
      b1: "stocks portfolio etf yield invest",
      b2: "finance bonds dividend yield invest",
      b3: "interest fund stocks portfolio etf",
    };
    const getPost = async (id) => ({ id, desc: captions[id] || "" });

    const calls = [];
    const chat = async (req) => {
      calls.push(req);
      // Return label keyed by the postId so we can sanity-check.
      const map = { a1: "Fitness", b1: "Finance" };
      return { text: map[req.postId] || "Group" };
    };

    const labeled = await labelClusters(clusters, { chat, getPost });

    expect(calls.length).toBe(2); // ONE call per cluster
    expect(calls.every((c) => c.kind === "niche-label")).toBe(true);
    expect(calls.every((c) => c.schema && c.schema.type === "object" && c.schema.properties.label)).toBe(true);
    // Each prompt embeds 3 numbered exemplars and asks for JSON, not a bare string.
    for (const c of calls) {
      const content = c.messages[0].content;
      expect(content).toContain('{"label":"1-3 word niche"}');
      expect(content).toMatch(/1\./);
      expect(content).toMatch(/2\./);
      expect(content).toMatch(/3\./);
    }
    expect(labeled.length).toBe(2);
    expect(labeled[0].label).toBe("Fitness");
    expect(labeled[1].label).toBe("Finance");
    expect(labeled[0]).toHaveProperty("labeledAt");
    expect(typeof labeled[0].labeledAt).toBe("number");
  });

  it("cache hit skips the LLM call entirely", async () => {
    const clusters = [
      mkCluster(0, ["a1", "a2", "a3"], [v(1, 0, 0), v(0.9, 0.1, 0), v(0.8, 0.2, 0)]),
    ];
    const getPost = async (id) => ({ id, desc: "x" });

    let chatCalls = 0;
    const chat = async () => { chatCalls += 1; if (chatCalls > 1) throw new Error("chat called twice"); return { text: "Cached" }; };

    // Backing cache map shared across both runs.
    const store = new Map();
    const cache = { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); } };

    // First run: chat called once, cache populated.
    const first = await labelClusters(clusters, { chat, getPost, cache });
    expect(chatCalls).toBe(1);
    expect(first[0].label).toBe("Cached");
    expect(first[0].fromCache).toBe(false);

    // Second run: chat would throw on second call. Cache hit must short-circuit.
    const throwingChat = async () => { throw new Error("chat must not be called on cache hit"); };
    const second = await labelClusters(clusters, { chat: throwingChat, getPost, cache });
    expect(second[0].label).toBe("Cached");
    expect(second[0].fromCache).toBe(true);
  });

  it("empty clusters are skipped without errors and without LLM calls", async () => {
    const clusters = [
      { id: 0, memberIds: [], representativeId: null, basis: "text", vectors: [] },
      null,
      undefined,
      { id: 1, memberIds: ["x1"], representativeId: "x1", basis: "text", vectors: [v(1, 0, 0)] },
    ];
    const getPost = async (id) => ({ id, desc: "hello world" });
    let calls = 0;
    const chat = async () => { calls += 1; return { text: "Solo" }; };

    const out = await labelClusters(clusters, { chat, getPost });
    expect(calls).toBe(1); // only the non-empty cluster triggers a call
    expect(out.length).toBe(4);
    expect(out[0]).toEqual({ id: 0, memberIds: [], representativeId: null, basis: "text", vectors: [] });
    expect(out[1]).toBe(null);
    expect(out[2]).toBe(undefined);
    expect(out[3].label).toBe("Solo");
  });

  it("writes label back to every member post via setPostNiche", async () => {
    const clusters = [
      mkCluster(0, ["a1", "a2", "a3"], [v(1, 0, 0), v(0.9, 0.1, 0), v(0.8, 0.2, 0)], "tags"),
    ];
    const getPost = async (id) => ({ id, desc: "x" });
    const chat = async () => ({ text: "Cooking" });
    const writes = [];
    const setPostNiche = async (id, label, basis) => { writes.push({ id, label, basis }); };
    await labelClusters(clusters, { chat, getPost, setPostNiche });
    expect(writes).toEqual([
      { id: "a1", label: "Cooking", basis: "tags" },
      { id: "a2", label: "Cooking", basis: "tags" },
      { id: "a3", label: "Cooking", basis: "tags" },
    ]);
  });

  it("includes transcripts and format hints in the cluster label prompt", async () => {
    const clusters = [
      mkCluster(0, ["m1", "m2", "m3"], [v(1, 0, 0), v(0.9, 0.1, 0), v(0.8, 0.2, 0)]),
    ];
    const getPost = async (id) => ({
      id,
      desc: "short caption",
      transcript: "Discipline and mindset are what keep you showing up when motivation fades.",
      visualFormat: "talking-head",
      hashtags: ["motivation", "mindset"],
    });
    const calls = [];
    const chat = async (req) => { calls.push(req); return { json: { label: "Motivational" } }; };
    const out = await labelClusters(clusters, { chat, getPost });
    expect(out[0].label).toBe("Motivational");
    expect(calls[0].messages[0].content).toContain("TRANSCRIPT:");
    expect(calls[0].messages[0].content).toContain("FORMAT: talking-head");
    expect(calls[0].messages[0].content).toContain("#motivation #mindset");
  });

  it("retries as plain text when structured-output parsing fails", async () => {
    const clusters = [
      mkCluster(0, ["a1", "a2", "a3"], [v(1, 0, 0), v(0.9, 0.1, 0), v(0.8, 0.2, 0)]),
    ];
    const getPost = async (id) => ({ id, desc: "protein workout reps fitness training" });
    const calls = [];
    const chat = async (req) => {
      calls.push(req);
      if (req.schema) throw new Error("llm.chat: structured-output JSON parse failed");
      return { text: "Fitness" };
    };
    const out = await labelClusters(clusters, { chat, getPost });
    expect(out[0].label).toBe("Fitness");
    expect(calls).toHaveLength(2);
    expect(calls[0].schema.type).toBe("object");
    expect(calls[1].schema).toBeUndefined();
  });

  it("falls back to deterministic transcript keyword labels when LLM labeling fails", async () => {
    const clusters = [
      mkCluster(0, ["m1", "m2", "m3"], [v(1, 0, 0), v(0.9, 0.1, 0), v(0.8, 0.2, 0)]),
    ];
    const getPost = async (id) => ({
      id,
      desc: "",
      transcriptSegments: [{ text: "Build discipline, confidence, and better habits for success." }],
      hashtags: ["fyp"],
    });
    const chat = async () => { throw new Error("ollama unavailable"); };
    const out = await labelClusters(clusters, { chat, getPost });
    expect(out[0].label).toBe("Motivational");
  });
});
