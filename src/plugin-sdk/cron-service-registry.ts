// 网关进程内的 CronService 访问点（2026-09-07，NanoRhino）。
//
// 背景：网关扩展（onboarding provisioner）以前建 cron 只能起 `openclaw cron add` CLI 进程、经 websocket 连回本网关。
// 主线程卡顿时握手成片超时，批量建提醒整批失败；每个用户还要多烧 ~25 个 node 进程。这里让 server-cron 在
// CronService 建好后登记一次，扩展经 plugin-sdk 直接拿到并用与 RPC `cron.add` 完全相同的核心逻辑建任务。
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronServiceContract } from "../cron/service-contract.js";
import type { CronJob } from "../cron/types.js";
import {
  type CronCreateLogger,
  createCronJobViaService,
} from "../gateway/server-methods/cron-create.js";

export type ActiveCronService = {
  cron: Pick<CronServiceContract, "add" | "remove" | "list" | "listPage" | "getJob" | "readJob">;
  getRuntimeConfig: () => OpenClawConfig;
  logGateway?: CronCreateLogger;
};

let active: ActiveCronService | null = null;

export function setActiveCronService(entry: ActiveCronService | null): void {
  active = entry && typeof entry.cron?.add === "function" ? entry : null;
}

export function getActiveCronService(): ActiveCronService | null {
  return active;
}

/** 等价于 gateway RPC `cron.add`（归一化 → 校验 → 投递校验 → add）；请求侧错误抛 CronCreateRequestError。 */
export async function createCronJob(
  params: unknown,
  options: { logGateway?: CronCreateLogger } = {},
): Promise<CronJob> {
  if (!active) {
    throw new Error("cron service is not registered in this process");
  }
  return createCronJobViaService(params, {
    cron: active.cron,
    getRuntimeConfig: active.getRuntimeConfig,
    logGateway: options.logGateway ?? active.logGateway,
  });
}
