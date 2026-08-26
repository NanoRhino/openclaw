import {
  type TimeFormatPreference,
  formatUserTime,
  resolveUserTimeFormat,
  resolveUserTimezone,
} from "./date-time.js";

export type CronStyleNow = {
  userTimezone: string;
  formattedTime: string;
  timeLine: string;
};

type TimeConfigLike = {
  agents?: {
    defaults?: {
      userTimezone?: string;
      timeFormat?: TimeFormatPreference;
    };
  };
};

export function resolveCronStyleNow(
  cfg: TimeConfigLike,
  nowMs: number,
  timeZoneOverride?: string,
): CronStyleNow {
  // timeZoneOverride: per-workspace timezone (USER.md) resolved by the caller; falls back to config/host.
  const userTimezone = resolveUserTimezone(timeZoneOverride ?? cfg.agents?.defaults?.userTimezone);
  const userTimeFormat = resolveUserTimeFormat(cfg.agents?.defaults?.timeFormat);
  const formattedTime =
    formatUserTime(new Date(nowMs), userTimezone, userTimeFormat) ?? new Date(nowMs).toISOString();
  const utcTime = new Date(nowMs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const timeLine = `Current time: ${formattedTime} (${userTimezone})\nReference UTC: ${utcTime}`;
  return { userTimezone, formattedTime, timeLine };
}

export function appendCronStyleCurrentTimeLine(
  text: string,
  cfg: TimeConfigLike,
  nowMs: number,
  timeZoneOverride?: string,
) {
  const base = text.trimEnd();
  if (!base || base.includes("Current time:")) {
    return base;
  }
  const { timeLine } = resolveCronStyleNow(cfg, nowMs, timeZoneOverride);
  return `${base}\n${timeLine}`;
}
