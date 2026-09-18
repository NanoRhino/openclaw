import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProactiveReminderJob, resolveCronInboundGateReason } from "./inbound-gate.js";

// openclaw-infra#346: lunch reminder started 17:15:00Z, user texted 17:15:41Z,
// reminder delivered 17:16:06Z — a stale breakfast recap on top of the real lunch.
const RUN_STARTED_AT = Date.UTC(2026, 8, 18, 17, 15, 0, 44);
const INBOUND_DURING = Date.UTC(2026, 8, 18, 17, 15, 41, 16);

const lunchJob = {
  name: "Lunch reminder",
  schedule: { kind: "cron", expr: "15 12 * * *", tz: "America/Chicago" },
} as const;

describe("inbound gate (openclaw-infra#346)", () => {
  let workspaceDir: string;
  beforeEach(() => {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbound-gate-"));
  });
  afterEach(() => {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  });

  const stamp = (lastInboundAt: unknown) =>
    fs.writeFileSync(
      path.join(workspaceDir, "channel-source.json"),
      JSON.stringify({ channel: "twilio-sms", lastInboundAt }),
    );

  it("the 060334 turn: an inbound during the run blocks the reminder", () => {
    stamp(INBOUND_DURING);
    const reason = resolveCronInboundGateReason(lunchJob, {
      deliveryRequested: true,
      workspaceDir,
      runStartedAt: RUN_STARTED_AT,
    });
    expect(reason).toMatch(/user messaged 41s after the run started/);
  });

  it("an inbound BEFORE the run started does not block (fire-time gates own that)", () => {
    stamp(RUN_STARTED_AT - 5 * 60_000);
    expect(
      resolveCronInboundGateReason(lunchJob, {
        deliveryRequested: true,
        workspaceDir,
        runStartedAt: RUN_STARTED_AT,
      }),
    ).toBeNull();
  });

  it("ISO and seconds-epoch stamps are both read", () => {
    stamp(new Date(INBOUND_DURING).toISOString());
    expect(
      resolveCronInboundGateReason(lunchJob, {
        deliveryRequested: true,
        workspaceDir,
        runStartedAt: RUN_STARTED_AT,
      }),
    ).not.toBeNull();
    stamp(Math.floor(INBOUND_DURING / 1000));
    expect(
      resolveCronInboundGateReason(lunchJob, {
        deliveryRequested: true,
        workspaceDir,
        runStartedAt: RUN_STARTED_AT,
      }),
    ).not.toBeNull();
  });

  it("one-shot 'at' jobs, non-reminder jobs and non-announce runs pass", () => {
    stamp(INBOUND_DURING);
    expect(
      resolveCronInboundGateReason(
        { name: "Lunch reminder", schedule: { kind: "at", at: "2026-09-18T17:15:00Z" } } as never,
        { deliveryRequested: true, workspaceDir, runStartedAt: RUN_STARTED_AT },
      ),
    ).toBeNull();
    expect(
      resolveCronInboundGateReason(
        { name: "Weekly report", schedule: lunchJob.schedule } as never,
        { deliveryRequested: true, workspaceDir, runStartedAt: RUN_STARTED_AT },
      ),
    ).toBeNull();
    expect(
      resolveCronInboundGateReason(lunchJob, {
        deliveryRequested: false,
        workspaceDir,
        runStartedAt: RUN_STARTED_AT,
      }),
    ).toBeNull();
  });

  it("fail-open: missing / malformed channel-source.json, bad runStartedAt", () => {
    expect(
      resolveCronInboundGateReason(lunchJob, {
        deliveryRequested: true,
        workspaceDir,
        runStartedAt: RUN_STARTED_AT,
      }),
    ).toBeNull();
    fs.writeFileSync(path.join(workspaceDir, "channel-source.json"), "{not json");
    expect(
      resolveCronInboundGateReason(lunchJob, {
        deliveryRequested: true,
        workspaceDir,
        runStartedAt: RUN_STARTED_AT,
      }),
    ).toBeNull();
    stamp(INBOUND_DURING);
    expect(
      resolveCronInboundGateReason(lunchJob, {
        deliveryRequested: true,
        workspaceDir,
        runStartedAt: Number.NaN,
      }),
    ).toBeNull();
    expect(
      resolveCronInboundGateReason(lunchJob, {
        deliveryRequested: true,
        workspaceDir: "",
        runStartedAt: RUN_STARTED_AT,
      }),
    ).toBeNull();
  });

  it("isProactiveReminderJob: meal and weigh-in names only", () => {
    expect(isProactiveReminderJob(lunchJob)).toBe(true);
    expect(
      isProactiveReminderJob({ name: "Weight check-in reminder", schedule: lunchJob.schedule }),
    ).toBe(true);
    expect(
      isProactiveReminderJob({ name: "Weekly weigh-in reminder", schedule: lunchJob.schedule }),
    ).toBe(true);
    expect(isProactiveReminderJob({ name: "Weekly report", schedule: lunchJob.schedule })).toBe(
      false,
    );
    expect(
      isProactiveReminderJob({
        name: "Daily habit: daily coffee with cream",
        schedule: lunchJob.schedule,
      }),
    ).toBe(false);
  });
});
