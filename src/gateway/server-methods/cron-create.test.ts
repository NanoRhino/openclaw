import { describe, expect, it, vi } from "vitest";

import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../../cron/types.js";
import { CronCreateRequestError, createCronJobViaService } from "./cron-create.js";

const cfg = { channels: {} } as unknown as OpenClawConfig;

function params(overrides: Record<string, unknown> = {}) {
  return {
    name: "Lunch reminder",
    enabled: true,
    agentId: "wechat-dm-accabc",
    schedule: { kind: "cron", expr: "15 12 * * *", tz: "Asia/Shanghai" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "Run cron-meal-reminder for lunch.", recentMainContext: true },
    delivery: { mode: "announce", channel: "last", to: "accabc" },
    ...overrides,
  };
}

function ctx(add = vi.fn(async (input: unknown) => ({ id: "job-1", ...(input as object) }) as unknown as CronJob)) {
  const info = vi.fn();
  return { context: { cron: { add }, getRuntimeConfig: () => cfg, logGateway: { info } }, add, info };
}

describe("createCronJobViaService", () => {
  it("normalizes, validates and adds through the service; logs like the RPC handler", async () => {
    const { context, add, info } = ctx();
    const job = await createCronJobViaService(params(), context);
    expect(job.id).toBe("job-1");
    expect(add).toHaveBeenCalledTimes(1);
    const input = add.mock.calls[0][0] as { name: string; sessionTarget: string; payload: { message: string } };
    expect(input.name).toBe("Lunch reminder");
    expect(input.sessionTarget).toBe("isolated");
    expect(input.payload.message).toBe("Run cron-meal-reminder for lunch.");
    expect(info).toHaveBeenCalledWith("cron: job created", expect.objectContaining({ jobId: "job-1" }));
  });

  it("rejects schema violations before touching the service, with the RPC error text", async () => {
    const { context, add } = ctx();
    await expect(createCronJobViaService(params({ payload: { kind: "agentTurn" } }), context)).rejects.toMatchObject({
      name: "CronCreateRequestError",
      message: expect.stringMatching(/^invalid cron\.add params: /),
    });
    expect(add).not.toHaveBeenCalled();
  });

  it("maps TypeError/RangeError from the service to a request error and lets other errors through", async () => {
    const typeErr = ctx(vi.fn(async () => { throw new TypeError("bad field"); }));
    await expect(createCronJobViaService(params(), typeErr.context)).rejects.toBeInstanceOf(CronCreateRequestError);
    const other = ctx(vi.fn(async () => { throw new Error("disk full"); }));
    await expect(createCronJobViaService(params(), other.context)).rejects.toThrow("disk full");
  });
});
