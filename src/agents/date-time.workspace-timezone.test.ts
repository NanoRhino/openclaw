import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCronStyleNow } from "./current-time.js";
import { readWorkspaceTimezoneHint, resolveWorkspaceTimezone } from "./date-time.js";

let ws: string;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), "ws-tz-"));
});
afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

function writeUserMd(lines: string[]) {
  fs.writeFileSync(
    path.join(ws, "USER.md"),
    `# User Profile\n\n## Basic Info\n${lines.join("\n")}\n`,
  );
}

describe("readWorkspaceTimezoneHint (USER.md → IANA / fixed offset)", () => {
  it("prefers a valid IANA Timezone line", () => {
    writeUserMd(["- **Timezone:** America/Toronto", "- **TZ Offset:** 28800"]);
    expect(readWorkspaceTimezoneHint(ws)).toBe("America/Toronto");
  });

  it("falls back to a whole-hour TZ Offset when the Timezone line is missing or invalid", () => {
    writeUserMd(["- **Timezone:** Mars/Olympus", "- **TZ Offset:** 7200"]);
    expect(readWorkspaceTimezoneHint(ws)).toBe("Etc/GMT-2"); // UTC+2 → Etc/GMT-2 (sign inverted)
    writeUserMd(["- **TZ Offset:** -14400"]);
    expect(readWorkspaceTimezoneHint(ws)).toBe("Etc/GMT+4"); // UTC-4
    writeUserMd(["- **TZ Offset:** 0"]);
    expect(readWorkspaceTimezoneHint(ws)).toBe("Etc/UTC");
  });

  it("gives up (undefined) on half-hour offsets, garbage, or a missing USER.md", () => {
    writeUserMd(["- **TZ Offset:** 19800"]); // +5:30 — no Etc/GMT zone, don't guess
    expect(readWorkspaceTimezoneHint(ws)).toBeUndefined();
    writeUserMd(["- **Timezone:** —", "- **TZ Offset:** abc"]);
    expect(readWorkspaceTimezoneHint(ws)).toBeUndefined();
    expect(readWorkspaceTimezoneHint(path.join(ws, "nope"))).toBeUndefined();
    expect(readWorkspaceTimezoneHint(undefined)).toBeUndefined();
  });

  it("re-reads when USER.md changes (mtime cache)", () => {
    writeUserMd(["- **Timezone:** Asia/Shanghai"]);
    expect(readWorkspaceTimezoneHint(ws)).toBe("Asia/Shanghai");
    // force a different mtime, then change the zone
    const later = new Date(Date.now() + 5_000);
    writeUserMd(["- **Timezone:** Africa/Lubumbashi"]);
    fs.utimesSync(path.join(ws, "USER.md"), later, later);
    expect(readWorkspaceTimezoneHint(ws)).toBe("Africa/Lubumbashi");
  });
});

describe("resolveWorkspaceTimezone fallback chain", () => {
  it("workspace hint → configured → host, never throws", () => {
    writeUserMd(["- **Timezone:** America/Toronto"]);
    expect(resolveWorkspaceTimezone(ws, "Asia/Shanghai")).toBe("America/Toronto");
    writeUserMd(["- **Name:** 小胖"]);
    expect(resolveWorkspaceTimezone(ws, "Asia/Shanghai")).toBe("Asia/Shanghai");
    expect(resolveWorkspaceTimezone(ws, "Not/AZone")).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    );
    expect(resolveWorkspaceTimezone(undefined, undefined)).toBeTruthy();
  });

  it("drives the cron-style Current time line through the override", () => {
    const nowMs = Date.UTC(2026, 7, 21, 4, 45); // 2026-08-21 04:45 UTC
    const toronto = resolveCronStyleNow({}, nowMs, "America/Toronto");
    expect(toronto.userTimezone).toBe("America/Toronto");
    expect(toronto.timeLine).toContain("(America/Toronto)");
    expect(toronto.timeLine).toContain("Reference UTC: 2026-08-21 04:45 UTC");
    const shanghai = resolveCronStyleNow(
      { agents: { defaults: { userTimezone: "Asia/Shanghai" } } },
      nowMs,
    );
    expect(shanghai.userTimezone).toBe("Asia/Shanghai");
    expect(shanghai.formattedTime).not.toBe(toronto.formattedTime);
  });
});
