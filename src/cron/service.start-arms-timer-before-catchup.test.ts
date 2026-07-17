import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCronStoreHarness, createNoopLogger } from "./service.test-harness.js";
import { start } from "./service/ops.js";
import { createCronServiceState } from "./service/state.js";
import { stopTimer } from "./service/timer.js";
import type { CronJob } from "./types.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-start-arm-" });

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Past-due isolated agentTurn job: startup catch-up picks it up and runs it via
// runIsolatedAgentJob, which we hang to simulate a wedged catch-up turn.
function createOverdueIsolatedJob(id: string, nowMs: number): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: nowMs - 10 * 60_000,
    updatedAtMs: nowMs - 10 * 60_000,
    schedule: { kind: "every", everyMs: 5 * 60_000, anchorMs: nowMs - 10 * 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "monitor" },
    delivery: { mode: "none" },
    state: { nextRunAtMs: nowMs - 60_000 },
  };
}

describe("cron start arms the scheduler before startup catch-up", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("arms the timer even when a startup catch-up agent turn hangs", async () => {
    const store = await makeStorePath();
    const now = Date.parse("2026-02-06T10:05:00.000Z");
    const hung = createDeferred<{ status: "ok"; summary: string }>();

    await fs.mkdir(path.dirname(store.storePath), { recursive: true });
    await fs.writeFile(
      store.storePath,
      JSON.stringify(
        { version: 1, jobs: [createOverdueIsolatedJob("overdue-monitor", now)] },
        null,
        2,
      ),
      "utf-8",
    );

    // Never resolves: a catch-up agentTurn wedged inside the 60-minute safety
    // timeout. Before the decoupling, armTimer sat behind `await
    // runMissedJobs(...)`, so a single hung catch-up job left the scheduler
    // unarmed and silent until the next gateway restart.
    const runIsolatedAgentJob = vi.fn(async () => await hung.promise);
    const state = createCronServiceState({
      storePath: store.storePath,
      cronEnabled: true,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: runIsolatedAgentJob as never,
    });

    let startSettled = false;
    const startPromise = start(state).finally(() => {
      startSettled = true;
    });

    // Wait until catch-up has begun executing the overdue job and hung on it.
    await vi.waitFor(() => {
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    });

    // The scheduler timer is armed even though catch-up is wedged and start()
    // has not resolved — the fix under test.
    expect(state.timer).not.toBeNull();
    expect(startSettled).toBe(false);

    // Unblock the hung turn so start() can finish for clean teardown.
    hung.resolve({ status: "ok", summary: "done" });
    await startPromise;
    expect(startSettled).toBe(true);

    stopTimer(state);
    await store.cleanup();
  });
});
