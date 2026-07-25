import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearSessionStoreCaches } from "./store-cache.js";
import { loadSessionStore } from "./store-load.js";
import { saveSessionStore } from "./store.js";
import type { SessionEntry, SessionSkillSnapshot } from "./types.js";

function makeSnapshot(tag: string): SessionSkillSnapshot {
  return {
    prompt: `PROMPT-${tag}-${"x".repeat(200)}`,
    skills: [{ name: "logger", primaryEnv: "LOG", requiredEnv: ["A", "B"] }],
    skillFilter: ["logger"],
    version: 3,
  };
}

describe("skillsSnapshot dedup — save/load integration", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    clearSessionStoreCaches();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-dedup-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(() => {
    clearSessionStoreCaches();
    delete process.env.OPENCLAW_SKILLS_SNAPSHOT_DEDUP;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("dedups on disk but returns fully hydrated, shared snapshots from loadSessionStore", async () => {
    const store: Record<string, SessionEntry> = {
      "agent:m:main": { sessionId: "s0", updatedAt: 10, skillsSnapshot: makeSnapshot("v3") },
      "agent:m:cron:a": { sessionId: "s1", updatedAt: 11, skillsSnapshot: makeSnapshot("v3") },
      "agent:m:cron:b": { sessionId: "s2", updatedAt: 12, skillsSnapshot: makeSnapshot("v3") },
    };
    await saveSessionStore(storePath, store, { skipMaintenance: true });

    // On disk: exactly one inline snapshot, the rest carry a ref.
    const raw = JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, SessionEntry>;
    const inlineOnDisk = Object.values(raw).filter((e) => e.skillsSnapshot).length;
    expect(inlineOnDisk).toBe(1);
    expect(Object.values(raw).filter((e) => e.skillsSnapshotRef).length).toBe(2);

    // From loadSessionStore: every entry has the full snapshot, all share one object,
    // and no ref field leaks into the live store.
    clearSessionStoreCaches();
    const loaded = loadSessionStore(storePath, { skipCache: true });
    const expectedSnapshot = makeSnapshot("v3");
    for (const key of Object.keys(store)) {
      expect(loaded[key].skillsSnapshot).toEqual(expectedSnapshot);
      expect(loaded[key].skillsSnapshotRef).toBeUndefined();
    }
    expect(loaded["agent:m:main"].skillsSnapshot).toBe(loaded["agent:m:cron:a"].skillsSnapshot);
    expect(loaded["agent:m:cron:a"].skillsSnapshot).toBe(loaded["agent:m:cron:b"].skillsSnapshot);
  });

  it("kill switch off = byte-identical old behavior (full inline on disk, distinct in memory)", async () => {
    process.env.OPENCLAW_SKILLS_SNAPSHOT_DEDUP = "off";
    const store: Record<string, SessionEntry> = {
      "agent:m:main": { sessionId: "s0", updatedAt: 10, skillsSnapshot: makeSnapshot("v3") },
      "agent:m:cron:a": { sessionId: "s1", updatedAt: 11, skillsSnapshot: makeSnapshot("v3") },
      "agent:m:cron:b": { sessionId: "s2", updatedAt: 12, skillsSnapshot: makeSnapshot("v3") },
    };
    await saveSessionStore(storePath, store, { skipMaintenance: true });

    // On disk: full inline everywhere (no refs) — byte-identical to the pre-dedup
    // serializer output for the same store.
    const raw = fs.readFileSync(storePath, "utf-8");
    expect(raw).toBe(JSON.stringify(store, null, 2));

    // In memory: no sharing (old behavior — each entry its own object).
    clearSessionStoreCaches();
    const loaded = loadSessionStore(storePath, { skipCache: true });
    expect(loaded["agent:m:main"].skillsSnapshot).not.toBe(loaded["agent:m:cron:a"].skillsSnapshot);
    expect(Object.values(loaded).every((e) => e.skillsSnapshotRef === undefined)).toBe(true);
  });

  it("shrinks the on-disk file versus full inline copies", async () => {
    const store: Record<string, SessionEntry> = {};
    for (let i = 0; i < 20; i++) {
      store[`agent:m:cron:job${i}`] = {
        sessionId: `s${i}`,
        updatedAt: i,
        skillsSnapshot: makeSnapshot("v3"),
      };
    }
    await saveSessionStore(storePath, store, { skipMaintenance: true });
    const dedupedSize = fs.statSync(storePath).size;

    const fullInline = JSON.stringify(store, null, 2);
    expect(dedupedSize).toBeLessThan(fullInline.length / 2);
  });
});
