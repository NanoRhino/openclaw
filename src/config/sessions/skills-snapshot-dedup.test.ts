import { afterEach, describe, expect, it } from "vitest";
import { applySkillEnvOverridesFromSnapshot } from "../../agents/skills/env-overrides.js";
import {
  dehydrateSkillSnapshotsForSerialize,
  hydrateSkillSnapshots,
} from "./skills-snapshot-dedup.js";
import type { SessionEntry, SessionSkillSnapshot } from "./types.js";

/** Fresh snapshot object each call (distinct reference), content keyed by tag+version. */
function makeSnapshot(tag: string, version = 3): SessionSkillSnapshot {
  return {
    prompt: `PROMPT-${tag}-${"x".repeat(40)}`,
    skills: [{ name: "logger", primaryEnv: "LOG", requiredEnv: ["A", "B"] }],
    skillFilter: ["logger"],
    version,
  };
}

function makeEntry(sessionId: string, snapshot?: SessionSkillSnapshot): SessionEntry {
  const entry: SessionEntry = { sessionId, updatedAt: 1 };
  if (snapshot) {
    entry.skillsSnapshot = snapshot;
  }
  return entry;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/** Round-trip through disk: dehydrate → serialize → parse → hydrate. */
function roundTrip(store: Record<string, SessionEntry>): {
  serialized: string;
  hydrated: Record<string, SessionEntry>;
} {
  const serialized = JSON.stringify(dehydrateSkillSnapshotsForSerialize(store));
  const hydrated = JSON.parse(serialized) as Record<string, SessionEntry>;
  hydrateSkillSnapshots(hydrated);
  return { serialized, hydrated };
}

afterEach(() => {
  delete process.env.OPENCLAW_SKILLS_SNAPSHOT_DEDUP;
});

describe("skillsSnapshot dedup — round-trip content preservation", () => {
  it("preserves every entry's snapshot content byte-for-byte through a round-trip", () => {
    const shared = makeSnapshot("shared");
    const store: Record<string, SessionEntry> = {
      "agent:m:cron:b": makeEntry("s2", makeSnapshot("shared")),
      "agent:m:cron:a": makeEntry("s1", makeSnapshot("shared")),
      "agent:m:main": makeEntry("s0", makeSnapshot("shared")),
      "agent:m:cron:c": makeEntry("s3", makeSnapshot("other")),
      "agent:m:telegram:dm:1": makeEntry("s4"),
    };
    // Snapshot the expected content before dedup.
    const expected = Object.fromEntries(
      Object.entries(store).map(([k, e]) => [k, e.skillsSnapshot ?? null]),
    );

    const { hydrated } = roundTrip(store);

    for (const [key, snap] of Object.entries(expected)) {
      expect(hydrated[key]?.skillsSnapshot ?? null).toEqual(snap);
      // Ref field must never survive into the hydrated (live) store.
      expect(hydrated[key]?.skillsSnapshotRef).toBeUndefined();
    }
    void shared;
  });

  it("keeps one inline holder (min sessionKey) and refs the rest", () => {
    const store: Record<string, SessionEntry> = {
      "agent:m:cron:b": makeEntry("s2", makeSnapshot("shared")),
      "agent:m:cron:a": makeEntry("s1", makeSnapshot("shared")),
      "agent:m:main": makeEntry("s0", makeSnapshot("shared")),
    };
    const dehydrated = dehydrateSkillSnapshotsForSerialize(store);

    // Holder = smallest sessionKey ("agent:m:cron:a").
    expect(dehydrated["agent:m:cron:a"].skillsSnapshot).toBeDefined();
    expect(dehydrated["agent:m:cron:a"].skillsSnapshotRef).toBeUndefined();
    for (const key of ["agent:m:cron:b", "agent:m:main"]) {
      expect(dehydrated[key].skillsSnapshot).toBeUndefined();
      expect(dehydrated[key].skillsSnapshotRef).toBe("agent:m:cron:a");
    }
    // Serialized output holds exactly one inline snapshot.
    const inlineCount = Object.values(dehydrated).filter((e) => e.skillsSnapshot).length;
    expect(inlineCount).toBe(1);
  });

  it("leaves singletons and distinct snapshots inline (no refs)", () => {
    const store: Record<string, SessionEntry> = {
      "agent:m:a": makeEntry("s0", makeSnapshot("one")),
      "agent:m:b": makeEntry("s1", makeSnapshot("two")),
    };
    const dehydrated = dehydrateSkillSnapshotsForSerialize(store);
    expect(dehydrated["agent:m:a"].skillsSnapshot).toBeDefined();
    expect(dehydrated["agent:m:b"].skillsSnapshot).toBeDefined();
    expect(dehydrated["agent:m:a"].skillsSnapshotRef).toBeUndefined();
    expect(dehydrated["agent:m:b"].skillsSnapshotRef).toBeUndefined();
  });

  it("returns the input unchanged when nothing is shared (old-output parity)", () => {
    const store: Record<string, SessionEntry> = {
      "agent:m:a": makeEntry("s0", makeSnapshot("one")),
      "agent:m:b": makeEntry("s1"),
    };
    expect(dehydrateSkillSnapshotsForSerialize(store)).toBe(store);
  });
});

describe("skillsSnapshot dedup — determinism (byte-stable output)", () => {
  it("serializes byte-identically across repeated saves of the same state", () => {
    const store: Record<string, SessionEntry> = {
      "agent:m:cron:b": makeEntry("s2", makeSnapshot("shared")),
      "agent:m:cron:a": makeEntry("s1", makeSnapshot("shared")),
    };
    const a = JSON.stringify(dehydrateSkillSnapshotsForSerialize(store));
    const b = JSON.stringify(dehydrateSkillSnapshotsForSerialize(store));
    expect(a).toBe(b);
  });

  it("is a byte fixed point across load→save cycles", () => {
    const store: Record<string, SessionEntry> = {
      "agent:m:cron:b": makeEntry("s2", makeSnapshot("shared")),
      "agent:m:cron:a": makeEntry("s1", makeSnapshot("shared")),
      "agent:m:main": makeEntry("s0", makeSnapshot("shared")),
    };
    const d0 = JSON.stringify(dehydrateSkillSnapshotsForSerialize(store));
    const s1 = JSON.parse(d0) as Record<string, SessionEntry>;
    hydrateSkillSnapshots(s1);
    const d1 = JSON.stringify(dehydrateSkillSnapshotsForSerialize(s1));
    expect(d1).toBe(d0);
  });
});

describe("skillsSnapshot dedup — in-memory sharing (structuredClone benefit)", () => {
  it("hydrate makes content-equal entries share one snapshot object", () => {
    const store: Record<string, SessionEntry> = {
      "agent:m:a": makeEntry("s0", makeSnapshot("shared")),
      "agent:m:b": makeEntry("s1", makeSnapshot("shared")),
      "agent:m:c": makeEntry("s2", makeSnapshot("other")),
    };
    hydrateSkillSnapshots(store);
    expect(store["agent:m:a"].skillsSnapshot).toBe(store["agent:m:b"].skillsSnapshot);
    expect(store["agent:m:a"].skillsSnapshot).not.toBe(store["agent:m:c"].skillsSnapshot);
  });

  it("structuredClone preserves the shared reference (one clone per distinct snapshot)", () => {
    const store: Record<string, SessionEntry> = {
      "agent:m:a": makeEntry("s0", makeSnapshot("shared")),
      "agent:m:b": makeEntry("s1", makeSnapshot("shared")),
    };
    hydrateSkillSnapshots(store);
    const cloned = structuredClone(store);
    expect(cloned["agent:m:a"].skillsSnapshot).toBe(cloned["agent:m:b"].skillsSnapshot);
    expect(cloned["agent:m:a"].skillsSnapshot).not.toBe(store["agent:m:a"].skillsSnapshot);
  });
});

describe("skillsSnapshot dedup — aliasing safety (frozen shared object)", () => {
  it("the dedup pipeline never mutates snapshots (frozen input round-trips)", () => {
    const store: Record<string, SessionEntry> = {
      "agent:m:a": makeEntry("s0", makeSnapshot("shared")),
      "agent:m:b": makeEntry("s1", makeSnapshot("shared")),
    };
    hydrateSkillSnapshots(store);
    deepFreeze(store["agent:m:a"].skillsSnapshot);
    // Serialize + reload while the shared object is frozen — any in-place write throws.
    expect(() => roundTrip(store)).not.toThrow();
  });

  it("a frozen shared snapshot passes through applySkillEnvOverridesFromSnapshot unmutated", () => {
    const snapshot = deepFreeze(makeSnapshot("shared"));
    // Real consumer of an entry.skillsSnapshot — must treat it read-only.
    const revert = applySkillEnvOverridesFromSnapshot({ snapshot });
    expect(typeof revert).toBe("function");
    revert();
  });

  it("freeze is deep enough to catch an in-place mutation (guard sanity)", () => {
    const snapshot = deepFreeze(makeSnapshot("shared"));
    expect(() => snapshot.skills.push({ name: "x" })).toThrow();
  });
});

describe("skillsSnapshot dedup — rollback safety", () => {
  it("old loader (no hydrate) reading a deduped file finds ref entries' snapshot undefined", () => {
    const store: Record<string, SessionEntry> = {
      "agent:m:cron:a": makeEntry("s1", makeSnapshot("shared")),
      "agent:m:cron:b": makeEntry("s2", makeSnapshot("shared")),
    };
    const serialized = JSON.stringify(dehydrateSkillSnapshotsForSerialize(store));
    // Simulate old .15 loadSessionStore: JSON.parse only, NO hydrate step.
    const oldView = JSON.parse(serialized) as Record<string, SessionEntry>;

    // Holder keeps a usable snapshot; ref entry has none, so old code rebuilds
    // it (coach not disabled) — the ref field is present but ignored.
    expect(oldView["agent:m:cron:a"].skillsSnapshot).toBeDefined();
    expect(oldView["agent:m:cron:b"].skillsSnapshot).toBeUndefined();
    expect(oldView["agent:m:cron:b"].skillsSnapshotRef).toBe("agent:m:cron:a");
  });
});

describe("skillsSnapshot dedup — kill switch", () => {
  it("OPENCLAW_SKILLS_SNAPSHOT_DEDUP=off serializes full inline and hydrate is a no-op", () => {
    process.env.OPENCLAW_SKILLS_SNAPSHOT_DEDUP = "off";
    const store: Record<string, SessionEntry> = {
      "agent:m:a": makeEntry("s0", makeSnapshot("shared")),
      "agent:m:b": makeEntry("s1", makeSnapshot("shared")),
    };
    const dehydrated = dehydrateSkillSnapshotsForSerialize(store);
    expect(dehydrated).toBe(store);
    expect(dehydrated["agent:m:a"].skillsSnapshot).toBeDefined();
    expect(dehydrated["agent:m:b"].skillsSnapshot).toBeDefined();

    // hydrate no-op: content-equal entries stay distinct objects.
    hydrateSkillSnapshots(store);
    expect(store["agent:m:a"].skillsSnapshot).not.toBe(store["agent:m:b"].skillsSnapshot);
  });
});

describe("skillsSnapshot dedup — existing-store migration", () => {
  it("dedups an all-inline store of distinct objects to one holder on first serialize", () => {
    // Simulate a prod store parsed from disk: many DISTINCT but content-equal
    // snapshot objects (JSON.parse yields a fresh object per entry).
    const store: Record<string, SessionEntry> = {};
    for (let i = 0; i < 42; i++) {
      store[`agent:m:cron:job${String(i).padStart(2, "0")}`] = makeEntry(
        `s${i}`,
        makeSnapshot("shared"),
      );
    }
    const expected = Object.fromEntries(
      Object.entries(store).map(([k, e]) => [k, e.skillsSnapshot]),
    );

    hydrateSkillSnapshots(store); // canonicalize distinct objects → shared
    const { serialized, hydrated } = roundTrip(store);

    const parsedDisk = JSON.parse(serialized) as Record<string, SessionEntry>;
    const inlineCount = Object.values(parsedDisk).filter((e) => e.skillsSnapshot).length;
    expect(inlineCount).toBe(1);
    for (const [key, snap] of Object.entries(expected)) {
      expect(hydrated[key].skillsSnapshot).toEqual(snap);
    }
  });
});

describe("skillsSnapshot dedup — fail-open", () => {
  it("a dangling ref hydrates to undefined snapshot without throwing", () => {
    const store: Record<string, SessionEntry> = {
      "agent:m:b": { sessionId: "s2", updatedAt: 1, skillsSnapshotRef: "agent:m:missing" },
    };
    expect(() => hydrateSkillSnapshots(store)).not.toThrow();
    expect(store["agent:m:b"].skillsSnapshot).toBeUndefined();
    expect(store["agent:m:b"].skillsSnapshotRef).toBeUndefined();
  });
});
