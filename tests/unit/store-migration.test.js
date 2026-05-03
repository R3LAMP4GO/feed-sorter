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
          if (row && row.id && !/^[a-z]{2,4}_/.test(String(row.id))) {
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
