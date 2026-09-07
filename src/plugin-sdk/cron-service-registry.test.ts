import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import {
  type ActiveCronService,
  createCronJob,
  getActiveCronService,
  setActiveCronService,
} from "./cron-service-registry.js";

afterEach(() => setActiveCronService(null));

describe("cron-service-registry", () => {
  it("is empty until the gateway registers a service", async () => {
    expect(getActiveCronService()).toBeNull();
    await expect(createCronJob({})).rejects.toThrow("not registered");
  });

  it("createCronJob goes through the shared cron.add core against the registered service", async () => {
    const add = vi.fn(async (input: unknown) => ({ id: "job-9", ...(input as object) }) as unknown as CronJob);
    const entry = {
      cron: { add },
      getRuntimeConfig: () => ({ channels: {} }) as unknown as OpenClawConfig,
    } as unknown as ActiveCronService;
    setActiveCronService(entry);
    expect(getActiveCronService()).toBe(entry);
    const job = await createCronJob({
      name: "X",
      enabled: true,
      agentId: "wechat-dm-acca",
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "m" },
      delivery: { mode: "none", channel: "last" },
    });
    expect(job.id).toBe("job-9");
    expect(add).toHaveBeenCalledTimes(1);
    await expect(createCronJob({ name: "X", payload: { kind: "agentTurn" } })).rejects.toThrow(/invalid cron\.add params/);
  });

  it("ignores entries without an add()", () => {
    setActiveCronService({ cron: {} } as unknown as ActiveCronService);
    expect(getActiveCronService()).toBeNull();
  });
});
