import type { SQLInputValue } from "node:sqlite";
import type { MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

export type MemorySourceFileStateRow = {
  path: string;
  hash: string;
  /** Persisted fs mtime/size; may be null on rows written before they were tracked. */
  mtime?: number | null;
  size?: number | null;
};

export type MemorySourceFileStat = {
  mtime: number;
  size: number;
};

type MemorySourceStateDb = {
  prepare: (sql: string) => {
    all: (...args: SQLInputValue[]) => unknown;
    get: (...args: SQLInputValue[]) => unknown;
  };
};

// mtime/size are already persisted per file (see the INSERT in manager-embedding-ops);
// select them so the sync can stat-skip provably-unchanged files without re-parsing.
export const MEMORY_SOURCE_FILE_STATE_SQL = `SELECT path, hash, mtime, size FROM files WHERE source = ?`;
export const MEMORY_SOURCE_FILE_HASH_SQL = `SELECT hash FROM files WHERE path = ? AND source = ?`;

export function loadMemorySourceFileState(params: {
  db: MemorySourceStateDb;
  source: MemorySource;
}): {
  rows: MemorySourceFileStateRow[];
  hashes: Map<string, string>;
  stats: Map<string, MemorySourceFileStat>;
} {
  const rows = params.db.prepare(MEMORY_SOURCE_FILE_STATE_SQL).all(params.source) as
    | MemorySourceFileStateRow[]
    | undefined;
  const normalizedRows = rows ?? [];
  // Only rows with BOTH mtime and size are eligible for the stat-skip; a missing
  // value (null / legacy row) is left out so those files fail open to re-parse.
  const stats = new Map<string, MemorySourceFileStat>();
  for (const row of normalizedRows) {
    if (typeof row.mtime === "number" && typeof row.size === "number") {
      stats.set(row.path, { mtime: row.mtime, size: row.size });
    }
  }
  return {
    rows: normalizedRows,
    hashes: new Map(normalizedRows.map((row) => [row.path, row.hash])),
    stats,
  };
}

export function resolveMemorySourceExistingHash(params: {
  db: MemorySourceStateDb;
  source: MemorySource;
  path: string;
  existingHashes?: Map<string, string> | null;
}): string | undefined {
  if (params.existingHashes) {
    return params.existingHashes.get(params.path);
  }
  return (
    params.db.prepare(MEMORY_SOURCE_FILE_HASH_SQL).get(params.path, params.source) as
      | { hash: string }
      | undefined
  )?.hash;
}
