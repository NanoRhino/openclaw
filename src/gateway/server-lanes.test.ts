import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { enqueueCommandInLane, resetCommandQueueStateForTest } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { applyGatewayLaneConcurrency } from "./server-lanes.js";

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushMicrotasks() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe("applyGatewayLaneConcurrency", () => {
  afterEach(() => {
    resetCommandQueueStateForTest();
  });

  it("aligns the nested lane with cron.maxConcurrentRuns so scheduled cron turns can run concurrently", async () => {
    applyGatewayLaneConcurrency({ cron: { maxConcurrentRuns: 3 } } as OpenClawConfig);

    const started: number[] = [];
    const deferreds = Array.from({ length: 4 }, () => createDeferred());
    const tasks = deferreds.map((deferred, index) =>
      enqueueCommandInLane(CommandLane.Nested, () => {
        started.push(index);
        return deferred.promise;
      }),
    );
    await flushMicrotasks();

    // Cap 3: the first three tasks start, the fourth queues.
    expect(started).toEqual([0, 1, 2]);

    deferreds[0]?.resolve();
    await flushMicrotasks();
    expect(started).toEqual([0, 1, 2, 3]);

    for (const deferred of deferreds) {
      deferred.resolve();
    }
    await Promise.all(tasks);
  });

  it("keeps the nested lane serial when cron.maxConcurrentRuns is unset", async () => {
    applyGatewayLaneConcurrency({} as OpenClawConfig);

    const started: number[] = [];
    const deferreds = Array.from({ length: 2 }, () => createDeferred());
    const tasks = deferreds.map((deferred, index) =>
      enqueueCommandInLane(CommandLane.Nested, () => {
        started.push(index);
        return deferred.promise;
      }),
    );
    await flushMicrotasks();

    expect(started).toEqual([0]);

    for (const deferred of deferreds) {
      deferred.resolve();
    }
    await Promise.all(tasks);
  });
});
