import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dedupeSessionStoreFile } from "./dedupe-migration.js";
import { clearSessionStoreCaches } from "./store-cache.js";
import { loadSessionStore } from "./store-load.js";
import type { SessionEntry, SessionSkillSnapshot } from "./types.js";

function makeSnapshot(tag: string): SessionSkillSnapshot {
  return {
    prompt: `PROMPT-${tag}-${"x".repeat(200)}`,
    skills: [{ name: "logger", primaryEnv: "LOG", requiredEnv: ["A", "B"] }],
    skillFilter: ["logger"],
    version: 3,
  };
}

describe("dedupeSessionStoreFile", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    clearSessionStoreCaches();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dedup-migration-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(() => {
    clearSessionStoreCaches();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeBloatedStore(): Record<string, SessionEntry> {
    const store: Record<string, SessionEntry> = {
      "agent:m:main": { sessionId: "s0", updatedAt: 10, skillsSnapshot: makeSnapshot("v3") },
      "agent:m:cron:a": { sessionId: "s1", updatedAt: 11, skillsSnapshot: makeSnapshot("v3") },
      "agent:m:cron:b": { sessionId: "s2", updatedAt: 12, skillsSnapshot: makeSnapshot("v3") },
    };
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
    return store;
  }

  it("dedups a bloated store, backs up, and preserves content", async () => {
    writeBloatedStore();
    const before = fs.statSync(storePath).size;

    const result = await dedupeSessionStoreFile(storePath);

    expect(result.status).toBe("deduped");
    if (result.status !== "deduped") {
      return;
    }
    expect(result.backupCreated).toBe(true);
    expect(result.afterBytes).toBeLessThan(result.beforeBytes);

    // Backup holds the ORIGINAL (all-inline) content.
    const backup = JSON.parse(fs.readFileSync(result.backupPath, "utf-8")) as Record<
      string,
      SessionEntry
    >;
    expect(Object.values(backup).filter((e) => e.skillsSnapshot).length).toBe(3);

    // On-disk store now has exactly one inline snapshot.
    const onDisk = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, SessionEntry>;
    expect(Object.values(onDisk).filter((e) => e.skillsSnapshot).length).toBe(1);
    expect(fs.statSync(storePath).size).toBeLessThan(before);

    // Content is preserved after hydration.
    clearSessionStoreCaches();
    const loaded = loadSessionStore(storePath, { skipCache: true });
    const expected = makeSnapshot("v3");
    for (const key of ["agent:m:main", "agent:m:cron:a", "agent:m:cron:b"]) {
      expect(loaded[key].skillsSnapshot).toEqual(expected);
    }
  });

  it("is idempotent: a second run is a no-op and does not re-backup", async () => {
    writeBloatedStore();
    const first = await dedupeSessionStoreFile(storePath);
    expect(first.status).toBe("deduped");

    clearSessionStoreCaches();
    const second = await dedupeSessionStoreFile(storePath);
    expect(second.status).toBe("skipped");
    if (second.status === "skipped") {
      expect(second.reason).toBe("already-deduped");
    }
  });

  it("skips a store with no shared snapshots", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:m:a": { sessionId: "s0", updatedAt: 1, skillsSnapshot: makeSnapshot("one") },
      "agent:m:b": { sessionId: "s1", updatedAt: 2 },
    };
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2));

    const result = await dedupeSessionStoreFile(storePath);
    expect(result.status).toBe("skipped");
    if (result.status === "skipped") {
      expect(result.reason).toBe("no-shared-snapshots");
    }
    expect(fs.existsSync(`${storePath}.pre-dedup`)).toBe(false);
  });

  it("reports missing for a non-existent store", async () => {
    const result = await dedupeSessionStoreFile(path.join(tmpDir, "nope.json"));
    expect(result.status).toBe("missing");
  });
});
