import fs from "node:fs";
import path from "node:path";
import type { CronJob } from "../types.js";

// patch-012: cron leave gate — deterministic suppression of proactive cron runs
// while the user is on leave or their reminders are soft-paused.
//
// ROOT CAUSE (2026-07-13, agent 060370): fire-time leave enforcement lived only
// in notification-composer's pre-send-check.py, which the cron turn's model has
// to choose to run. A breakfast-reminder turn made zero tool calls, composed a
// reminder directly, and announce delivery sent it — one day after the coach
// told the user reminders were paused (data/leave.json was present and valid the
// whole time; the same day's lunch/dinner turns did run the script and were
// suppressed). Any gate the model must remember to run is a per-fire dice roll,
// so this one runs in the gateway before the LLM turn.
//
// Gated: a recurring job (schedule.kind !== "at") with announce delivery
// (deliveryRequested === true) whose workspace data/leave.json window covers
// today (evaluated in the job's schedule tz) or whose channel-source.json has
// remindersPaused === true. One-shot "at" jobs (user-requested timers) and
// non-announce jobs always pass; agents with neither file (main, internal
// agents) are never gated. Fail-open: any read/parse surprise runs the job
// normally, with pre-send-check.py as the second belt. This gate is read-only —
// expired-leave.json cleanup stays owned by pre-send-check.py.

type CronLeaveGateContext = {
  deliveryRequested: boolean;
  workspaceDir: string;
};

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return undefined;
  }
}

function resolveScheduleTz(schedule: CronJob["schedule"]): string {
  if (schedule.kind === "cron" && typeof schedule.tz === "string" && schedule.tz.trim()) {
    return schedule.tz.trim();
  }
  return "UTC";
}

function todayInTz(tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Returns a human-readable reason string when a proactive cron run should be
 * skipped for leave/pause, or `null` when the run should proceed. Never throws.
 */
export function resolveCronLeaveGateReason(
  job: Pick<CronJob, "schedule">,
  ctx: CronLeaveGateContext,
): string | null {
  try {
    if (ctx.deliveryRequested !== true) {
      return null;
    }
    if (!job.schedule || job.schedule.kind === "at") {
      return null;
    }
    const workspaceDir = typeof ctx.workspaceDir === "string" ? ctx.workspaceDir : "";
    if (!workspaceDir) {
      return null;
    }

    const channelSource = readJsonFile(path.join(workspaceDir, "channel-source.json"));
    if (isRecord(channelSource) && channelSource.remindersPaused === true) {
      return "reminders soft-paused (channel-source.json)";
    }

    const leave = readJsonFile(path.join(workspaceDir, "data", "leave.json"));
    if (!isRecord(leave)) {
      return null;
    }
    const start = typeof leave.start === "string" ? leave.start.trim() : "";
    const end = typeof leave.end === "string" ? leave.end.trim() : "";
    if (!ISO_DATE_RE.test(start) || !ISO_DATE_RE.test(end)) {
      return null;
    }

    const today = todayInTz(resolveScheduleTz(job.schedule));
    if (start <= today && today <= end) {
      return `user on leave (${start} to ${end})`;
    }
    return null;
  } catch {
    return null;
  }
}
