import { describe, expect, it } from "vitest";
import {
  resolveMemorySessionSyncPlan,
  shouldParseSessionFileForStatSkip,
} from "./manager-session-sync-state.js";

describe("memory session sync state", () => {
  it("tracks active paths and bulk hashes for full scans", () => {
    const plan = resolveMemorySessionSyncPlan({
      needsFullReindex: false,
      files: ["/tmp/a.jsonl", "/tmp/b.jsonl"],
      targetSessionFiles: null,
      sessionsDirtyFiles: new Set(),
      existingRows: [
        { path: "sessions/a.jsonl", hash: "hash-a" },
        { path: "sessions/b.jsonl", hash: "hash-b" },
      ],
      sessionPathForFile: (file) => `sessions/${file.split("/").at(-1)}`,
    });

    expect(plan.indexAll).toBe(true);
    expect(plan.activePaths).toEqual(new Set(["sessions/a.jsonl", "sessions/b.jsonl"]));
    expect(plan.existingRows).toEqual([
      { path: "sessions/a.jsonl", hash: "hash-a" },
      { path: "sessions/b.jsonl", hash: "hash-b" },
    ]);
    expect(plan.existingHashes).toEqual(
      new Map([
        ["sessions/a.jsonl", "hash-a"],
        ["sessions/b.jsonl", "hash-b"],
      ]),
    );
  });

  it("treats targeted session syncs as refresh-only and skips unrelated pruning", () => {
    const plan = resolveMemorySessionSyncPlan({
      needsFullReindex: false,
      files: ["/tmp/targeted-first.jsonl"],
      targetSessionFiles: new Set(["/tmp/targeted-first.jsonl"]),
      sessionsDirtyFiles: new Set(["/tmp/targeted-first.jsonl"]),
      existingRows: [
        { path: "sessions/targeted-first.jsonl", hash: "hash-first" },
        { path: "sessions/targeted-second.jsonl", hash: "hash-second" },
      ],
      sessionPathForFile: (file) => `sessions/${file.split("/").at(-1)}`,
    });

    expect(plan.indexAll).toBe(true);
    expect(plan.activePaths).toBeNull();
    expect(plan.existingRows).toBeNull();
    expect(plan.existingHashes).toBeNull();
  });

  it("keeps dirty-only incremental mode when no targeted sync is requested", () => {
    const plan = resolveMemorySessionSyncPlan({
      needsFullReindex: false,
      files: ["/tmp/incremental.jsonl"],
      targetSessionFiles: null,
      sessionsDirtyFiles: new Set(["/tmp/incremental.jsonl"]),
      existingRows: [],
      sessionPathForFile: (file) => `sessions/${file.split("/").at(-1)}`,
    });

    expect(plan.indexAll).toBe(false);
    expect(plan.activePaths).toEqual(new Set(["sessions/incremental.jsonl"]));
  });

  it("builds existingStats only from rows with both mtime and size", () => {
    const plan = resolveMemorySessionSyncPlan({
      needsFullReindex: false,
      files: ["/tmp/a.jsonl", "/tmp/b.jsonl", "/tmp/c.jsonl"],
      targetSessionFiles: null,
      sessionsDirtyFiles: new Set(),
      existingRows: [
        { path: "sessions/a.jsonl", hash: "h-a", mtime: 100, size: 10 },
        { path: "sessions/b.jsonl", hash: "h-b", mtime: null, size: 20 }, // legacy: no mtime -> excluded
        { path: "sessions/c.jsonl", hash: "h-c", mtime: 300 }, // no size -> excluded
      ],
      sessionPathForFile: (file) => `sessions/${file.split("/").at(-1)}`,
    });
    expect(plan.existingStats).toEqual(new Map([["sessions/a.jsonl", { mtime: 100, size: 10 }]]));
  });
});

describe("shouldParseSessionFileForStatSkip (fail-open)", () => {
  const known = { mtime: 100, size: 10 } as const;
  const base = { forceFullReparse: false, isDirty: false };

  it("skips (false) ONLY on an exact mtime+size match", () => {
    expect(
      shouldParseSessionFileForStatSkip({
        ...base,
        currentStat: { mtimeMs: 100, size: 10 },
        knownStat: known,
      }),
    ).toBe(false);
  });

  it("re-parses when the file grew (append)", () => {
    expect(
      shouldParseSessionFileForStatSkip({
        ...base,
        currentStat: { mtimeMs: 100, size: 11 },
        knownStat: known,
      }),
    ).toBe(true);
  });

  it("re-parses when mtime changed at the same size (covers the .15 evictor rewrite)", () => {
    expect(
      shouldParseSessionFileForStatSkip({
        ...base,
        currentStat: { mtimeMs: 200, size: 10 },
        knownStat: known,
      }),
    ).toBe(true);
  });

  it("re-parses a first-seen file (no stored row)", () => {
    expect(
      shouldParseSessionFileForStatSkip({
        ...base,
        currentStat: { mtimeMs: 100, size: 10 },
        knownStat: undefined,
      }),
    ).toBe(true);
  });

  it("re-parses on a failed stat (fail-open, never skips on unknown state)", () => {
    expect(
      shouldParseSessionFileForStatSkip({ ...base, currentStat: null, knownStat: known }),
    ).toBe(true);
  });

  it("re-parses dirty files even when the stat matches", () => {
    expect(
      shouldParseSessionFileForStatSkip({
        forceFullReparse: false,
        isDirty: true,
        currentStat: { mtimeMs: 100, size: 10 },
        knownStat: known,
      }),
    ).toBe(true);
  });

  it("re-parses everything under an explicit/targeted reindex", () => {
    expect(
      shouldParseSessionFileForStatSkip({
        forceFullReparse: true,
        isDirty: false,
        currentStat: { mtimeMs: 100, size: 10 },
        knownStat: known,
      }),
    ).toBe(true);
  });
});
