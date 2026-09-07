import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeCronJobCreate } from "../../cron/normalize.js";
import type { CronServiceContract } from "../../cron/service-contract.js";
import type { CronJob, CronJobCreate } from "../../cron/types.js";
import { validateScheduleTimestamp } from "../../cron/validate-timestamp.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { formatValidationErrors, validateCronAddParams } from "../protocol/index.js";
import { assertValidCronCreateDelivery } from "./cron-delivery-validation.js";

/**
 * `cron.add` 的核心逻辑，从 RPC 处理器抽出来，让同进程里的其它调用方（plugin-sdk/cron-service-registry →
 * 网关扩展）不必绕到进程外起 CLI 再经 websocket 连回自己：归一化 → schema 校验 → 时间戳校验 → 投递校验 → add。
 * 请求侧的问题一律抛 CronCreateRequestError（RPC 处理器映射成 INVALID_REQUEST），其它错误原样抛出。
 */
export class CronCreateRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronCreateRequestError";
  }
}

export type CronCreateLogger = {
  info: (message: string, meta?: Record<string, unknown>) => void;
};

export type CronCreateContext = {
  cron: Pick<CronServiceContract, "add">;
  getRuntimeConfig: () => OpenClawConfig;
  logGateway?: CronCreateLogger;
};

export async function createCronJobViaService(
  params: unknown,
  context: CronCreateContext,
): Promise<CronJob> {
  const sessionKey =
    typeof (params as { sessionKey?: unknown } | null)?.sessionKey === "string"
      ? (params as { sessionKey: string }).sessionKey
      : undefined;
  let normalized: unknown;
  try {
    normalized =
      normalizeCronJobCreate(params, {
        sessionContext: { sessionKey },
      }) ?? params;
  } catch (err) {
    throw new CronCreateRequestError(`invalid cron.add params: ${formatErrorMessage(err)}`);
  }
  if (!validateCronAddParams(normalized)) {
    throw new CronCreateRequestError(
      `invalid cron.add params: ${formatValidationErrors(validateCronAddParams.errors)}`,
    );
  }
  const jobCreate = normalized as unknown as CronJobCreate;
  const cfg = context.getRuntimeConfig();
  const timestampValidation = validateScheduleTimestamp(jobCreate.schedule);
  if (!timestampValidation.ok) {
    throw new CronCreateRequestError(timestampValidation.message);
  }
  try {
    assertValidCronCreateDelivery(cfg, jobCreate);
  } catch (err) {
    throw new CronCreateRequestError(`invalid cron.add params: ${formatErrorMessage(err)}`);
  }
  let job: CronJob;
  try {
    job = await context.cron.add(jobCreate);
  } catch (err) {
    if (!(err instanceof TypeError) && !(err instanceof RangeError)) {
      throw err;
    }
    throw new CronCreateRequestError(`invalid cron.add params: ${formatErrorMessage(err)}`);
  }
  context.logGateway?.info("cron: job created", { jobId: job.id, schedule: jobCreate.schedule });
  return job;
}
