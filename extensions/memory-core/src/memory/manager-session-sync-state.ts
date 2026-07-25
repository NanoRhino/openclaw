import {
  type MemorySourceFileStat,
  type MemorySourceFileStateRow,
} from "./manager-source-state.js";

export function resolveMemorySessionSyncPlan(params: {
  needsFullReindex: boolean;
  files: string[];
  targetSessionFiles: Set<string> | null;
  sessionsDirtyFiles: Set<string>;
  existingRows?: MemorySourceFileStateRow[] | null;
  sessionPathForFile: (file: string) => string;
}): {
  activePaths: Set<string> | null;
  existingRows: MemorySourceFileStateRow[] | null;
  existingHashes: Map<string, string> | null;
  existingStats: Map<string, MemorySourceFileStat> | null;
  indexAll: boolean;
} {
  const activePaths = params.targetSessionFiles
    ? null
    : new Set(params.files.map((file) => params.sessionPathForFile(file)));
  const existingRows = activePaths === null ? null : (params.existingRows ?? []);
  const existingStats = existingRows
    ? new Map(
        existingRows
          .filter((row) => typeof row.mtime === "number" && typeof row.size === "number")
          .map((row) => [row.path, { mtime: row.mtime as number, size: row.size as number }]),
      )
    : null;
  return {
    activePaths,
    existingRows,
    existingHashes: existingRows ? new Map(existingRows.map((row) => [row.path, row.hash])) : null,
    existingStats,
    // Explicit/targeted reindex forces a true full re-parse. The old code also
    // forced this whenever there were no dirty files (routine session-start /
    // interval sync), which re-parsed EVERY transcript every turn. That is now
    // handled by the per-file stat-skip below (shouldParseSessionFileForStatSkip)
    // -- kept here only for the kill-switch fallback path.
    indexAll:
      params.needsFullReindex ||
      Boolean(params.targetSessionFiles) ||
      params.sessionsDirtyFiles.size === 0,
  };
}

/**
 * Fail-open per-file decision for the routine-sync stat-skip. A file is parsed
 * unless it is PROVABLY unchanged (a stored mtime+size that exactly matches the
 * current stat). Everything uncertain re-parses:
 * - explicit/targeted reindex -> parse
 * - marked dirty by the transcript-write hook -> parse
 * - stat failed (null) -> parse (never skip on an unreadable stat)
 * - no stored row (first-seen / legacy null mtime|size) -> parse
 * - mtime OR size differs (append, external rewrite incl. the .15 evictor,
 *   change-while-process-was-down) -> parse
 * Only an exact mtime+size match skips the read.
 */
export function shouldParseSessionFileForStatSkip(params: {
  forceFullReparse: boolean;
  isDirty: boolean;
  currentStat: { mtimeMs: number; size: number } | null;
  knownStat: MemorySourceFileStat | undefined;
}): boolean {
  if (params.forceFullReparse || params.isDirty) {
    return true;
  }
  if (!params.currentStat || !params.knownStat) {
    return true;
  }
  return (
    params.currentStat.mtimeMs !== params.knownStat.mtime ||
    params.currentStat.size !== params.knownStat.size
  );
}
