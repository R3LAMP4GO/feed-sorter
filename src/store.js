// Persistent post store backed by IndexedDB via the `idb` package
// (vendored at src/lib/idb-umd.js, exposed as `globalThis.idb`).
//
// Schema:
//   db: "feed-sorter"
//   store: "posts" (keyPath: "id")
//     indexes: by_author, by_createTime, by_surface, by_score
//
// Public API on window.__fsStore:
//   ready()                      → Promise<void>  (resolves once the DB is open)
//   upsert(post)                 → Promise<Post>  (write-through; merges with prior row)
//   bulkUpsert(posts)            → Promise<Post[]>
//   getAll()                     → Promise<Post[]>
//   getByAuthor(username)        → Promise<Post[]>
//   getRecent(sinceMs)           → Promise<Post[]>     by lastSeenAt >= sinceMs
//   getByScope(scope)            → Promise<Post[]>     scope = {kind, username}
//   clearAll()                   → Promise<void>
//
// Merge semantics mirror the in-memory ingest() merge: max() on counters,
// prefer non-empty strings, preserve cover, refresh lastSeenAt, keep firstSeenAt.

(() => {
  if (window.__fsStore) return;

  const DB_NAME = "feed-sorter";
  const DB_VERSION = 11;
  const STORE = "posts";
  const META_STORE = "meta";
  const CREATOR_STORE = "creators";
  const AUDIO_STORE = "audio";
  const SIGNAL_STORE = "signals";
  const VOICE_STORE = "voice";
  const REWRITE_STORE = "rewrites";
  const PIPELINE_STORE = "pipeline_steps";

  /** @type {Promise<import("idb").IDBPDatabase> | null} */
  let dbPromise = null;

  const openDb = () => {
    if (dbPromise) return dbPromise;
    if (!globalThis.idb || typeof globalThis.idb.openDB !== "function") {
      dbPromise = Promise.reject(new Error("idb UMD not loaded"));
      return dbPromise;
    }
    dbPromise = globalThis.idb.openDB(DB_NAME, DB_VERSION, {
      async upgrade(db, oldVersion, _newVersion, transaction) {
        if (oldVersion < 1) {
          const os = db.createObjectStore(STORE, { keyPath: "id" });
          os.createIndex("by_author", "author");
          os.createIndex("by_createTime", "createTime");
          os.createIndex("by_surface", "surface");
          os.createIndex("by_score", "_score");
          os.createIndex("by_lastSeenAt", "lastSeenAt");
        }
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains(META_STORE)) {
            const m = db.createObjectStore(META_STORE, { keyPath: "id" });
            // Booleans are valid IDB keys; index lets us cheaply pull pinned rows.
            m.createIndex("by_pinned", "pinned");
            m.createIndex("by_status", "status");
            m.createIndex("by_updatedAt", "updatedAt");
          }
        }
        if (oldVersion < 3) {
          if (!db.objectStoreNames.contains(CREATOR_STORE)) {
            const c = db.createObjectStore(CREATOR_STORE, { keyPath: "username" });
            c.createIndex("by_niche", "niche");
            c.createIndex("by_lastScrapedAt", "lastScrapedAt");
            c.createIndex("by_autoCollect", "autoCollect");
          }
        }
        if (oldVersion < 4) {
          if (!db.objectStoreNames.contains(AUDIO_STORE)) {
            const a = db.createObjectStore(AUDIO_STORE, { keyPath: "id" });
            a.createIndex("by_useCount", "useCount");
            a.createIndex("by_lastSeenAt", "lastSeenAt");
            a.createIndex("by_isOriginal", "isOriginal");
          }
        }
        if (oldVersion < 5) {
          if (!db.objectStoreNames.contains(SIGNAL_STORE)) {
            const s = db.createObjectStore(SIGNAL_STORE, { keyPath: "id" });
            s.createIndex("by_createdAt", "createdAt");
            s.createIndex("by_read", "read");
            s.createIndex("by_newAuthor", "newAuthor");
            s.createIndex("by_histAuthor", "histAuthor");
          }
        }
        if (oldVersion < 6) {
          if (!db.objectStoreNames.contains(VOICE_STORE)) {
            const v = db.createObjectStore(VOICE_STORE, { keyPath: "username" });
            v.createIndex("by_generatedAt", "generatedAt");
          }
        }
        if (oldVersion < 7) {
          // Per-post per-platform repurposed rewrites. Compound key
          // `${postId}::${platform}` so we can read either by postId
          // (index) or by exact (postId, platform) pair (key lookup).
          if (!db.objectStoreNames.contains(REWRITE_STORE)) {
            const r = db.createObjectStore(REWRITE_STORE, { keyPath: "key" });
            r.createIndex("by_postId", "postId");
            r.createIndex("by_platform", "platform");
            r.createIndex("by_generatedAt", "generatedAt");
          }
        }
        if (oldVersion < 8) {
          // Pipeline-step sentinels for resume support. Compound key
          // `${postId}::${step}` (step ∈ download|transcribe|diagnose|rewrite|readme).
          // Presence = step completed; payload carries `at` timestamp.
          if (!db.objectStoreNames.contains(PIPELINE_STORE)) {
            const ps = db.createObjectStore(PIPELINE_STORE, { keyPath: "key" });
            ps.createIndex("by_postId", "postId");
            ps.createIndex("by_step", "step");
            ps.createIndex("by_at", "at");
          }
        }
        if (oldVersion < 9 && db.objectStoreNames.contains(STORE)) {
          // Multi-platform: every post id is now namespaced as
          // `<platform>_<nativeId>` so IG `pk=4001` and TikTok `id=4001`
          // can coexist. Walk legacy `posts` rows and prefix bare ids
          // with `ig_`. Idempotent — rows already prefixed (ig_/tt_/etc)
          // are left alone. Stamps `meta:migrationVersion=9` as a sentinel.
          const os = transaction.objectStore(STORE);
          let cursor = await os.openCursor();
          let migrated = 0;
          while (cursor) {
            const row = cursor.value;
            if (row && row.id && !/^[a-z]{2,4}_/.test(String(row.id))) {
              const newId = `ig_${row.id}`;
              const next = { ...row, id: newId, platform: row.platform || "instagram" };
              await os.delete(cursor.key);
              await os.put(next);
              migrated++;
            }
            cursor = await cursor.continue();
          }
          if (db.objectStoreNames.contains(META_STORE)) {
            const m = transaction.objectStore(META_STORE);
            await m.put({ id: "migrationVersion", value: 9, migrated, at: Date.now() });
          }
          try {
            console.log(
              "%c[FS:store]%c v8→v9 migration complete, prefixed=%d (legacy bare ids → ig_*)",
              "color:#e1306c;font-weight:bold", "color:inherit",
              migrated
            );
          } catch {}
        }
        if (oldVersion < 10 && db.objectStoreNames.contains(STORE)) {
          // Add three optional classification fields to every existing post:
          //   niche       — cluster label (string | null)
          //   nicheBasis  — "text" | "tags" | "author" | "visual" | null
          //   format      — one of FORMATS from src/analysis/post-analysis.js | null
          // No-op: just stamps null on rows that don't already carry the field
          // so the schema is uniform; new posts pick them up via setters.
          const os = transaction.objectStore(STORE);
          let cursor = await os.openCursor();
          let touched = 0;
          while (cursor) {
            const row = cursor.value;
            if (row && (row.niche === undefined || row.nicheBasis === undefined || row.format === undefined)) {
              const next = {
                ...row,
                niche: row.niche === undefined ? null : row.niche,
                nicheBasis: row.nicheBasis === undefined ? null : row.nicheBasis,
                format: row.format === undefined ? null : row.format,
              };
              await os.put(next);
              touched++;
            }
            cursor = await cursor.continue();
          }
          if (db.objectStoreNames.contains(META_STORE)) {
            const m = transaction.objectStore(META_STORE);
            await m.put({ id: "migrationVersion", value: 10, touched, at: Date.now() });
          }
        }
        if (oldVersion < 11) {
          // Two additions:
          //   creators rows: bio/category/fullName/externalUrl/bioCapturedAt
          //     (powers the bio-first niche cascade in clusterNiches — see
          //     src/lib/niche-signal.js).
          //   posts rows: visualFormat (derived from cover_ai by
          //     src/lib/visual-format.js — talking-head / info-card / etc.).
          // Both default to empty/null on existing rows; new writes set them
          // via setters (addCreator patch + setPostCoverAi side-effect).
          if (db.objectStoreNames.contains(CREATOR_STORE)) {
            const cs = transaction.objectStore(CREATOR_STORE);
            let cursor = await cs.openCursor();
            let touchedC = 0;
            while (cursor) {
              const row = cursor.value;
              if (row && (
                row.bio === undefined || row.category === undefined ||
                row.fullName === undefined || row.externalUrl === undefined ||
                row.bioCapturedAt === undefined
              )) {
                await cs.put({
                  ...row,
                  bio: row.bio === undefined ? "" : row.bio,
                  category: row.category === undefined ? "" : row.category,
                  fullName: row.fullName === undefined ? "" : row.fullName,
                  externalUrl: row.externalUrl === undefined ? "" : row.externalUrl,
                  bioCapturedAt: row.bioCapturedAt === undefined ? 0 : row.bioCapturedAt,
                });
                touchedC++;
              }
              cursor = await cursor.continue();
            }
            if (db.objectStoreNames.contains(META_STORE)) {
              const m = transaction.objectStore(META_STORE);
              await m.put({ id: "migrationVersion", value: 11, touchedCreators: touchedC, at: Date.now() });
            }
          }
          if (db.objectStoreNames.contains(STORE)) {
            // Posts: stamp visualFormat. If a row already has cover_ai we
            // try to derive a name from it (best-effort — the runtime mirror
            // might not be loaded yet at IDB-open time, in which case we
            // leave it null and the next setPostCoverAi write fills it).
            const ps = transaction.objectStore(STORE);
            const deriveFn = (typeof globalThis !== "undefined" &&
              globalThis.__fsVisualFormat &&
              typeof globalThis.__fsVisualFormat.deriveVisualFormat === "function")
              ? globalThis.__fsVisualFormat.deriveVisualFormat
              : null;
            let cursor = await ps.openCursor();
            let touchedP = 0;
            while (cursor) {
              const row = cursor.value;
              if (row && row.visualFormat === undefined) {
                const vf = (deriveFn && row.cover_ai) ? deriveFn(row.cover_ai) : null;
                await ps.put({ ...row, visualFormat: vf });
                touchedP++;
              }
              cursor = await cursor.continue();
            }
            if (db.objectStoreNames.contains(META_STORE)) {
              const m = transaction.objectStore(META_STORE);
              await m.put({ id: "migrationVersion-v11-posts", value: 11, touchedPosts: touchedP, at: Date.now() });
            }
          }
        }
      },
    });
    return dbPromise;
  };

  // Snapshots: rolling time-series of (views, likes, comments) so we can
  // compute velocity / accelerating on read. Capped to MAX_SNAPSHOTS.
  const MAX_SNAPSHOTS = 30;
  const snapshotsEqual = (s, views, likes, comments) =>
    s && s.views === views && s.likes === likes && s.comments === comments;

  // Same merge rules as content.js ingest(); kept here so we can do an
  // async-safe read-modify-write inside a single IDB transaction.
  const authorMergeScore = (value) => {
    const a = String(value || "").trim();
    if (!a) return 0;
    let score = 1;
    if (/^[A-Za-z0-9._-]+$/.test(a) && !/\s/.test(a)) score += 1;
    if (/[_.-]/.test(a)) score += 1;
    return score;
  };

  const pickAuthor = (prevAuthor, nextAuthor) =>
    authorMergeScore(nextAuthor) >= authorMergeScore(prevAuthor) ? (nextAuthor || prevAuthor || "") : (prevAuthor || nextAuthor || "");

  const mergePosts = (prev, next, now) => {
    const mergedViews = Math.max(prev?.views || 0, next.views || 0);
    const mergedLikes = Math.max(prev?.likes || 0, next.likes || 0);
    const mergedComments = Math.max(prev?.comments || 0, next.comments || 0);
    let snapshots = Array.isArray(prev?.snapshots) ? prev.snapshots.slice() : [];
    if (!prev) {
      // Seed initial snapshot so velocity has a baseline.
      snapshots = [{ capturedAt: now, views: mergedViews, likes: mergedLikes, comments: mergedComments }];
    } else {
      const last = snapshots[snapshots.length - 1];
      if (!snapshotsEqual(last, mergedViews, mergedLikes, mergedComments)) {
        snapshots.push({ capturedAt: now, views: mergedViews, likes: mergedLikes, comments: mergedComments });
      }
    }
    if (snapshots.length > MAX_SNAPSHOTS) {
      snapshots = snapshots.slice(snapshots.length - MAX_SNAPSHOTS);
    }
    if (!prev) {
      return {
        ...next,
        snapshots,
        firstSeenAt: now,
        lastSeenAt: now,
      };
    }
    return {
      ...prev,
      ...next,
      likes: mergedLikes,
      comments: mergedComments,
      views: mergedViews,
      desc: next.desc || prev.desc,
      cover: prev.cover || next.cover,
      author: pickAuthor(prev.author, next.author),
      videoUrl: next.videoUrl || prev.videoUrl,
      // Preserve transcript across re-ingests (ingest never carries it).
      transcript: next.transcript || prev.transcript || "",
      transcriptSegments: (next.transcriptSegments && next.transcriptSegments.length)
        ? next.transcriptSegments
        : (prev.transcriptSegments || null),
      transcriptLang: next.transcriptLang || prev.transcriptLang || "",
      transcriptAt: next.transcriptAt || prev.transcriptAt || 0,
      transcriptModel: next.transcriptModel || prev.transcriptModel || "",
      // AI analysis (hook/topic) — preserve across re-ingests; analyzePost
      // is the only writer (via setPostAi).
      ai: next.ai || prev.ai || null,
      diagnosis: next.diagnosis || prev.diagnosis || null,
      cover_ai: next.cover_ai || prev.cover_ai || null,
      snapshots,
      firstSeenAt: prev.firstSeenAt || now,
      lastSeenAt: now,
    };
  };

  const upsert = async (post) => {
    if (!post || !post.id) return null;
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const prev = await store.get(post.id);
    const merged = mergePosts(prev, post, Date.now());
    await store.put(merged);
    await tx.done;
    return merged;
  };

  const bulkUpsert = async (posts) => {
    if (!Array.isArray(posts) || !posts.length) return [];
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const now = Date.now();
    const out = [];
    for (const p of posts) {
      if (!p || !p.id) continue;
      const prev = await store.get(p.id);
      const merged = mergePosts(prev, p, now);
      await store.put(merged);
      out.push(merged);
    }
    await tx.done;
    return out;
  };

  const getAll = async () => {
    const db = await openDb();
    return db.getAll(STORE);
  };

  const getByAuthor = async (username) => {
    if (!username) return [];
    const db = await openDb();
    return db.getAllFromIndex(STORE, "by_author", username.toLowerCase());
  };

  const getRecent = async (sinceMs) => {
    const db = await openDb();
    const range = IDBKeyRange.lowerBound(sinceMs);
    return db.getAllFromIndex(STORE, "by_lastSeenAt", range);
  };

  const getByScope = async (scope) => {
    if (!scope) return [];
    if (scope.kind === "profile" && scope.username) {
      return getByAuthor(scope.username);
    }
    if (scope.kind === "explore" || scope.kind === "shorts-feed" || scope.kind === "search") {
      // Multi-author discovery surfaces: show items seen in this session window
      // (last 24h is a reasonable "recent" cutoff for rehydrate-on-revisit).
      return getRecent(Date.now() - 24 * 60 * 60 * 1000);
    }
    return [];
  };

  const clearAll = async () => {
    const db = await openDb();
    await db.clear(STORE);
  };

  // Patch a post row in place with an LLM analysis result. Returns the
  // merged row, or null if the post id isn't in IDB.
  const setPostAi = async (id, ai) => {
    if (!id || !ai) return null;
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const os = tx.objectStore(STORE);
    const prev = await os.get(String(id));
    if (!prev) { await tx.done; return null; }
    const merged = { ...prev, ai: { ...(prev.ai || {}), ...ai } };
    await os.put(merged);
    await tx.done;
    return merged;
  };

  // Patch a post row in place with a cover-image classification result
  // (multimodal LLM via src/analysis/cover-analysis.js). Also derives the
  // user-facing visualFormat rollup (talking-head / info-card / b-roll / ...)
  // via src/lib/visual-format-runtime.js when that runtime is loaded.
  // Falling back to the previous visualFormat keeps consecutive writes
  // idempotent even if the runtime hasn't attached yet (rare edge in SW).
  const setPostCoverAi = async (id, coverAi) => {
    if (!id || !coverAi) return null;
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const os = tx.objectStore(STORE);
    const prev = await os.get(String(id));
    if (!prev) { await tx.done; return null; }
    const next = { ...coverAi };
    const deriveFn = (typeof globalThis !== "undefined" &&
      globalThis.__fsVisualFormat &&
      typeof globalThis.__fsVisualFormat.deriveVisualFormat === "function")
      ? globalThis.__fsVisualFormat.deriveVisualFormat
      : null;
    const visualFormat = deriveFn ? deriveFn(next) : (prev.visualFormat ?? null);
    const merged = { ...prev, cover_ai: next, visualFormat };
    await os.put(merged);
    await tx.done;
    return merged;
  };

  // Patch a post row in place with an outlier diagnosis (multimodal LLM).
  const setPostDiagnosis = async (id, diagnosis) => {
    if (!id || !diagnosis) return null;
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const os = tx.objectStore(STORE);
    const prev = await os.get(String(id));
    if (!prev) { await tx.done; return null; }
    const merged = { ...prev, diagnosis: { ...diagnosis } };
    await os.put(merged);
    await tx.done;
    return merged;
  };

  // Patch a post row in place with a transcription result. Returns the
  // merged row, or null if the post id isn't in IDB.
  const setPostTranscript = async (id, payload) => {
    if (!id || !payload) return null;
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const os = tx.objectStore(STORE);
    const prev = await os.get(String(id));
    if (!prev) { await tx.done; return null; }
    const segs = Array.isArray(payload.segments) ? payload.segments : null;
    const merged = {
      ...prev,
      transcript: String(payload.text || ""),
      transcriptSegments: segs,
      transcriptLang: String(payload.language || ""),
      transcriptModel: String(payload.model || ""),
      transcriptSource: typeof payload.source === "string" && payload.source ? payload.source : "whisper",
      transcriptAt: Date.now(),
    };
    await os.put(merged);
    await tx.done;
    return merged;
  };

  // Patch a post row with niche cluster label + basis. nicheBasis must be
  // one of "text" | "tags" | "author" | "visual" | null.
  const NICHE_BASES = new Set(["text", "tags", "author", "visual"]);
  const setPostNiche = async (id, niche, basis) => {
    if (!id) return null;
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const os = tx.objectStore(STORE);
    const prev = await os.get(String(id));
    if (!prev) { await tx.done; return null; }
    const nicheVal = (typeof niche === "string" && niche) ? niche : null;
    const basisVal = (typeof basis === "string" && NICHE_BASES.has(basis)) ? basis : null;
    const merged = { ...prev, niche: nicheVal, nicheBasis: basisVal };
    await os.put(merged);
    await tx.done;
    return merged;
  };

  // Patch a post row in place with a visualFormat label directly (when
  // caller already knows the bucket — e.g. importing or backfilling without
  // re-running cover-analysis). Pass null to clear.
  const VISUAL_FORMATS_ALLOWED = new Set([
    "talking-head", "info-card", "split-screen", "product", "b-roll", "other",
  ]);
  const setPostVisualFormat = async (id, visualFormat) => {
    if (!id) return null;
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const os = tx.objectStore(STORE);
    const prev = await os.get(String(id));
    if (!prev) { await tx.done; return null; }
    const vfVal = (typeof visualFormat === "string" && VISUAL_FORMATS_ALLOWED.has(visualFormat))
      ? visualFormat : null;
    const merged = { ...prev, visualFormat: vfVal };
    await os.put(merged);
    await tx.done;
    return merged;
  };

  // Patch a post row with a format label (one of FORMATS from
  // src/analysis/post-analysis.js, or null to clear).
  const setPostFormat = async (id, format) => {
    if (!id) return null;
    const db = await openDb();
    const tx = db.transaction(STORE, "readwrite");
    const os = tx.objectStore(STORE);
    const prev = await os.get(String(id));
    if (!prev) { await tx.done; return null; }
    const fmtVal = (typeof format === "string" && format) ? format : null;
    const merged = { ...prev, format: fmtVal };
    await os.put(merged);
    await tx.done;
    return merged;
  };

  // Return all posts whose `niche` field equals the given label. No index;
  // niche is a low-cardinality categorical so a getAll + filter is fine.
  const getPostsByNiche = async (niche) => {
    if (!niche) return [];
    const db = await openDb();
    const all = await db.getAll(STORE);
    return all.filter((p) => p && p.niche === niche);
  };

  // -------- meta (per-post user state: pinned/status/note/tags) --------
  const emptyMeta = (id) => ({
    id,
    pinned: false,
    status: null,
    note: "",
    tags: [],
    updatedAt: 0,
  });

  const getMeta = async (id) => {
    if (!id) return null;
    const db = await openDb();
    return (await db.get(META_STORE, String(id))) || null;
  };

  const getAllMeta = async () => {
    const db = await openDb();
    return db.getAll(META_STORE);
  };

  // Patch is shallow-merged; pass `{ note: "…" }` to update one field.
  const setMeta = async (id, patch) => {
    if (!id) return null;
    const db = await openDb();
    const tx = db.transaction(META_STORE, "readwrite");
    const os = tx.objectStore(META_STORE);
    const prev = (await os.get(String(id))) || emptyMeta(String(id));
    const merged = {
      ...prev,
      ...patch,
      id: String(id),
      updatedAt: Date.now(),
    };
    // Defensive normalization.
    if (typeof merged.pinned !== "boolean") merged.pinned = !!merged.pinned;
    if (typeof merged.note !== "string") merged.note = String(merged.note || "");
    if (!Array.isArray(merged.tags)) merged.tags = [];
    if (merged.status !== null && typeof merged.status !== "string") merged.status = null;
    await os.put(merged);
    await tx.done;
    return merged;
  };

  const getPinnedMeta = async () => {
    const db = await openDb();
    // IDBKeyRange.only(true) on a boolean index; fall back to filter-scan if needed.
    try {
      return await db.getAllFromIndex(META_STORE, "by_pinned", IDBKeyRange.only(true));
    } catch {
      const all = await db.getAll(META_STORE);
      return all.filter((m) => m && m.pinned === true);
    }
  };

  // Join: fetch meta rows where pinned=true, then resolve their posts.
  const getPinnedPosts = async () => {
    const metas = await getPinnedMeta();
    if (!metas.length) return [];
    const db = await openDb();
    const tx = db.transaction(STORE, "readonly");
    const os = tx.objectStore(STORE);
    const out = [];
    for (const m of metas) {
      const p = await os.get(m.id);
      if (p) out.push({ ...p, _meta: m });
    }
    await tx.done;
    out.sort((a, b) => (b._meta?.updatedAt || 0) - (a._meta?.updatedAt || 0));
    return out;
  };

  // -------- creators (watchlist) --------
  const DEFAULT_INTERVAL_HRS = 24;
  const normUser = (u) => String(u || "").trim().toLowerCase().replace(/^@/, "");

  const emptyCreator = (username) => ({
    username: normUser(username),
    niche: "",
    nichePinned: false,
    embedding: "",     // base64 Float32Array
    embeddingAt: 0,
    addedAt: Date.now(),
    lastScrapedAt: 0,
    scrapeIntervalHrs: DEFAULT_INTERVAL_HRS,
    autoCollect: true,
    // Profile-derived fields. Populated by content.js when an IG/TT profile
    // info response (parsed via src/lib/profile-parser-runtime.js) flows in.
    // bioCapturedAt=0 means "never captured"; the niche cascade uses bio
    // when bioCapturedAt > 0 AND the bio text passes minBioWords.
    bio: "",
    category: "",
    fullName: "",
    externalUrl: "",
    bioCapturedAt: 0,
  });

  // Patch flags:
   //   _autoNiche: true → only overwrite `niche` when `prev.nichePinned` is false.
   //                      Used by the auto-clusterer so manual labels stick.
   //   _userNiche: true → user-set niche; sets `nichePinned: true` automatically.
  const addCreator = async (username, patch = {}) => {
    const u = normUser(username);
    if (!u) return null;
    const db = await openDb();
    const tx = db.transaction(CREATOR_STORE, "readwrite");
    const os = tx.objectStore(CREATOR_STORE);
    const prev = await os.get(u);
    const auto = !!patch._autoNiche;
    const userSet = !!patch._userNiche;
    const cleanPatch = { ...patch };
    delete cleanPatch._autoNiche;
    delete cleanPatch._userNiche;
    const merged = {
      ...(prev || emptyCreator(u)),
      ...cleanPatch,
      username: u,
    };
    // Auto-cluster: don't overwrite a pinned niche.
    if (auto && prev && prev.nichePinned) {
      merged.niche = prev.niche;
      merged.nichePinned = true;
    }
    // User assigned niche → pin it.
    if (userSet && "niche" in cleanPatch) {
      merged.nichePinned = true;
    }
    if (typeof merged.scrapeIntervalHrs !== "number" || merged.scrapeIntervalHrs <= 0) {
      merged.scrapeIntervalHrs = DEFAULT_INTERVAL_HRS;
    }
    if (typeof merged.autoCollect !== "boolean") merged.autoCollect = true;
    if (typeof merged.niche !== "string") merged.niche = "";
    if (typeof merged.nichePinned !== "boolean") merged.nichePinned = false;
    if (typeof merged.embedding !== "string") merged.embedding = "";
    if (typeof merged.embeddingAt !== "number") merged.embeddingAt = 0;
    if (typeof merged.lastScrapedAt !== "number") merged.lastScrapedAt = 0;
    if (typeof merged.addedAt !== "number") merged.addedAt = Date.now();
    if (typeof merged.bio !== "string") merged.bio = "";
    if (typeof merged.category !== "string") merged.category = "";
    if (typeof merged.fullName !== "string") merged.fullName = "";
    if (typeof merged.externalUrl !== "string") merged.externalUrl = "";
    if (typeof merged.bioCapturedAt !== "number") merged.bioCapturedAt = 0;
    await os.put(merged);
    await tx.done;
    return merged;
  };

  const updateCreator = async (username, patch) => addCreator(username, patch);

  const removeCreator = async (username) => {
    const u = normUser(username);
    if (!u) return false;
    const db = await openDb();
    await db.delete(CREATOR_STORE, u);
    return true;
  };

  const getCreator = async (username) => {
    const u = normUser(username);
    if (!u) return null;
    const db = await openDb();
    return (await db.get(CREATOR_STORE, u)) || null;
  };

  const getAllCreators = async () => {
    const db = await openDb();
    return db.getAll(CREATOR_STORE);
  };

  const touchCreatorScraped = async (username, t = Date.now()) => {
    return updateCreator(username, { lastScrapedAt: t });
  };

  // -------- audio (trending sound aggregation) --------
  // Audio rows: { id, title, artist, originalAuthor, isOriginal, audioClusterId,
  //   useCount, firstSeenAt, lastSeenAt, posts: string[] (postIds),
  //   medianOutlier, weeklyUseGrowth }
  // Upserts during ingest write the descriptive fields and append postId.
  // The hourly background recompute fills medianOutlier + weeklyUseGrowth.
  const upsertAudioForPost = async (post) => {
    if (!post || !post.id || !post.audio || !post.audio.id) return null;
    const a = post.audio;
    const db = await openDb();
    const tx = db.transaction(AUDIO_STORE, "readwrite");
    const os = tx.objectStore(AUDIO_STORE);
    const prev = await os.get(a.id);
    const now = Date.now();
    const postIds = Array.isArray(prev?.posts) ? prev.posts.slice() : [];
    if (!postIds.includes(post.id)) postIds.push(post.id);
    const merged = {
      id: a.id,
      title: a.title || prev?.title || "",
      artist: a.artist || prev?.artist || "",
      originalAuthor: a.originalAuthor || prev?.originalAuthor || "",
      isOriginal: typeof a.isOriginal === "boolean" ? a.isOriginal : !!prev?.isOriginal,
      audioClusterId: post.audioClusterId || prev?.audioClusterId || "",
      useCount: Math.max(prev?.useCount || 0, a.useCount || 0),
      posts: postIds,
      firstSeenAt: prev?.firstSeenAt || now,
      lastSeenAt: now,
      medianOutlier: prev?.medianOutlier || 0,
      weeklyUseGrowth: prev?.weeklyUseGrowth || 0,
    };
    await os.put(merged);
    await tx.done;
    return merged;
  };

  const bulkUpsertAudio = async (postsArr) => {
    if (!Array.isArray(postsArr) || !postsArr.length) return 0;
    let n = 0;
    for (const p of postsArr) {
      if (!p || !p.audio || !p.audio.id) continue;
      await upsertAudioForPost(p);
      n++;
    }
    return n;
  };

  const getAllAudio = async () => {
    const db = await openDb();
    return db.getAll(AUDIO_STORE);
  };

  const getAudio = async (id) => {
    if (!id) return null;
    const db = await openDb();
    return (await db.get(AUDIO_STORE, String(id))) || null;
  };

  const putAudio = async (row) => {
    if (!row || !row.id) return null;
    const db = await openDb();
    await db.put(AUDIO_STORE, row);
    return row;
  };

  // -------- signals (cross-creator hook reuse) --------
  // Signal id is `${newPostId}__${histPostId}` so re-detecting the same pair
  // is idempotent. Read = whether user has seen it in the Signals tab.
  const addSignal = async (sig) => {
    if (!sig || !sig.newPostId || !sig.histPostId) return null;
    const id = sig.id || `${sig.newPostId}__${sig.histPostId}`;
    const db = await openDb();
    const tx = db.transaction(SIGNAL_STORE, "readwrite");
    const os = tx.objectStore(SIGNAL_STORE);
    const prev = await os.get(id);
    const merged = {
      ...(prev || {}),
      ...sig,
      id,
      read: prev?.read ?? false,
      createdAt: prev?.createdAt || Date.now(),
      // Refresh similarity / score on re-detection so the row reflects
      // the latest stats.
      similarity: typeof sig.similarity === "number" ? sig.similarity : prev?.similarity || 0,
      histScore: typeof sig.histScore === "number" ? sig.histScore : prev?.histScore || 0,
    };
    await os.put(merged);
    await tx.done;
    return { row: merged, isNew: !prev };
  };

  const getAllSignals = async () => {
    const db = await openDb();
    return db.getAll(SIGNAL_STORE);
  };

  const markSignalRead = async (id, read = true) => {
    if (!id) return null;
    const db = await openDb();
    const tx = db.transaction(SIGNAL_STORE, "readwrite");
    const os = tx.objectStore(SIGNAL_STORE);
    const prev = await os.get(id);
    if (!prev) { await tx.done; return null; }
    const merged = { ...prev, read: !!read };
    await os.put(merged);
    await tx.done;
    return merged;
  };

  const removeSignal = async (id) => {
    if (!id) return false;
    const db = await openDb();
    await db.delete(SIGNAL_STORE, id);
    return true;
  };

  const clearSignals = async () => {
    const db = await openDb();
    await db.clear(SIGNAL_STORE);
  };

  // -------- voice (per-creator style fingerprint) --------
  // Row shape (mirrors src/analysis/voice-fingerprint.js):
  //   { username, tone, avgSentenceLen, signatureWords[], emojiRate,
  //     openerPatterns[], closerPatterns[], CTAStyle,
  //     generatedAt, sourcePostCount, model }
  const getVoice = async (username) => {
    const u = normUser(username);
    if (!u) return null;
    const db = await openDb();
    return (await db.get(VOICE_STORE, u)) || null;
  };

  const getAllVoices = async () => {
    const db = await openDb();
    return db.getAll(VOICE_STORE);
  };

  const putVoice = async (row) => {
    if (!row || !row.username) return null;
    const u = normUser(row.username);
    if (!u) return null;
    const merged = { ...row, username: u };
    if (typeof merged.generatedAt !== "number") merged.generatedAt = Date.now();
    if (!Array.isArray(merged.signatureWords)) merged.signatureWords = [];
    if (!Array.isArray(merged.openerPatterns)) merged.openerPatterns = [];
    if (!Array.isArray(merged.closerPatterns)) merged.closerPatterns = [];
    const db = await openDb();
    await db.put(VOICE_STORE, merged);
    return merged;
  };

  const removeVoice = async (username) => {
    const u = normUser(username);
    if (!u) return false;
    const db = await openDb();
    await db.delete(VOICE_STORE, u);
    return true;
  };

  // -------- rewrites (per-post per-platform repurposed copy) --------
  // Row shape (mirrors src/analysis/rewrite.js):
  //   { key, postId, platform, model, generatedAt, usedVoice,
  //     voiceUsername, nudge, data, raw, warnings, durationMs }
  // `key` is the compound `${postId}::${platform}` so a regenerate for the
  // same (post, platform) pair overwrites in place.
  const REWRITE_PLATFORMS = new Set(["tiktok", "yt_shorts", "x", "linkedin"]);
  const rewriteKey = (postId, platform) =>
    `${String(postId)}::${String(platform).toLowerCase()}`;

  const putRewrite = async (row) => {
    if (!row || !row.postId || !row.platform) return null;
    const platform = String(row.platform).toLowerCase();
    if (!REWRITE_PLATFORMS.has(platform)) return null;
    const merged = {
      ...row,
      postId: String(row.postId),
      platform,
      key: rewriteKey(row.postId, platform),
    };
    if (typeof merged.generatedAt !== "number") merged.generatedAt = Date.now();
    if (typeof merged.usedVoice !== "boolean") merged.usedVoice = !!merged.usedVoice;
    if (typeof merged.nudge !== "string") merged.nudge = String(merged.nudge || "");
    if (!Array.isArray(merged.warnings)) merged.warnings = [];
    const db = await openDb();
    await db.put(REWRITE_STORE, merged);
    return merged;
  };

  const getRewrite = async (postId, platform) => {
    if (!postId || !platform) return null;
    const db = await openDb();
    return (await db.get(REWRITE_STORE, rewriteKey(postId, platform))) || null;
  };

  const getRewritesForPost = async (postId) => {
    if (!postId) return [];
    const db = await openDb();
    return db.getAllFromIndex(REWRITE_STORE, "by_postId", String(postId));
  };

  const getAllRewrites = async () => {
    const db = await openDb();
    return db.getAll(REWRITE_STORE);
  };

  const removeRewrite = async (postId, platform) => {
    if (!postId || !platform) return false;
    const db = await openDb();
    await db.delete(REWRITE_STORE, rewriteKey(postId, platform));
    return true;
  };

  // -------- pipeline step sentinels (repurpose pipeline resume) --------
  const pipelineKey = (postId, step) => `${String(postId)}::${String(step)}`;

  const getPipelineStep = async (postId, step) => {
    if (!postId || !step) return null;
    const db = await openDb();
    return (await db.get(PIPELINE_STORE, pipelineKey(postId, step))) || null;
  };

  const putPipelineStep = async (postId, step, payload) => {
    if (!postId || !step) return null;
    const row = {
      key: pipelineKey(postId, step),
      postId: String(postId),
      step: String(step),
      at: (payload && payload.at) || Date.now(),
      payload: payload || null,
    };
    const db = await openDb();
    await db.put(PIPELINE_STORE, row);
    return row;
  };

  const getPipelineStepsForPost = async (postId) => {
    if (!postId) return [];
    const db = await openDb();
    return db.getAllFromIndex(PIPELINE_STORE, "by_postId", String(postId));
  };

  const clearPipelineStepsForPost = async (postId) => {
    if (!postId) return 0;
    const rows = await getPipelineStepsForPost(postId);
    if (!rows.length) return 0;
    const db = await openDb();
    const tx = db.transaction(PIPELINE_STORE, "readwrite");
    for (const r of rows) await tx.objectStore(PIPELINE_STORE).delete(r.key);
    await tx.done;
    return rows.length;
  };

  window.__fsStore = {
    ready: () => openDb().then(() => undefined),
    upsert,
    bulkUpsert,
    getAll,
    getByAuthor,
    getRecent,
    getByScope,
    clearAll,
    setPostTranscript,
    setPostAi,
    setPostDiagnosis,
    setPostCoverAi,
    setPostNiche,
    setPostFormat,
    setPostVisualFormat,
    getPostsByNiche,
    getMeta,
    setMeta,
    getAllMeta,
    getPinnedMeta,
    getPinnedPosts,
    addCreator,
    updateCreator,
    removeCreator,
    getCreator,
    getAllCreators,
    touchCreatorScraped,
    upsertAudioForPost,
    bulkUpsertAudio,
    getAllAudio,
    getAudio,
    putAudio,
    addSignal,
    getAllSignals,
    markSignalRead,
    removeSignal,
    clearSignals,
    getVoice,
    getAllVoices,
    putVoice,
    removeVoice,
    putRewrite,
    getRewrite,
    getRewritesForPost,
    getAllRewrites,
    removeRewrite,
    getPipelineStep,
    putPipelineStep,
    getPipelineStepsForPost,
    clearPipelineStepsForPost,
    _mergePosts: mergePosts, // exported for tests
  };
})();
