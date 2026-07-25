/**
 * Selection logic for pruning orphaned base cron session entries.
 *
 * Base cron sessions are keyed `agent:<agentId>:cron:<jobId>`. The time-based
 * run reaper (session-reaper.ts) only prunes `:run:<uuid>` records, never the
 * base entry, so one base entry per deleted cron job accumulates in the store
 * forever. Each carries a full skillsSnapshot, so a handful of dead jobs bloat
 * the store enough to make every O(store) operation (inbound record, memory
 * sync, health) slow.
 *
 * Selection is purely registry-based — never time-based: a base cron entry is
 * stale iff its jobId is absent from the live cron registry. jobIds are random
 * UUIDs that are never reused, so a dead jobId can never become live again;
 * there is no race in which a currently-dead jobId is a live job whose entry we
 * would wrongly drop.
 */

import type { SessionEntry } from "../config/sessions/types.js";
import { parseCronBaseJobId } from "../sessions/session-key-utils.js";

/**
 * Return the base cron session keys whose jobId is not present in `liveJobIds`.
 *
 * The caller MUST pass the authoritative, fully-loaded set of live cron jobIds.
 * An empty set is a valid "no cron jobs" state and correctly selects every base
 * cron entry; but a set that is empty because the cron store failed to load
 * would wrongly select live sessions — the caller is responsible for only
 * invoking this once the cron registry is known to be loaded.
 */
export function selectStaleBaseCronKeys(params: {
  store: Record<string, SessionEntry>;
  liveJobIds: ReadonlySet<string>;
}): string[] {
  const liveNormalized = new Set<string>();
  for (const id of params.liveJobIds) {
    liveNormalized.add(id.toLowerCase());
  }
  const stale: string[] = [];
  for (const key of Object.keys(params.store)) {
    const jobId = parseCronBaseJobId(key);
    if (!jobId) {
      continue;
    }
    if (!liveNormalized.has(jobId.toLowerCase())) {
      stale.push(key);
    }
  }
  return stale;
}
