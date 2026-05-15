#!/usr/bin/env node
// Smoke test for the bio-first niche cascade (src/lib/niche-signal.js +
// src/lib/profile-parser.js). Drives the exact code paths that the
// background.js service worker runs at cluster time — same IIFE runtime
// modules, same `log()` shape — against fixtures that mirror the user's
// stated problem case: a sales-space, talking-head creator whose captions
// sound generic but whose bio names the vertical directly.
//
// Run with:  node scripts/smoke-niche-cascade.mjs
// Output is structured JSON log lines so you can grep / pipe through jq.

import { pickNicheSignal } from "../src/lib/niche-signal.js";
import { parseInstagramProfile, profileToNicheText, nicheTextWordCount } from "../src/lib/profile-parser.js";

// Mirrors background.js log(): "[fs-bg] event {json}".
const log = (event, data = {}) => {
  try {
    console.log("[fs-bg]", event, JSON.stringify(data));
  } catch {
    console.log("[fs-bg]", event);
  }
};

// ---------- fixtures ----------
//
// Three creators, each shaped like a real CREATOR_STORE row after a profile
// fetch flows through `parseInstagramProfile` + `addCreator`:
//   1. sarah.realtor   — talking-head SALES (the user's case). Bio names
//                        the vertical. Captions sound generic.
//   2. fitcoach        — bio + captions both clearly fitness. Should bio.
//   3. random.creator  — no bio captured yet. Should fall through to
//                        captions (and pick "comedy" terms).
//   4. silent.creator  — no bio, no captions, two tags. Tags fallback.
//   5. ghost           — nothing. None.

const creators = [
  parseInstagramProfile({
    data: {
      user: {
        username: "Sarah.Realtor",
        full_name: "Sarah Chen | SF Bay Area Real Estate",
        biography: "Helping families find their dream home in San Francisco & Peninsula ⭐ DRE# 02105432",
        category_name: "Real Estate Agent",
        external_url: "https://www.sarahchenhomes.com/",
        edge_followed_by: { count: 12400 },
        is_business_account: true,
      },
    },
  }),
  parseInstagramProfile({
    data: {
      user: {
        username: "fitcoach",
        full_name: "Mike — Strength Coach",
        biography: "Online strength coaching for busy guys 💪",
        category_name: "Fitness Trainer",
        external_url: "https://strongermike.fit/start",
      },
    },
  }),
  // No bio captured yet — emulates a freshly auto-added creator from
  // clusterNiches autoAdded path (before the IG profile-info response arrived).
  { username: "random.creator", niche: "", nichePinned: false, bio: "", category: "", fullName: "", externalUrl: "", bioCapturedAt: 0 },
  { username: "silent.creator", niche: "", nichePinned: false, bio: "", category: "", fullName: "", externalUrl: "", bioCapturedAt: 0 },
  { username: "ghost", niche: "", nichePinned: false, bio: "", category: "", fullName: "", externalUrl: "", bioCapturedAt: 0 },
];

// ---------- posts (byAuthor map) ----------
const posts = [
  // sarah.realtor — talking-head sales captions. Generic-sounding.
  { id: "ig_s1", author: "sarah.realtor", desc: "hey guys, today I want to talk about something really important — listen up", likes: 18000 },
  { id: "ig_s2", author: "sarah.realtor", desc: "the one thing that nobody tells you about getting what you want in life", likes: 22000 },
  { id: "ig_s3", author: "sarah.realtor", desc: "swipe to see why this matters more than you think 👀", likes: 9500 },

  // fitcoach — clearly fitness-themed.
  { id: "ig_f1", author: "fitcoach", desc: "hit 405 squat for 3 reps this morning, macros locked in #protein", likes: 40000 },
  { id: "ig_f2", author: "fitcoach", desc: "deadlift PR cooked me — recovery is everything #fitness #strength", likes: 35000 },
  { id: "ig_f3", author: "fitcoach", desc: "biceps and abs day, hypertrophy plan in bio", likes: 15000 },

  // random.creator — comedy-ish, no bio.
  { id: "ig_r1", author: "random.creator", desc: "POV: you forgot it was Monday — comedy gold storytime", likes: 5000 },
  { id: "ig_r2", author: "random.creator", desc: "this skit was supposed to be a joke but everyone thought it was real", likes: 12000 },
  { id: "ig_r3", author: "random.creator", desc: "improv with my brother got way too real way too fast", likes: 7000 },

  // silent.creator — only hashtags via the post.hashtags field (no desc).
  { id: "ig_q1", author: "silent.creator", desc: "", hashtags: ["fashion", "ootd"], likes: 1000 },
  { id: "ig_q2", author: "silent.creator", desc: "", hashtags: ["thrifted"], likes: 2000 },

  // ghost — empty everything.
  { id: "ig_g1", author: "ghost", desc: "", likes: 100 },
];

const byAuthor = new Map();
for (const p of posts) {
  if (!byAuthor.has(p.author)) byAuthor.set(p.author, []);
  byAuthor.get(p.author).push(p);
}

// ---------- run cascade, emit logs ----------
log("smoke.start", { creators: creators.length, posts: posts.length });

const breakdown = { bio: 0, captions: 0, tags: 0, none: 0 };
const decisions = [];
for (const c of creators) {
  const u = String(c.username || "").toLowerCase();
  const cPosts = byAuthor.get(u) || [];
  const sig = pickNicheSignal(c, cPosts);
  breakdown[sig.source] = (breakdown[sig.source] || 0) + 1;
  const top3 = (sig.text.toLowerCase().match(/[a-z]{4,}/g) || []).slice(0, 3);

  // Same shape the SW emits (background.js clusterNiches "cluster.signal").
  log("cluster.signal", {
    username: u,
    source: sig.source,
    wordCount: sig.wordCount,
    bioWords: sig.debug.bioWords,
    captionPosts: sig.debug.captionPosts,
    captionWords: sig.debug.captionWords,
    tagCount: sig.debug.tagCount,
    pinned: sig.debug.pinned,
    pinnedLabel: sig.debug.pinnedLabel,
    top3: top3.join(","),
  });

  decisions.push({ username: u, source: sig.source, text: sig.text.slice(0, 80) });
}
log("cluster.signal.summary", breakdown);

// ---------- assertions ----------
const assert = (cond, msg) => {
  if (!cond) {
    console.error("\n[fs-bg] smoke.assert.FAIL", msg);
    process.exit(1);
  }
};

const bySrc = (u) => decisions.find((d) => d.username === u).source;

// The user's case: talking-head SALES creator gets 'bio', not 'captions'.
assert(bySrc("sarah.realtor") === "bio",
  `sarah.realtor expected source=bio, got ${bySrc("sarah.realtor")}`);
// Fitness coach also gets bio (specific bio dominates fitness captions).
assert(bySrc("fitcoach") === "bio",
  `fitcoach expected source=bio, got ${bySrc("fitcoach")}`);
// No bio + meaty captions → captions.
assert(bySrc("random.creator") === "captions",
  `random.creator expected source=captions, got ${bySrc("random.creator")}`);
// No bio + empty captions + hashtags → tags.
assert(bySrc("silent.creator") === "tags",
  `silent.creator expected source=tags, got ${bySrc("silent.creator")}`);
// Nothing usable → none.
assert(bySrc("ghost") === "none",
  `ghost expected source=none, got ${bySrc("ghost")}`);

log("smoke.done", { ok: true, breakdown, decisions });
console.log("\n\u2713 cascade behaves as designed for all 5 fixture creators");
