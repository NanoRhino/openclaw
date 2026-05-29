// patch-003 fail-safe unit tests
//
// Covers the case where sessionKey is missing at the delivery chokepoint:
// the old fallback `sessionKey?.split(":")?.[1] ?? "main"` made agentId="main"
// which hit the exclude list and bypassed the filter. After patch-003, missing
// sessionKey → filter MUST run, and a `filter-bypass-suspect` warn must fire.

import _replyFilterFs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { filterReplyText } from "./reply-filter.js";

// A paragraph guaranteed to be killed by `_fastReject` (Let me ...)
const INTERNAL_NARRATION = "Let me check the user's data first.";

let cfgPath: string;
let originalStateDir: string | undefined;

beforeEach(() => {
  // Point the loader at an isolated config file we control.
  cfgPath = `/tmp/openclaw-reply-filter-test-${process.pid}-${Date.now()}`;
  originalStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = cfgPath;
  _replyFilterFs.mkdirSync(cfgPath, { recursive: true });
  _replyFilterFs.writeFileSync(
    `${cfgPath}/reply-filter.json`,
    JSON.stringify({
      enabled: true,
      mode: "exclude",
      exclude: ["main", "strategic-management"],
      llm: false, // Phase 2 LLM is disabled — fastReject only.
    }),
  );
});

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  try {
    _replyFilterFs.rmSync(cfgPath, { recursive: true, force: true });
  } catch {
    // ignore
  }
  vi.restoreAllMocks();
});

describe("filterReplyText fail-safe (patch-003)", () => {
  it("sessionKey=undefined: filter is invoked (NOT bypassed) and emits filter-bypass-suspect warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await filterReplyText(INTERNAL_NARRATION, undefined, undefined);

    // The fastReject should have killed it — patch-003 ensures filter actually runs.
    expect(result.drop).toBe(true);
    expect(result.text).toBe("");

    // Telemetry must fire so we can locate the upstream caller losing sessionKey.
    expect(warn).toHaveBeenCalledTimes(1);
    const arg = warn.mock.calls[0]![0] as string;
    expect(arg).toContain("filter-bypass-suspect");
    const parsed = JSON.parse(arg);
    expect(parsed.msg).toBe("filter-bypass-suspect: sessionKey missing at chokepoint");
    expect(parsed.sessionKey).toBeNull();
    expect(parsed.mode).toBe("exclude");
  });

  it("sessionKey='': filter is invoked (NOT bypassed) and emits filter-bypass-suspect warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await filterReplyText(INTERNAL_NARRATION, undefined, "");

    expect(result.drop).toBe(true);
    expect(result.text).toBe("");

    expect(warn).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(warn.mock.calls[0]![0] as string);
    expect(parsed.msg).toBe("filter-bypass-suspect: sessionKey missing at chokepoint");
    // sessionKey="" → split returns [""] → agentId="" → falsy → branch fires.
    expect(parsed.sessionKey).toBe("");
  });

  it("sessionKey='agent:strategic-management:...': legitimate exclude, filter bypassed unchanged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await filterReplyText(
      INTERNAL_NARRATION,
      undefined,
      "agent:strategic-management:wecom:direct:fuzhuoran",
    );

    // exclude hit → fast return with original text untouched.
    expect(result.drop).toBe(false);
    expect(result.text).toBe(INTERNAL_NARRATION);

    // Legitimate exclude must NOT trigger telemetry warn.
    expect(warn).not.toHaveBeenCalled();
  });

  it("sessionKey='agent:wechat-dm-xxx:...' (non-excluded agent): filter runs normally, no warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await filterReplyText(
      INTERNAL_NARRATION,
      undefined,
      "agent:wechat-dm-acckyoy8rw7hbpxnui2n2ls:wechat:default:direct:acckyoy8rw7hbpxnui2n2ls",
    );

    // agentId derived correctly → not in exclude → filter runs → fastReject kills.
    expect(result.drop).toBe(true);
    expect(result.text).toBe("");

    // sessionKey present → no telemetry warn.
    expect(warn).not.toHaveBeenCalled();
  });
});
