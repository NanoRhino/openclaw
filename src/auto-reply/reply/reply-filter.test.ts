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

// === v6 LLM verdict parsing tests (patch-005) ===
//
// Regression coverage for the patch-004 failure mode: max_tokens=1 +
// startsWith("true") parsing occasionally let single-char preambles ("I",
// "T", "L") slip through and delivered meta-instructions to real users
// (real-world incident: "Length ≤80 Chinese chars (excluding photo invite)."
// reached a WeChat user inside a lunch reminder cron message).
//
// v6 switches the LLM to JSON output {"filter": true|false} with markdown-
// fence stripping and a legacy bare-token startsWith fallback. These tests
// exercise the parsing block end-to-end via the Anthropic-API branch
// (native `fetch`, easy to mock with vi.spyOn). Bedrock branch shares the
// same parse code, so covering Anthropic is sufficient for the parser.
//
// Each test uses a unique paragraph string to bypass _classifyParagraph's
// internal Map cache (keyed on text.trim().slice(0, 200)).

const LLM_PROBE_BASE = "Length \u226480 Chinese chars (excluding photo invite). Variant ";

const NON_EXCLUDED_SESSION_KEY =
  "agent:wechat-dm-acckyoy8rw7hbpxnui2n2ls:wechat:default:direct:acckyoy8rw7hbpxnui2n2ls";

function writeLlmTestCfg(): void {
  _replyFilterFs.writeFileSync(
    `${cfgPath}/reply-filter.json`,
    JSON.stringify({
      enabled: true,
      mode: "exclude",
      exclude: ["main", "strategic-management"],
      llm: true,
      provider: "anthropic",
      model: "claude-haiku-4-5",
      apiKey: "test-api-key-not-real",
    }),
  );
}

function stubFetchAnswer(answer: string): void {
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ content: [{ text: answer }] }),
  } as Response);
}

describe("filterReplyText LLM verdict parsing (v6 / patch-005)", () => {
  it('LLM returns clean {"filter": true} JSON → paragraph dropped', async () => {
    writeLlmTestCfg();
    stubFetchAnswer('{"filter": true}');

    const text = `${LLM_PROBE_BASE}clean-true`;
    const result = await filterReplyText(text, undefined, NON_EXCLUDED_SESSION_KEY);

    expect(result.drop).toBe(true);
    expect(result.text).toBe("");
  });

  it('LLM returns clean {"filter": false} JSON → paragraph kept', async () => {
    writeLlmTestCfg();
    stubFetchAnswer('{"filter": false}');

    const text = `${LLM_PROBE_BASE}clean-false`;
    const result = await filterReplyText(text, undefined, NON_EXCLUDED_SESSION_KEY);

    expect(result.drop).toBe(false);
    expect(result.text).toBe(text);
  });

  it("LLM wraps JSON in ```json fence → fence stripped, parsed as filter=true", async () => {
    writeLlmTestCfg();
    stubFetchAnswer('```json\n{"filter": true}\n```');

    const text = `${LLM_PROBE_BASE}fenced-true`;
    const result = await filterReplyText(text, undefined, NON_EXCLUDED_SESSION_KEY);

    expect(result.drop).toBe(true);
    expect(result.text).toBe("");
  });

  it('LLM returns bare "true" token (legacy) → JSON parse fails, fallback startsWith path filters', async () => {
    writeLlmTestCfg();
    stubFetchAnswer("true");

    const text = `${LLM_PROBE_BASE}bare-true`;
    const result = await filterReplyText(text, undefined, NON_EXCLUDED_SESSION_KEY);

    expect(result.drop).toBe(true);
    expect(result.text).toBe("");
  });

  it('LLM returns single junk char "I" (regression: old patch-004 max_tokens=1 truncation) → kept, NOT leaked', async () => {
    writeLlmTestCfg();
    stubFetchAnswer("I");

    const text = `${LLM_PROBE_BASE}junk-I`;
    const result = await filterReplyText(text, undefined, NON_EXCLUDED_SESSION_KEY);

    // JSON.parse("I") throws → fallback: "i".startsWith("true") === false → kept.
    // This matches the prior patch-004 behaviour for unrecognised verdicts
    // (defensive: when uncertain, do NOT drop user-visible content).
    expect(result.drop).toBe(false);
    expect(result.text).toBe(text);
  });

  it('LLM returns bare "false" token (legacy) → kept', async () => {
    writeLlmTestCfg();
    stubFetchAnswer("false");

    const text = `${LLM_PROBE_BASE}bare-false`;
    const result = await filterReplyText(text, undefined, NON_EXCLUDED_SESSION_KEY);

    expect(result.drop).toBe(false);
    expect(result.text).toBe(text);
  });
});
