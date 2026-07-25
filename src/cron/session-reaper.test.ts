import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import type { Logger } from "./service/state.js";
import { sweepCronRunSessions, resolveRetentionMs, resetReaperThrottle } from "./session-reaper.js";

function createTestLogger(): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

describe("resolveRetentionMs", () => {
  it("returns 24h default when no config", () => {
    expect(resolveRetentionMs()).toBe(24 * 3_600_000);
  });

  it("returns 24h default when config is empty", () => {
    expect(resolveRetentionMs({})).toBe(24 * 3_600_000);
  });

  it("parses duration string", () => {
    expect(resolveRetentionMs({ sessionRetention: "1h" })).toBe(3_600_000);
    expect(resolveRetentionMs({ sessionRetention: "7d" })).toBe(7 * 86_400_000);
    expect(resolveRetentionMs({ sessionRetention: "30m" })).toBe(30 * 60_000);
  });

  it("returns null when disabled", () => {
    expect(resolveRetentionMs({ sessionRetention: false })).toBeNull();
  });

  it("falls back to default on invalid string", () => {
    expect(resolveRetentionMs({ sessionRetention: "abc" })).toBe(24 * 3_600_000);
  });
});

describe("isCronRunSessionKey", () => {
  it("matches cron run session keys", () => {
    expect(isCronRunSessionKey("agent:main:cron:abc-123:run:def-456")).toBe(true);
    expect(isCronRunSessionKey("agent:debugger:cron:249ecf82:run:1102aabb")).toBe(true);
  });

  it("does not match base cron session keys", () => {
    expect(isCronRunSessionKey("agent:main:cron:abc-123")).toBe(false);
  });

  it("does not match regular session keys", () => {
    expect(isCronRunSessionKey("agent:main:telegram:dm:123")).toBe(false);
  });

  it("does not match non-canonical cron-like keys", () => {
    expect(isCronRunSessionKey("agent:main:slack:cron:job:run:uuid")).toBe(false);
    expect(isCronRunSessionKey("cron:job:run:uuid")).toBe(false);
  });
});

describe("sweepCronRunSessions", () => {
  let tmpDir: string;
  let storePath: string;
  const log = createTestLogger();

  beforeEach(async () => {
    resetReaperThrottle();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-reaper-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  it("prunes expired cron run sessions", async () => {
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:main:cron:job1": {
        sessionId: "base-session",
        updatedAt: now,
      },
      "agent:main:cron:job1:run:old-run": {
        sessionId: "old-run",
        updatedAt: now - 25 * 3_600_000, // 25h ago — expired
      },
      "agent:main:cron:job1:run:recent-run": {
        sessionId: "recent-run",
        updatedAt: now - 1 * 3_600_000, // 1h ago — not expired
      },
      "agent:main:telegram:dm:123": {
        sessionId: "regular-session",
        updatedAt: now - 100 * 3_600_000, // old but not a cron run
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.swept).toBe(true);
    expect(result.pruned).toBe(1);

    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated["agent:main:cron:job1"]).toBeDefined();
    expect(updated["agent:main:cron:job1:run:old-run"]).toBeUndefined();
    expect(updated["agent:main:cron:job1:run:recent-run"]).toBeDefined();
    expect(updated["agent:main:telegram:dm:123"]).toBeDefined();
  });

  it("archives transcript files for pruned run sessions that are no longer referenced", async () => {
    const now = Date.now();
    const runSessionId = "old-run";
    const runTranscript = path.join(tmpDir, `${runSessionId}.jsonl`);
    fs.writeFileSync(runTranscript, '{"type":"session"}\n');
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:main:cron:job1:run:old-run": {
        sessionId: runSessionId,
        updatedAt: now - 25 * 3_600_000,
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(1);
    expect(fs.existsSync(runTranscript)).toBe(false);
    const files = fs.readdirSync(tmpDir);
    expect(files.some((name) => name.startsWith(`${runSessionId}.jsonl.deleted.`))).toBe(true);
  });

  it("does not archive external transcript paths for pruned runs", async () => {
    const now = Date.now();
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-reaper-external-"));
    const externalTranscript = path.join(externalDir, "outside.jsonl");
    fs.writeFileSync(externalTranscript, '{"type":"session"}\n');
    const store: Record<string, { sessionId: string; sessionFile?: string; updatedAt: number }> = {
      "agent:main:cron:job1:run:old-run": {
        sessionId: "old-run",
        sessionFile: externalTranscript,
        updatedAt: now - 25 * 3_600_000,
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    try {
      const result = await sweepCronRunSessions({
        sessionStorePath: storePath,
        nowMs: now,
        log,
        force: true,
      });

      expect(result.pruned).toBe(1);
      expect(fs.existsSync(externalTranscript)).toBe(true);
    } finally {
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it("respects custom retention", async () => {
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:main:cron:job1:run:run1": {
        sessionId: "run1",
        updatedAt: now - 2 * 3_600_000, // 2h ago
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      cronConfig: { sessionRetention: "1h" },
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(1);
  });

  it("does nothing when pruning is disabled", async () => {
    const now = Date.now();
    const store: Record<string, { sessionId: string; updatedAt: number }> = {
      "agent:main:cron:job1:run:run1": {
        sessionId: "run1",
        updatedAt: now - 100 * 3_600_000,
      },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      cronConfig: { sessionRetention: false },
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    expect(result.swept).toBe(false);
    expect(result.pruned).toBe(0);
  });

  it("throttles sweeps without force", async () => {
    const now = Date.now();
    fs.writeFileSync(storePath, JSON.stringify({}));

    // First sweep runs
    const r1 = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
    });
    expect(r1.swept).toBe(true);

    // Second sweep (1 second later) is throttled
    const r2 = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now + 1000,
      log,
    });
    expect(r2.swept).toBe(false);
  });

  it("throttles per store path", async () => {
    const now = Date.now();
    const otherPath = path.join(tmpDir, "sessions-other.json");
    fs.writeFileSync(storePath, JSON.stringify({}));
    fs.writeFileSync(otherPath, JSON.stringify({}));

    const r1 = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
    });
    expect(r1.swept).toBe(true);

    const r2 = await sweepCronRunSessions({
      sessionStorePath: otherPath,
      nowMs: now + 1000,
      log,
    });
    expect(r2.swept).toBe(true);

    const r3 = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now + 1000,
      log,
    });
    expect(r3.swept).toBe(false);
  });
});

describe("sweepCronRunSessions — base cron pruning (registry-based)", () => {
  let tmpDir: string;
  let storePath: string;
  const log = createTestLogger();

  beforeEach(() => {
    resetReaperThrottle();
    delete process.env.OPENCLAW_CRON_BASE_SESSION_REAP;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cron-reaper-base-"));
    storePath = path.join(tmpDir, "sessions.json");
  });

  afterEach(() => {
    delete process.env.OPENCLAW_CRON_BASE_SESSION_REAP;
  });

  it("prunes base cron entries whose jobId is no longer live, keeps live ones", async () => {
    const now = Date.now();
    const store = {
      "agent:main:cron:live-1": { sessionId: "s-live", updatedAt: now },
      "agent:main:cron:dead-1": { sessionId: "s-dead", updatedAt: now },
      "agent:main:telegram:dm:123": { sessionId: "s-reg", updatedAt: now },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      liveJobIds: new Set(["live-1"]),
      nowMs: now,
      log,
      force: true,
    });

    expect(result.swept).toBe(true);
    expect(result.pruned).toBe(1);
    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated["agent:main:cron:live-1"]).toBeDefined();
    expect(updated["agent:main:cron:dead-1"]).toBeUndefined();
    expect(updated["agent:main:telegram:dm:123"]).toBeDefined();
  });

  it("does not touch base entries when liveJobIds is omitted (authoritative-set guard)", async () => {
    const now = Date.now();
    const store = {
      "agent:main:cron:dead-1": { sessionId: "s-dead", updatedAt: now },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      nowMs: now,
      log,
      force: true,
    });

    // No run records to prune and no liveJobIds → nothing removed.
    expect(result.pruned).toBe(0);
    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated["agent:main:cron:dead-1"]).toBeDefined();
  });

  it("prunes orphaned base entries even when run retention is disabled", async () => {
    const now = Date.now();
    const store = {
      "agent:main:cron:dead-1": { sessionId: "s-dead", updatedAt: now },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      cronConfig: { sessionRetention: false },
      sessionStorePath: storePath,
      liveJobIds: new Set(),
      nowMs: now,
      log,
      force: true,
    });

    expect(result.swept).toBe(true);
    expect(result.pruned).toBe(1);
    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated["agent:main:cron:dead-1"]).toBeUndefined();
  });

  it("kill switch OPENCLAW_CRON_BASE_SESSION_REAP=off disables base pruning", async () => {
    process.env.OPENCLAW_CRON_BASE_SESSION_REAP = "off";
    const now = Date.now();
    const store = {
      "agent:main:cron:dead-1": { sessionId: "s-dead", updatedAt: now },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      cronConfig: { sessionRetention: false },
      sessionStorePath: storePath,
      liveJobIds: new Set(),
      nowMs: now,
      log,
      force: true,
    });

    expect(result.swept).toBe(false);
    expect(result.pruned).toBe(0);
    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated["agent:main:cron:dead-1"]).toBeDefined();
  });

  it("prunes run records and orphaned base entries in a single sweep", async () => {
    const now = Date.now();
    const store = {
      "agent:main:cron:dead-1": { sessionId: "s-dead", updatedAt: now },
      "agent:main:cron:live-1": { sessionId: "s-live", updatedAt: now },
      "agent:main:cron:live-1:run:old": { sessionId: "s-run", updatedAt: now - 25 * 3_600_000 },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      liveJobIds: new Set(["live-1"]),
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(2);
    const updated = JSON.parse(fs.readFileSync(storePath, "utf-8"));
    expect(updated["agent:main:cron:dead-1"]).toBeUndefined();
    expect(updated["agent:main:cron:live-1"]).toBeDefined();
    expect(updated["agent:main:cron:live-1:run:old"]).toBeUndefined();
  });

  it("archives the transcript of a pruned orphaned base session", async () => {
    const now = Date.now();
    const baseSessionId = "s-dead";
    const transcript = path.join(tmpDir, `${baseSessionId}.jsonl`);
    fs.writeFileSync(transcript, '{"type":"session"}\n');
    const store = {
      "agent:main:cron:dead-1": { sessionId: baseSessionId, updatedAt: now },
    };
    fs.writeFileSync(storePath, JSON.stringify(store));

    const result = await sweepCronRunSessions({
      sessionStorePath: storePath,
      liveJobIds: new Set(),
      nowMs: now,
      log,
      force: true,
    });

    expect(result.pruned).toBe(1);
    expect(fs.existsSync(transcript)).toBe(false);
    const files = fs.readdirSync(tmpDir);
    expect(files.some((name) => name.startsWith(`${baseSessionId}.jsonl.deleted.`))).toBe(true);
  });
});
