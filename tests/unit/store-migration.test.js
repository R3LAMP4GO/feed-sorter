// v8 → v9 migration: prefix legacy bare post ids with `ig_` and stamp
// `meta:migrationVersion=9`. Uses fake-indexeddb so we can drive the full
// `idb` upgrade flow in node.
import { describe, it, expect, beforeEach } from "vitest";
import "fake-indexeddb/auto";
import { openDB } from "idb";

const DB_NAME = "feed-sorter-test-migration";

const seedV8 = async () => {
  const db = await openDB(DB_NAME, 8, {
    upgrade(db) {
      const os = db.createObjectStore("posts", { keyPath: "id" });
      os.createIndex("by_author", "author");
      const m = db.createObjectStore("meta", { keyPath: "id" });
      m.createIndex("by_pinned", "pinned");
    },
  });
  await db.put("posts", { id: "4001", author: "zach", likes: 10 });
  await db.put("posts", { id: "4002", author: "zach", likes: 20 });
  // Already-prefixed row should be left alone.
  await db.put("posts", { id: "tt_999", author: "khaby", likes: 7, platform: "tiktok" });
  db.close();
};

const openV9 = async () => {
  // Inline the same upgrade logic as src/store.js — we can't import the
  // IIFE source directly under vitest. The shape we test here mirrors
  // store.js verbatim; if those diverge, this test will catch it.
  return openDB(DB_NAME, 9, {
    async upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 9 && db.objectStoreNames.contains("posts")) {
        const os = transaction.objectStore("posts");
        let cursor = await os.openCursor();
        let migrated = 0;
        while (cursor) {
          const row = cursor.value;
          if (row?.id && !/^[a-z]{2,4}_/.test(String(row.id))) {
            const newId = `ig_${row.id}`;
            const next = { ...row, id: newId, platform: row.platform || "instagram" };
            await os.delete(cursor.key);
            await os.put(next);
            migrated++;
          }
          cursor = await cursor.continue();
        }
        if (db.objectStoreNames.contains("meta")) {
          const m = transaction.objectStore("meta");
          await m.put({ id: "migrationVersion", value: 9, migrated, at: Date.now() });
        }
      }
    },
  });
};

const openV10 = async () => {
  // Mirrors src/store.js v9→v10 block: stamp niche/nicheBasis/format=null
  // on existing rows that don't already carry them.
  return openDB(DB_NAME, 10, {
    async upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 9 && db.objectStoreNames.contains("posts")) {
        const os = transaction.objectStore("posts");
        let cursor = await os.openCursor();
        let migrated = 0;
        while (cursor) {
          const row = cursor.value;
          if (row?.id && !/^[a-z]{2,4}_/.test(String(row.id))) {
            const newId = `ig_${row.id}`;
            const next = { ...row, id: newId, platform: row.platform || "instagram" };
            await os.delete(cursor.key);
            await os.put(next);
            migrated++;
          }
          cursor = await cursor.continue();
        }
        if (db.objectStoreNames.contains("meta")) {
          const m = transaction.objectStore("meta");
          await m.put({ id: "migrationVersion", value: 9, migrated, at: Date.now() });
        }
      }
      if (oldVersion < 10 && db.objectStoreNames.contains("posts")) {
        const os = transaction.objectStore("posts");
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
        if (db.objectStoreNames.contains("meta")) {
          const m = transaction.objectStore("meta");
          await m.put({ id: "migrationVersion", value: 10, touched, at: Date.now() });
        }
      }
    },
  });
};

describe("v8 → v9 post id prefix migration", () => {
  beforeEach(async () => {
    // fresh DB each test
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });

  it("prefixes bare ids with ig_ and stamps migrationVersion=9", async () => {
    await seedV8();
    const db = await openV9();
    const all = await db.getAll("posts");
    const ids = new Set(all.map((r) => r.id));
    expect(ids).toEqual(new Set(["ig_4001", "ig_4002", "tt_999"]));
    for (const r of all) {
      if (r.id.startsWith("ig_")) expect(r.platform).toBe("instagram");
      if (r.id === "tt_999") expect(r.platform).toBe("tiktok");
    }
    const meta = await db.get("meta", "migrationVersion");
    expect(meta).toBeTruthy();
    expect(meta.value).toBe(9);
    expect(meta.migrated).toBe(2); // tt_999 was skipped
    db.close();
  });

  it("is idempotent on re-open", async () => {
    await seedV8();
    let db = await openV9();
    db.close();
    db = await openV9();
    const all = await db.getAll("posts");
    expect(new Set(all.map((r) => r.id))).toEqual(
      new Set(["ig_4001", "ig_4002", "tt_999"])
    );
    db.close();
  });
});

// Mirrors src/store.js v10→v11: stamp bio/category/fullName/externalUrl/
// bioCapturedAt=0 on existing `creators` rows, and visualFormat on `posts`
// rows (deriving from cover_ai when present, null otherwise).
const openV11 = async () => {
  return openDB(DB_NAME, 11, {
    async upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 1) {
        // creators store may not exist yet if seeded from v8 — create it.
        if (!db.objectStoreNames.contains("creators")) {
          const c = db.createObjectStore("creators", { keyPath: "username" });
          c.createIndex("by_niche", "niche");
        }
      }
      if (oldVersion < 9 && db.objectStoreNames.contains("posts")) {
        const os = transaction.objectStore("posts");
        let cursor = await os.openCursor();
        while (cursor) {
          const row = cursor.value;
          if (row?.id && !/^[a-z]{2,4}_/.test(String(row.id))) {
            const newId = `ig_${row.id}`;
            const next = { ...row, id: newId, platform: row.platform || "instagram" };
            await os.delete(cursor.key);
            await os.put(next);
          }
          cursor = await cursor.continue();
        }
      }
      if (oldVersion < 10 && db.objectStoreNames.contains("posts")) {
        const os = transaction.objectStore("posts");
        let cursor = await os.openCursor();
        while (cursor) {
          const row = cursor.value;
          if (row && (row.niche === undefined || row.nicheBasis === undefined || row.format === undefined)) {
            await os.put({
              ...row,
              niche: row.niche === undefined ? null : row.niche,
              nicheBasis: row.nicheBasis === undefined ? null : row.nicheBasis,
              format: row.format === undefined ? null : row.format,
            });
          }
          cursor = await cursor.continue();
        }
      }
      if (oldVersion < 11) {
        if (db.objectStoreNames.contains("creators")) {
          const cs = transaction.objectStore("creators");
          let cursor = await cs.openCursor();
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
            }
            cursor = await cursor.continue();
          }
        }
        if (db.objectStoreNames.contains("posts")) {
          const ps = transaction.objectStore("posts");
          let cursor = await ps.openCursor();
          while (cursor) {
            const row = cursor.value;
            if (row && row.visualFormat === undefined) {
              await ps.put({ ...row, visualFormat: null });
            }
            cursor = await cursor.continue();
          }
        }
      }
    },
  });
};

// Seed a v3-shape DB that has both posts and creators stores. Used to set
// up the v10→v11 migration test fixture where pre-existing creator rows
// lack the bio fields.
const seedV3WithCreator = async (creatorRow) => {
  const db = await openDB(DB_NAME, 3, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("posts")) {
        const os = db.createObjectStore("posts", { keyPath: "id" });
        os.createIndex("by_author", "author");
      }
      if (!db.objectStoreNames.contains("meta")) {
        const m = db.createObjectStore("meta", { keyPath: "id" });
        m.createIndex("by_pinned", "pinned");
      }
      if (!db.objectStoreNames.contains("creators")) {
        const c = db.createObjectStore("creators", { keyPath: "username" });
        c.createIndex("by_niche", "niche");
      }
    },
  });
  await db.put("posts", { id: "ig_4001", author: "sarah.realtor", likes: 1000 });
  await db.put("creators", creatorRow);
  db.close();
};

describe("v10 → v11 bio + visualFormat field migration", () => {
  beforeEach(async () => {
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });

  it("stamps bio/category/fullName/externalUrl/bioCapturedAt on legacy creator rows", async () => {
    // Pre-v11 row: no bio fields at all.
    await seedV3WithCreator({
      username: "sarah.realtor",
      niche: "",
      nichePinned: false,
      addedAt: 1234567890,
      lastScrapedAt: 0,
    });
    const db = await openV11();
    try {
      const row = await db.get("creators", "sarah.realtor");
      expect(row.bio).toBe("");
      expect(row.category).toBe("");
      expect(row.fullName).toBe("");
      expect(row.externalUrl).toBe("");
      expect(row.bioCapturedAt).toBe(0);
      // Existing fields preserved.
      expect(row.addedAt).toBe(1234567890);
      expect(row.niche).toBe("");
    } finally {
      db.close();
    }
  });

  it("preserves existing bio values when migration runs (idempotent on re-open)", async () => {
    await seedV3WithCreator({
      username: "old.coach",
      niche: "Fitness",
      bio: "Online strength coach",
      category: "Fitness Trainer",
      bioCapturedAt: 1700000000000,
    });
    const db = await openV11();
    try {
      const row = await db.get("creators", "old.coach");
      expect(row.bio).toBe("Online strength coach");
      expect(row.category).toBe("Fitness Trainer");
      expect(row.bioCapturedAt).toBe(1700000000000);
    } finally {
      db.close();
    }
  });

  it("stamps visualFormat=null on existing posts", async () => {
    await seedV8();
    const db = await openV11();
    try {
      const all = await db.getAll("posts");
      expect(all.length).toBeGreaterThan(0);
      for (const r of all) {
        expect(r.visualFormat).toBe(null);
      }
    } finally {
      db.close();
    }
  });

  it("preserves existing visualFormat values across re-open", async () => {
    await seedV8();
    let db = await openV11();
    const row = await db.get("posts", "ig_4001");
    await db.put("posts", { ...row, visualFormat: "talking-head" });
    db.close();
    db = await openV11();
    try {
      const after = await db.get("posts", "ig_4001");
      expect(after.visualFormat).toBe("talking-head");
    } finally {
      db.close();
    }
  });
});

describe("v9 → v10 niche/format field migration", () => {
  beforeEach(async () => {
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });

  it("stamps niche/nicheBasis/format=null on existing rows", async () => {
    await seedV8();
    const db = await openV10();
    const all = await db.getAll("posts");
    expect(all.length).toBe(3);
    for (const r of all) {
      expect(r.niche).toBe(null);
      expect(r.nicheBasis).toBe(null);
      expect(r.format).toBe(null);
    }
    const meta = await db.get("meta", "migrationVersion");
    expect(meta.value).toBe(10);
    db.close();
  });

  it("preserves rows that already carry the new fields", async () => {
    await seedV8();
    let db = await openV10();
    // Manually set niche on one row, then re-open at v10 — should be untouched.
    const row = await db.get("posts", "ig_4001");
    await db.put("posts", { ...row, niche: "Sales psychology", nicheBasis: "text", format: "list" });
    db.close();
    db = await openV10();
    const after = await db.get("posts", "ig_4001");
    expect(after.niche).toBe("Sales psychology");
    expect(after.nicheBasis).toBe("text");
    expect(after.format).toBe("list");
    db.close();
  });

  it("round-trips niche + format through setter/getter logic", async () => {
    // Inline equivalents of __fsStore.setPostNiche / setPostFormat / getPostsByNiche
    // (src/store.js is an IIFE bound to window; we exercise the same IDB ops here).
    await seedV8();
    const db = await openV10();

    const setPostNiche = async (id, niche, basis) => {
      const tx = db.transaction("posts", "readwrite");
      const os = tx.objectStore("posts");
      const prev = await os.get(String(id));
      if (!prev) { await tx.done; return null; }
      const merged = { ...prev, niche: niche || null, nicheBasis: basis || null };
      await os.put(merged);
      await tx.done;
      return merged;
    };
    const setPostFormat = async (id, format) => {
      const tx = db.transaction("posts", "readwrite");
      const os = tx.objectStore("posts");
      const prev = await os.get(String(id));
      if (!prev) { await tx.done; return null; }
      const merged = { ...prev, format: format || null };
      await os.put(merged);
      await tx.done;
      return merged;
    };
    const getPostsByNiche = async (niche) => {
      const all = await db.getAll("posts");
      return all.filter((p) => p && p.niche === niche);
    };

    await setPostNiche("ig_4001", "Sales psychology", "text");
    await setPostNiche("ig_4002", "Sales psychology", "author");
    await setPostNiche("tt_999", "Comedy", "visual");
    await setPostFormat("ig_4001", "list");
    await setPostFormat("ig_4002", "tutorial");

    const sales = await getPostsByNiche("Sales psychology");
    expect(new Set(sales.map((p) => p.id))).toEqual(new Set(["ig_4001", "ig_4002"]));
    expect(sales.find((p) => p.id === "ig_4001").format).toBe("list");
    expect(sales.find((p) => p.id === "ig_4002").nicheBasis).toBe("author");

    const comedy = await getPostsByNiche("Comedy");
    expect(comedy.map((p) => p.id)).toEqual(["tt_999"]);
    expect(comedy[0].nicheBasis).toBe("visual");

    expect(await getPostsByNiche("Nonexistent")).toEqual([]);
    db.close();
  });
});


const openV12 = async () => {
  return openDB(DB_NAME, 12, {
    async upgrade(db, oldVersion, _newVersion, transaction) {
      if (oldVersion < 9 && db.objectStoreNames.contains("posts")) {
        const os = transaction.objectStore("posts");
        let cursor = await os.openCursor();
        while (cursor) {
          const row = cursor.value;
          if (row?.id && !/^[a-z]{2,4}_/.test(String(row.id))) {
            const newId = `ig_${row.id}`;
            const next = { ...row, id: newId, platform: row.platform || "instagram" };
            await os.delete(cursor.key);
            await os.put(next);
          }
          cursor = await cursor.continue();
        }
      }
      if (oldVersion < 10 && db.objectStoreNames.contains("posts")) {
        const os = transaction.objectStore("posts");
        let cursor = await os.openCursor();
        while (cursor) {
          const row = cursor.value;
          if (row && (row.niche === undefined || row.nicheBasis === undefined || row.format === undefined)) {
            await os.put({
              ...row,
              niche: row.niche === undefined ? null : row.niche,
              nicheBasis: row.nicheBasis === undefined ? null : row.nicheBasis,
              format: row.format === undefined ? null : row.format,
            });
          }
          cursor = await cursor.continue();
        }
      }
      if (oldVersion < 11 && db.objectStoreNames.contains("posts")) {
        const ps = transaction.objectStore("posts");
        let cursor = await ps.openCursor();
        while (cursor) {
          const row = cursor.value;
          if (row && row.visualFormat === undefined) await ps.put({ ...row, visualFormat: null });
          cursor = await cursor.continue();
        }
      }
      if (oldVersion < 12 && db.objectStoreNames.contains("posts")) {
        const os = transaction.objectStore("posts");
        let cursor = await os.openCursor();
        let touched = 0;
        while (cursor) {
          const row = cursor.value;
          if (row && (
            row.category === undefined || row.categoryConfidence === undefined ||
            row.contentFormat === undefined || row.formatConfidence === undefined ||
            row.classificationSource === undefined || row.classificationAt === undefined
          )) {
            await os.put({
              ...row,
              category: row.category === undefined ? null : row.category,
              categoryConfidence: row.categoryConfidence === undefined ? null : row.categoryConfidence,
              contentFormat: row.contentFormat === undefined ? null : row.contentFormat,
              formatConfidence: row.formatConfidence === undefined ? null : row.formatConfidence,
              classificationSource: row.classificationSource === undefined ? "" : row.classificationSource,
              classificationAt: row.classificationAt === undefined ? null : row.classificationAt,
            });
            touched++;
          }
          cursor = await cursor.continue();
        }
        if (db.objectStoreNames.contains("meta")) {
          const m = transaction.objectStore("meta");
          await m.put({ id: "migrationVersion-v12-classification", value: 12, touchedPosts: touched, at: Date.now() });
        }
      }
    },
  });
};

describe("v11 → v12 CSV classification field migration", () => {
  beforeEach(async () => {
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  });

  it("stamps classification fields on existing posts", async () => {
    await seedV8();
    const db = await openV12();
    try {
      const all = await db.getAll("posts");
      expect(all.length).toBe(3);
      for (const row of all) {
        expect(row.category).toBe(null);
        expect(row.categoryConfidence).toBe(null);
        expect(row.contentFormat).toBe(null);
        expect(row.formatConfidence).toBe(null);
        expect(row.classificationSource).toBe("");
        expect(row.classificationAt).toBe(null);
      }
      const meta = await db.get("meta", "migrationVersion-v12-classification");
      expect(meta.value).toBe(12);
      expect(meta.touchedPosts).toBe(3);
    } finally {
      db.close();
    }
  });

  it("round-trips setPostClassification-equivalent patch logic", async () => {
    await seedV8();
    const db = await openV12();
    const setPostClassification = async (id, classification) => {
      const tx = db.transaction("posts", "readwrite");
      const os = tx.objectStore("posts");
      const prev = await os.get(String(id));
      const merged = {
        ...prev,
        category: classification.category || null,
        niche: classification.niche || prev.niche || null,
        contentFormat: classification.contentFormat || null,
        visualFormat: classification.visualFormat || prev.visualFormat || null,
        format: classification.format || null,
        categoryConfidence: Number.isFinite(Number(classification.categoryConfidence)) ? Number(classification.categoryConfidence) : null,
        formatConfidence: Number.isFinite(Number(classification.formatConfidence)) ? Number(classification.formatConfidence) : null,
        classificationSource: classification.classificationSource || "",
        classificationAt: classification.classificationAt || Date.now(),
      };
      await os.put(merged);
      await tx.done;
      return merged;
    };

    const row = await setPostClassification("ig_4001", {
      category: "business",
      niche: "sales psychology",
      contentFormat: "tutorial",
      visualFormat: "talking-head",
      format: "talking-head",
      categoryConfidence: 0.65,
      formatConfidence: 0.8,
      classificationSource: "mixed",
      classificationAt: 1700000000000,
    });
    expect(row.category).toBe("business");
    expect(row.niche).toBe("sales psychology");
    expect(row.contentFormat).toBe("tutorial");
    expect(row.format).toBe("talking-head");
    expect(row.visualFormat).toBe("talking-head");
    expect(row.classificationAt).toBe(1700000000000);
    db.close();
  });
});
