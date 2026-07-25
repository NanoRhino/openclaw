import { describe, it, expect } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { parseCronBaseJobId } from "../sessions/session-key-utils.js";
import { selectStaleBaseCronKeys } from "./stale-base-cron.js";

function entry(): SessionEntry {
  return { sessionId: "sid", updatedAt: 1 };
}

describe("parseCronBaseJobId", () => {
  it("extracts jobId from a base cron session key", () => {
    expect(parseCronBaseJobId("agent:main:cron:abc-123")).toBe("abc-123");
    expect(parseCronBaseJobId("agent:050171:cron:249ecf82-aa11-bb22-cc33-dd44ee55ff66")).toBe(
      "249ecf82-aa11-bb22-cc33-dd44ee55ff66",
    );
  });

  it("preserves original jobId case (for CronJob.id comparison)", () => {
    // parseAgentSessionKey lowercases; parseCronBaseJobId must not, so callers
    // can compare against raw CronJob.id values.
    expect(parseCronBaseJobId("agent:main:cron:ABC-123")).toBe("ABC-123");
  });

  it("returns null for run-record keys (only base entries match)", () => {
    expect(parseCronBaseJobId("agent:main:cron:abc-123:run:def-456")).toBeNull();
  });

  it("returns null for deeper cron-derived keys (thread/subagent children)", () => {
    expect(parseCronBaseJobId("agent:main:cron:abc-123:thread:9")).toBeNull();
    expect(parseCronBaseJobId("agent:main:cron:abc-123:subagent:leaf")).toBeNull();
  });

  it("returns null for non-cron and malformed keys", () => {
    expect(parseCronBaseJobId("agent:main:telegram:dm:123")).toBeNull();
    expect(parseCronBaseJobId("agent:main:cron")).toBeNull();
    expect(parseCronBaseJobId("cron:abc-123")).toBeNull();
    expect(parseCronBaseJobId("")).toBeNull();
    expect(parseCronBaseJobId(undefined)).toBeNull();
    expect(parseCronBaseJobId(null)).toBeNull();
  });
});

describe("selectStaleBaseCronKeys", () => {
  it("selects base cron entries whose jobId is not live", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:cron:dead-1": entry(),
      "agent:main:cron:live-1": entry(),
      "agent:main:cron:dead-2": entry(),
    };
    const stale = selectStaleBaseCronKeys({
      store,
      liveJobIds: new Set(["live-1"]),
    });
    expect(stale.toSorted()).toEqual(["agent:main:cron:dead-1", "agent:main:cron:dead-2"]);
  });

  it("keeps base cron entries whose jobId is live", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:cron:live-1": entry(),
    };
    expect(selectStaleBaseCronKeys({ store, liveJobIds: new Set(["live-1"]) })).toEqual([]);
  });

  it("never selects run records — those are the time-based reaper's job", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:cron:dead-1:run:uuid-1": entry(),
    };
    expect(selectStaleBaseCronKeys({ store, liveJobIds: new Set() })).toEqual([]);
  });

  it("never selects non-cron sessions even with an empty live set", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:telegram:dm:123": entry(),
      "agent:main:main": entry(),
    };
    expect(selectStaleBaseCronKeys({ store, liveJobIds: new Set() })).toEqual([]);
  });

  it("selects every base cron entry when there are no live jobs (valid empty state)", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:cron:dead-1": entry(),
      "agent:main:cron:dead-2": entry(),
    };
    expect(selectStaleBaseCronKeys({ store, liveJobIds: new Set() }).toSorted()).toEqual([
      "agent:main:cron:dead-1",
      "agent:main:cron:dead-2",
    ]);
  });

  it("matches jobId case-insensitively against the live set", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:cron:ABC-123": entry(),
    };
    // Live set carries a differently-cased id; the entry must still be treated
    // as live and kept.
    expect(selectStaleBaseCronKeys({ store, liveJobIds: new Set(["abc-123"]) })).toEqual([]);
  });
});
