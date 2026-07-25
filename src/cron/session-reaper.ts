/**
 * Cron session reaper — prunes completed isolated cron run sessions
 * from the session store after a configurable retention period.
 *
 * Pattern: sessions keyed as `...:cron:<jobId>:run:<uuid>` are ephemeral
 * run records. The base session (`...:cron:<jobId>`) is kept as-is.
 */

import { parseDurationMs } from "../cli/parse-duration.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import { archiveRemovedSessionTranscripts, updateSessionStore } from "../config/sessions/store.js";
import type { CronConfig } from "../config/types.cron.js";
import { cleanupArchivedSessionTranscripts } from "../gateway/session-utils.fs.js";
import { isCronRunSessionKey, parseCronBaseJobId } from "../sessions/session-key-utils.js";
import type { Logger } from "./service/state.js";
import { selectStaleBaseCronKeys } from "./stale-base-cron.js";

const DEFAULT_RETENTION_MS = 24 * 3_600_000; // 24 hours

/** Minimum interval between reaper sweeps (avoid running every timer tick). */
const MIN_SWEEP_INTERVAL_MS = 5 * 60_000; // 5 minutes

const lastSweepAtMsByStore = new Map<string, number>();

export function resolveRetentionMs(cronConfig?: CronConfig): number | null {
  if (cronConfig?.sessionRetention === false) {
    return null; // pruning disabled
  }
  const raw = cronConfig?.sessionRetention;
  if (typeof raw === "string" && raw.trim()) {
    try {
      return parseDurationMs(raw.trim(), { defaultUnit: "h" });
    } catch {
      return DEFAULT_RETENTION_MS;
    }
  }
  return DEFAULT_RETENTION_MS;
}

export type ReaperResult = {
  swept: boolean;
  pruned: number;
};

/** Kill switch: OPENCLAW_CRON_BASE_SESSION_REAP=off (or 0) disables base cron pruning. */
function isBaseCronReapEnabled(): boolean {
  const raw = process.env.OPENCLAW_CRON_BASE_SESSION_REAP;
  return raw !== "off" && raw !== "0";
}

/**
 * Sweep the session store and prune expired cron sessions.
 * Designed to be called from the cron timer tick — self-throttles via
 * MIN_SWEEP_INTERVAL_MS to avoid excessive I/O.
 *
 * Two independent prunes share one lock + one save:
 *  - Run records (`...:cron:<jobId>:run:<uuid>`): pruned by time (retentionMs).
 *  - Base entries (`...:cron:<jobId>`): pruned by cron registry — an entry is
 *    removed only when its jobId is absent from `liveJobIds`. Base pruning runs
 *    only when the caller passes `liveJobIds` (the authoritative live set); it
 *    is never time-based, and it is independent of `sessionRetention` (which
 *    only governs the time-based run pruning) so orphaned base entries are
 *    cleaned even when run retention is disabled.
 *
 * Lock ordering: this function acquires the session-store file lock via
 * `updateSessionStore`. It must be called OUTSIDE of the cron service's
 * own `locked()` section to avoid lock-order inversions. The cron timer
 * calls this after all `locked()` sections have been released.
 */
export async function sweepCronRunSessions(params: {
  cronConfig?: CronConfig;
  /** Resolved path to sessions.json — required. */
  sessionStorePath: string;
  /**
   * Authoritative set of live cron jobIds. When provided, base cron entries
   * whose jobId is absent are pruned. Omit to skip base pruning entirely — the
   * caller must be certain this is the full, loaded set, or live sessions would
   * be dropped.
   */
  liveJobIds?: ReadonlySet<string>;
  nowMs?: number;
  log: Logger;
  /** Override for testing — skips the min-interval throttle. */
  force?: boolean;
}): Promise<ReaperResult> {
  const now = params.nowMs ?? Date.now();
  const storePath = params.sessionStorePath;
  const lastSweepAtMs = lastSweepAtMsByStore.get(storePath) ?? 0;

  // Throttle: don't sweep more often than every 5 minutes.
  if (!params.force && now - lastSweepAtMs < MIN_SWEEP_INTERVAL_MS) {
    return { swept: false, pruned: 0 };
  }

  const retentionMs = resolveRetentionMs(params.cronConfig);
  const baseReapEnabled = params.liveJobIds !== undefined && isBaseCronReapEnabled();
  if (retentionMs === null && !baseReapEnabled) {
    lastSweepAtMsByStore.set(storePath, now);
    return { swept: false, pruned: 0 };
  }

  let pruned = 0;
  const prunedSessions = new Map<string, string | undefined>();
  try {
    await updateSessionStore(storePath, (store) => {
      if (retentionMs !== null) {
        const cutoff = now - retentionMs;
        for (const key of Object.keys(store)) {
          if (!isCronRunSessionKey(key)) {
            continue;
          }
          const entry = store[key];
          if (!entry) {
            continue;
          }
          const updatedAt = entry.updatedAt ?? 0;
          if (updatedAt < cutoff) {
            if (!prunedSessions.has(entry.sessionId) || entry.sessionFile) {
              prunedSessions.set(entry.sessionId, entry.sessionFile);
            }
            delete store[key];
            pruned++;
          }
        }
      }
      if (baseReapEnabled && params.liveJobIds) {
        for (const key of selectStaleBaseCronKeys({ store, liveJobIds: params.liveJobIds })) {
          const entry = store[key];
          if (!entry) {
            continue;
          }
          params.log.info(
            { key, jobId: parseCronBaseJobId(key), sessionFile: entry.sessionFile },
            "cron-reaper: pruning orphaned base cron session (jobId no longer registered)",
          );
          if (!prunedSessions.has(entry.sessionId) || entry.sessionFile) {
            prunedSessions.set(entry.sessionId, entry.sessionFile);
          }
          delete store[key];
          pruned++;
        }
      }
    });
  } catch (err) {
    params.log.warn({ err: String(err) }, "cron-reaper: failed to sweep session store");
    return { swept: false, pruned: 0 };
  }

  lastSweepAtMsByStore.set(storePath, now);

  if (prunedSessions.size > 0) {
    try {
      const store = loadSessionStore(storePath, { skipCache: true });
      const referencedSessionIds = new Set(
        Object.values(store)
          .map((entry) => entry?.sessionId)
          .filter((id): id is string => Boolean(id)),
      );
      const archivedDirs = await archiveRemovedSessionTranscripts({
        removedSessionFiles: prunedSessions,
        referencedSessionIds,
        storePath,
        reason: "deleted",
        restrictToStoreDir: true,
      });
      if (archivedDirs.size > 0) {
        await cleanupArchivedSessionTranscripts({
          directories: [...archivedDirs],
          // Base-only sweeps run with run-retention disabled (retentionMs null);
          // fall back to the default retention for archive cleanup age.
          olderThanMs: retentionMs ?? DEFAULT_RETENTION_MS,
          reason: "deleted",
          nowMs: now,
        });
      }
    } catch (err) {
      params.log.warn({ err: String(err) }, "cron-reaper: transcript cleanup failed");
    }
  }

  if (pruned > 0) {
    params.log.info({ pruned, retentionMs }, `cron-reaper: pruned ${pruned} cron session(s)`);
  }

  return { swept: true, pruned };
}

/** Reset the throttle timer (for tests). */
export function resetReaperThrottle(): void {
  lastSweepAtMsByStore.clear();
}
