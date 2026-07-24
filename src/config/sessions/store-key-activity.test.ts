import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import { clearSessionStoreCaches } from "./store-cache.js";
import { loadSessionStore, readSessionStoreKeyActivity } from "./store-load.js";

afterEach(() => {
  clearSessionStoreCaches();
});

const writeStore = async (storePath: string, store: Record<string, unknown>): Promise<void> => {
  await fs.writeFile(storePath, JSON.stringify(store), "utf8");
};

describe("readSessionStoreKeyActivity", () => {
  it("projects to [key, updatedAt] equivalently to loadSessionStore", async () => {
    await withTempDir({ prefix: "openclaw-session-activity-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      await writeStore(storePath, {
        "s-1": { sessionId: "1", updatedAt: 100 },
        "s-2": { sessionId: "2", updatedAt: 300 },
        "s-3": { sessionId: "3" }, // missing updatedAt -> 0
      });

      const activity = readSessionStoreKeyActivity(storePath, { skipCache: true });
      const byKey = Object.fromEntries(activity.map((a) => [a.key, a.updatedAt]));
      expect(byKey).toEqual({ "s-1": 100, "s-2": 300, "s-3": 0 });

      // Equivalent to projecting the fully-loaded (cloned) store.
      const store = loadSessionStore(storePath, { skipCache: true });
      const expected = Object.fromEntries(
        Object.entries(store).map(([key, entry]) => [key, entry?.updatedAt ?? 0]),
      );
      expect(byKey).toEqual(expected);
    });
  });

  it("returns a fresh primitive array with no shared reference into the cached store", async () => {
    await withTempDir({ prefix: "openclaw-session-activity-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      await writeStore(storePath, { "s-1": { sessionId: "1", updatedAt: 100 } });

      // First call populates the store cache; the projection must not expose a
      // mutable reference to the cached entries.
      const activity = readSessionStoreKeyActivity(storePath);
      activity[0].updatedAt = 999_999;
      activity.push({ key: "injected", updatedAt: 1 });

      const store = loadSessionStore(storePath);
      expect(store["s-1"].updatedAt).toBe(100);
      expect(store).not.toHaveProperty("injected");

      const activity2 = readSessionStoreKeyActivity(storePath);
      expect(activity2).toEqual([{ key: "s-1", updatedAt: 100 }]);
    });
  });

  it("keeps loadSessionStore returning a deep clone (mutation isolation preserved)", async () => {
    await withTempDir({ prefix: "openclaw-session-activity-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      await writeStore(storePath, { "s-1": { sessionId: "1", updatedAt: 100 } });

      const first = loadSessionStore(storePath);
      first["s-1"].updatedAt = 5;

      const second = loadSessionStore(storePath);
      expect(second["s-1"].updatedAt).toBe(100);
    });
  });

  it("returns an empty array for a missing store file", async () => {
    await withTempDir({ prefix: "openclaw-session-activity-" }, async (dir) => {
      const storePath = path.join(dir, "does-not-exist.json");
      expect(readSessionStoreKeyActivity(storePath, { skipCache: true })).toEqual([]);
    });
  });
});
