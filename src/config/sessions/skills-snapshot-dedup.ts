/**
 * skillsSnapshot store deduplication (hydrate-on-load / dehydrate-on-serialize).
 *
 * Every SessionEntry can carry a ~60KB `skillsSnapshot`. Within one agent's
 * store dozens of entries (main + one base entry per cron job) hold a snapshot
 * that is byte-identical per workspace+version+skillFilter, so the store bloats
 * to megabytes. That cost lands on the hot path twice: on disk (JSON
 * parse/stringify per save) and in memory (`loadSessionStore` structuredClones
 * the whole store on every call).
 *
 * Strategy (team-lead pick A): store one inline copy per distinct snapshot and
 * a `skillsSnapshotRef` on the rest — but ONLY on disk and in the serialized
 * cache. On load we immediately HYDRATE: every entry gets a full `skillsSnapshot`
 * again, and all entries sharing content point at ONE object. structuredClone
 * preserves shared references within a single clone, so the whole-store clone
 * copies each distinct snapshot once instead of N times. Because the in-memory
 * store is always fully hydrated, none of the ~9 snapshot readers change and
 * deleting any entry can never orphan a ref (no holder-relay needed).
 *
 * Correctness invariant (the "coach must not silently lose skills" gate):
 * dehydrate replaces an entry's snapshot with a ref ONLY when an inline holder
 * with byte-identical content (same canonical JSON) exists, and hydrate restores
 * that holder's content. So hydrate(dehydrate(store)) preserves every entry's
 * snapshot content exactly.
 *
 * Aliasing safety: after hydrate, entries share snapshot objects, so in-place
 * mutation of a snapshot would corrupt every sharer. An audit confirmed all
 * readers treat the snapshot as read-only / whole-object-replace; the freeze
 * test in skills-snapshot-dedup.test.ts locks that invariant.
 *
 * Kill switch: OPENCLAW_SKILLS_SNAPSHOT_DEDUP=off (or 0) makes hydrate a no-op
 * and serializes full inline snapshots everywhere (old behavior).
 */

import type { SessionEntry, SessionSkillSnapshot } from "./types.js";

/** Kill switch: OPENCLAW_SKILLS_SNAPSHOT_DEDUP=off (or 0) restores full inline snapshots. */
export function isSkillsSnapshotDedupEnabled(): boolean {
  const raw = process.env.OPENCLAW_SKILLS_SNAPSHOT_DEDUP;
  return raw !== "off" && raw !== "0";
}

/**
 * Canonical grouping key for a snapshot = its JSON serialization. Two snapshots
 * are dedup-eligible iff their canonical JSON is byte-identical, so restoring a
 * ref can never yield different content than the entry originally held (no hash
 * collision risk — we compare the full serialization, not a digest). Memoized
 * per snapshot object reference so the shared object produced by hydrate is
 * stringified at most once per pass.
 */
function makeSnapshotKeyer(): (snap: SessionSkillSnapshot) => string {
  const memo = new WeakMap<SessionSkillSnapshot, string>();
  return (snap) => {
    const cached = memo.get(snap);
    if (cached !== undefined) {
      return cached;
    }
    const key = JSON.stringify(snap);
    memo.set(snap, key);
    return key;
  };
}

/**
 * Resolve `skillsSnapshotRef` entries back to full snapshots and canonicalize
 * content-equal snapshots to a single shared object, IN PLACE. Runs right after
 * JSON.parse, before any load-time maintenance, so a ref always resolves against
 * the complete parsed file.
 *
 * Fail-open: a dangling ref (missing/corrupt holder, or a file written by a
 * newer format then read here) leaves `skillsSnapshot` undefined so the runner
 * rebuilds it — the coach is never disabled, only slightly slower for one turn.
 */
export function hydrateSkillSnapshots(store: Record<string, SessionEntry>): void {
  if (!isSkillsSnapshotDedupEnabled()) {
    return;
  }
  const keyOf = makeSnapshotKeyer();

  // Pass 1: pick one canonical shared object per content key from inline snapshots.
  const canonicalByKey = new Map<string, SessionSkillSnapshot>();
  for (const key of Object.keys(store)) {
    const snap = store[key]?.skillsSnapshot;
    if (snap) {
      const contentKey = keyOf(snap);
      if (!canonicalByKey.has(contentKey)) {
        canonicalByKey.set(contentKey, snap);
      }
    }
  }

  // Pass 2: canonicalize inline snapshots to the shared object, resolve refs,
  // and strip the (serialization-only) ref field from the live store.
  for (const key of Object.keys(store)) {
    const entry = store[key];
    if (!entry) {
      continue;
    }
    if (entry.skillsSnapshot) {
      const canonical = canonicalByKey.get(keyOf(entry.skillsSnapshot));
      if (canonical && canonical !== entry.skillsSnapshot) {
        entry.skillsSnapshot = canonical;
      }
      if (entry.skillsSnapshotRef !== undefined) {
        // Stale ref carried through an old-code round-trip; inline wins.
        delete entry.skillsSnapshotRef;
      }
      continue;
    }
    if (entry.skillsSnapshotRef !== undefined) {
      const holderSnap = store[entry.skillsSnapshotRef]?.skillsSnapshot;
      if (holderSnap) {
        entry.skillsSnapshot = canonicalByKey.get(keyOf(holderSnap)) ?? holderSnap;
      }
      delete entry.skillsSnapshotRef;
    }
  }
}

/**
 * Produce a serialization view of the store where, for each group of entries
 * whose `skillsSnapshot` content is identical, one holder keeps the inline
 * snapshot and the rest carry only `skillsSnapshotRef = <holderSessionKey>`.
 * Does NOT mutate the input store (returns a new top-level object; holder,
 * singleton, and snapshot-less entries are referenced, not copied).
 *
 * The holder is the smallest sessionKey in each content group, so the same
 * in-memory state serializes to byte-identical output across repeated saves.
 * Returns the input unchanged when the kill switch is off or no snapshot is
 * shared by 2+ entries (so the no-dedup case is byte-identical to old output).
 */
export function dehydrateSkillSnapshotsForSerialize(
  store: Record<string, SessionEntry>,
): Record<string, SessionEntry> {
  if (!isSkillsSnapshotDedupEnabled()) {
    return store;
  }
  const keyOf = makeSnapshotKeyer();

  const countByContent = new Map<string, number>();
  const holderKeyByContent = new Map<string, string>();
  for (const key of Object.keys(store)) {
    const snap = store[key]?.skillsSnapshot;
    if (!snap) {
      continue;
    }
    const contentKey = keyOf(snap);
    countByContent.set(contentKey, (countByContent.get(contentKey) ?? 0) + 1);
    const holder = holderKeyByContent.get(contentKey);
    if (holder === undefined || key < holder) {
      holderKeyByContent.set(contentKey, key);
    }
  }

  let hasDuplicate = false;
  for (const count of countByContent.values()) {
    if (count > 1) {
      hasDuplicate = true;
      break;
    }
  }
  if (!hasDuplicate) {
    return store;
  }

  const out: Record<string, SessionEntry> = {};
  for (const key of Object.keys(store)) {
    const entry = store[key];
    const snap = entry?.skillsSnapshot;
    if (!entry || !snap) {
      out[key] = entry;
      continue;
    }
    const contentKey = keyOf(snap);
    const holderKey = holderKeyByContent.get(contentKey);
    if ((countByContent.get(contentKey) ?? 0) > 1 && holderKey !== undefined && holderKey !== key) {
      const { skillsSnapshot: _snap, skillsSnapshotRef: _ref, ...rest } = entry;
      out[key] = { ...rest, skillsSnapshotRef: holderKey };
    } else {
      out[key] = entry;
    }
  }
  return out;
}
