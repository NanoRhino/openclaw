import fs from "node:fs";
import path from "node:path";
import type { CronJob } from "../types.js";

// openclaw-infra#346 (2026-09-18, agent 060334): the lunch reminder fired at
// 17:15:00Z and its LLM turn ran 66 s; the user texted their lunch at
// 17:15:41Z; the reminder — a recap of the morning's breakfast card plus
// "Get some air fryer chicken breast in at lunch … none logged yet today" —
// was delivered at 17:16:06Z, twenty seconds before the chat turn's real
// lunch card. Fire-time gates (leave / meal-logged / proactive-sent) cannot
// see an inbound that arrives DURING the run, so this one runs at delivery
// time: a recurring announce reminder whose workspace channel-source.json
// lastInboundAt is newer than the run start is not delivered — the chat
// turn owns the conversation now. One-shot "at" jobs, non-announce jobs,
// reports and every read surprise pass (fail-open).

type CronInboundGateContext = {
  deliveryRequested: boolean;
  workspaceDir: string;
  runStartedAt: number;
};

// Same job-name vocabulary as the fire-time proactive gate (patch-021).
const REMINDER_NAME_RE = /\b(?:breakfast|lunch|dinner|snack|weigh(?:-?in|t)?)\b/i;

function readLastInboundMs(workspaceDir: string): number | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(workspaceDir, "channel-source.json"), "utf-8"),
    );
    const value =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>).lastInboundAt : null;
    if (typeof value === "number" && Number.isFinite(value)) {
      return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function isProactiveReminderJob(job: Pick<CronJob, "schedule" | "name">): boolean {
  if (!job.schedule || job.schedule.kind === "at") {
    return false;
  }
  return REMINDER_NAME_RE.test(String(job.name ?? ""));
}

/**
 * Returns a reason string when a proactive reminder should NOT be delivered
 * because the user messaged while the run was in flight, else `null`. Never throws.
 */
export function resolveCronInboundGateReason(
  job: Pick<CronJob, "schedule" | "name">,
  ctx: CronInboundGateContext,
): string | null {
  try {
    if (!ctx.deliveryRequested || !isProactiveReminderJob(job)) {
      return null;
    }
    const workspaceDir = typeof ctx.workspaceDir === "string" ? ctx.workspaceDir : "";
    if (!workspaceDir || !Number.isFinite(ctx.runStartedAt) || ctx.runStartedAt <= 0) {
      return null;
    }
    const lastInbound = readLastInboundMs(workspaceDir);
    if (lastInbound == null || lastInbound <= ctx.runStartedAt) {
      return null;
    }
    const seconds = Math.round((lastInbound - ctx.runStartedAt) / 1000);
    return `user messaged ${seconds}s after the run started — the chat turn owns the conversation`;
  } catch {
    return null;
  }
}
