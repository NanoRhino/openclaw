/**
 * One-shot de-bloat migration for existing session stores: rewrite a
 * sessions.json so identical skillsSnapshot copies collapse to one inline
 * holder + refs (see skills-snapshot-dedup.ts).
 *
 * Note: this is optional. Every normal save already dehydrates, so any active
 * store de-bloats on its next write (inbound / cron / route update), and
 * `openclaw sessions cleanup` rewrites through the same path. This helper exists
 * for an explicit, idempotent one-shot that also snapshots a `.pre-dedup` backup
 * before the first rewrite. Rollback stays safe regardless: old code reading a
 * deduped file rebuilds ref entries' snapshots.
 */

import fs from "node:fs";
import { dehydrateSkillSnapshotsForSerialize } from "./skills-snapshot-dedup.js";
import { loadSessionStore } from "./store-load.js";
import { saveSessionStore } from "./store.js";

export type SessionStoreDedupeResult =
  | { status: "missing" }
  | { status: "unreadable" }
  | { status: "skipped"; reason: "no-shared-snapshots" | "already-deduped" | "dedup-disabled" }
  | {
      status: "deduped";
      backupPath: string;
      backupCreated: boolean;
      beforeBytes: number;
      afterBytes: number;
    };

/**
 * De-bloat one session store file in place. Idempotent: a store already in
 * deduped form (or with no shared snapshots) is left untouched and no backup is
 * created. Only when the on-disk bytes would actually change does it snapshot a
 * `<storePath>.pre-dedup` backup (once — skipped if one already exists) and
 * rewrite via the normal locked save path.
 */
export async function dedupeSessionStoreFile(storePath: string): Promise<SessionStoreDedupeResult> {
  let current: string;
  try {
    current = fs.readFileSync(storePath, "utf-8");
  } catch {
    return { status: "missing" };
  }

  let store: Record<string, import("./types.js").SessionEntry>;
  try {
    store = loadSessionStore(storePath, { skipCache: true });
  } catch {
    return { status: "unreadable" };
  }

  const dehydrated = dehydrateSkillSnapshotsForSerialize(store);
  if (dehydrated === store) {
    // Kill switch off, or no snapshot is shared by 2+ entries — nothing to do.
    return {
      status: "skipped",
      reason:
        process.env.OPENCLAW_SKILLS_SNAPSHOT_DEDUP === "off" ||
        process.env.OPENCLAW_SKILLS_SNAPSHOT_DEDUP === "0"
          ? "dedup-disabled"
          : "no-shared-snapshots",
    };
  }

  const desired = JSON.stringify(dehydrated, null, 2);
  if (desired === current) {
    return { status: "skipped", reason: "already-deduped" };
  }

  const backupPath = `${storePath}.pre-dedup`;
  let backupCreated = false;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(storePath, backupPath);
    backupCreated = true;
  }

  // skipMaintenance: a de-bloat pass must not also prune/cap entries.
  await saveSessionStore(storePath, store, { skipMaintenance: true });

  return {
    status: "deduped",
    backupPath,
    backupCreated,
    beforeBytes: Buffer.byteLength(current),
    afterBytes: Buffer.byteLength(desired),
  };
}
