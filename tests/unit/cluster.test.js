// Cluster pipeline tests \u2014 verifies the algorithm on synthetic embeddings.
// We don't load MiniLM here; instead we feed pre-built unit-vectors that
// emulate three semantic clusters (fitness / finance / comedy).
import { describe, it, expect, beforeAll } from "vitest";

let C;
beforeAll(async () => {
  // The lib uses btoa/atob \u2014 vitest's jsdom env (default for our suite via
  // environment auto-detect) supplies them; node 20 also has them globally.
  await import("../../src/lib/cluster.js");
  C = globalThis.__fsCluster;
});

const unit = (...nums) => {
  const f = new Float32Array(nums);
  return C.normalize(f);
};

describe("cluster.js", () => {
  it("agglomerative clustering separates 3 obvious groups", () => {
    // 3 axes \u2192 3 separable directions in R^3.
    const FIT = unit(1, 0, 0);
    const FIN = unit(0, 1, 0);
    const COM = unit(0, 0, 1);
    // Add small noise to each member so they're not literally identical.
    const noisy = (base, eps) => {
      const v = new Float32Array(base);
      for (let i = 0; i < v.length; i++) v[i] += eps * (Math.random() - 0.5);
      return C.normalize(v);
    };
    const vecs = [];
    for (let i = 0; i < 5; i++) vecs.push(noisy(FIT, 0.1));
    for (let i = 0; i < 5; i++) vecs.push(noisy(FIN, 0.1));
    for (let i = 0; i < 5; i++) vecs.push(noisy(COM, 0.1));
    const groups = C.cluster(vecs, 0.65);
    expect(groups.length).toBe(3);
    const sizes = groups.map((g) => g.length).sort();
    expect(sizes).toEqual([5, 5, 5]);
  });

  it("tf-idf labelling picks distinguishing terms per cluster", () => {
    const fit = ["squat workout reps", "deadlift macros protein", "biceps abs glute"];
    const fin = ["stocks portfolio dividend", "etf hedge index fund", "bonds yield interest"];
    const com = ["punchline joke laugh", "skit improv standup", "sketch parody bit"];
    const labels = C.labelClusters([fit, fin, com], 2);
    expect(labels.length).toBe(3);
    // Labels should differ.
    expect(new Set(labels).size).toBe(3);
    // Each label should contain at least one in-domain token.
    expect(labels[0]).toMatch(/squat|deadlift|biceps|reps|protein|workout|macros|abs|glute/);
    expect(labels[1]).toMatch(/stocks|portfolio|dividend|etf|fund|bonds|yield/);
    expect(labels[2]).toMatch(/joke|laugh|skit|improv|sketch|parody/);
  });

  it("end-to-end clusterCreators groups creators by their captions", async () => {
    // Fake embedFn: hash each text to 3-D direction based on top keyword.
    const FIT = ["squat", "deadlift", "biceps", "abs", "glute", "workout", "protein"];
    const FIN = ["stocks", "portfolio", "etf", "dividend", "fund", "bonds", "yield"];
    const COM = ["joke", "laugh", "skit", "improv", "sketch", "parody"];
    const fakeEmbed = async (texts) => texts.map((t) => {
      const lo = t.toLowerCase();
      let f = 0, n = 0, c = 0;
      for (const w of FIT) if (lo.includes(w)) f++;
      for (const w of FIN) if (lo.includes(w)) n++;
      for (const w of COM) if (lo.includes(w)) c++;
      // Add tiny noise to avoid all-zero pre-norm.
      const v = new Float32Array([f + 0.001, n + 0.001, c + 0.001]);
      return Array.from(C.normalize(v));
    });
    const creators = [
      { username: "fit1" }, { username: "fit2" }, { username: "fit3" }, { username: "fit4" }, { username: "fit5" },
      { username: "fin1" }, { username: "fin2" }, { username: "fin3" }, { username: "fin4" }, { username: "fin5" },
      { username: "com1" }, { username: "com2" }, { username: "com3" }, { username: "com4" }, { username: "com5" },
    ];
    const postsByAuthor = new Map();
    const seed = (user, words) => {
      const posts = words.map((w, i) => ({
        id: `${user}-${i}`, author: user, likes: 1000 + i,
        desc: `${w} routine ${w} tips and ${w} progress for the week`,
      }));
      postsByAuthor.set(user, posts);
    };
    ["fit1","fit2","fit3","fit4","fit5"].forEach((u, i) => seed(u, FIT.slice(i, i + 4)));
    ["fin1","fin2","fin3","fin4","fin5"].forEach((u, i) => seed(u, FIN.slice(i, i + 4)));
    ["com1","com2","com3","com4","com5"].forEach((u, i) => seed(u, COM.slice(i, i + 4)));
    const creatorVecs = await C.buildCreatorVectors(creators, postsByAuthor, fakeEmbed, 20);
    expect(creatorVecs.length).toBe(15);
    const groups = C.clusterCreators(creatorVecs, 0.65);
    // Three sensible groups (no "unlabeled" overflow since all creators have captions).
    expect(groups.length).toBe(3);
    expect(groups.every((g) => g.members.length === 5)).toBe(true);
    // Each group's members should share a prefix.
    for (const g of groups) {
      const prefix = g.members[0].slice(0, 3);
      expect(g.members.every((m) => m.startsWith(prefix))).toBe(true);
    }
  });

  it("base64 round-trips a Float32Array", () => {
    const v = new Float32Array([0.1, -0.5, 0.333, 1.2345, -0.987]);
    const b = C.f32ToB64(v);
    const back = C.b64ToF32(b);
    expect(back.length).toBe(v.length);
    for (let i = 0; i < v.length; i++) expect(back[i]).toBeCloseTo(v[i], 5);
  });
});
