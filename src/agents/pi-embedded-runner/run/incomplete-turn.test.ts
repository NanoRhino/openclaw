import { describe, expect, it } from "vitest";
import {
  isIncompleteTerminalAssistantTurn,
  isPhantomToolUseTurn,
  PHANTOM_TOOL_USE_RETRY_INSTRUCTION,
  resolvePhantomToolUseRetryMode,
} from "./incomplete-turn.js";

describe("isPhantomToolUseTurn (openclaw-infra#206 reopen)", () => {
  it("flags a toolUse stop whose content holds only prose — the 050311 2026-09-21 13:12Z shape", () => {
    const last = {
      stopReason: "toolUse",
      content: [
        {
          type: "text",
          text: "<think>\nThe pre-send-check says SEND with angle=myth_bust … Let me find the streak-tracker skill location.\n</parameter>\n</invoke>",
        },
      ],
    };
    expect(isPhantomToolUseTurn(last)).toBe(true);
    expect(
      isIncompleteTerminalAssistantTurn({ hasAssistantVisibleText: false, lastAssistant: last }),
    ).toBe(true);
  });

  it("is not a phantom when a real toolCall block is present", () => {
    expect(
      isPhantomToolUseTurn({
        stopReason: "toolUse",
        content: [
          { type: "text", text: "<think>run the gate</think>" },
          {
            type: "toolCall",
            name: "exec",
            id: "t1",
            arguments: { command: "python3 pre-send-check.py" },
          },
        ],
      }),
    ).toBe(false);
    expect(
      isPhantomToolUseTurn({
        stopReason: "toolUse",
        content: [{ type: "tool_use", name: "read" }],
      }),
    ).toBe(false);
  });

  it("only applies to stopReason=toolUse", () => {
    expect(
      isPhantomToolUseTurn({ stopReason: "stop", content: [{ type: "text", text: "hi" }] }),
    ).toBe(false);
    expect(isPhantomToolUseTurn({ stopReason: "error", content: [] })).toBe(false);
    expect(isPhantomToolUseTurn(null)).toBe(false);
    expect(isPhantomToolUseTurn(undefined)).toBe(false);
  });

  it("a toolUse stop with empty or non-array content is a phantom too", () => {
    expect(isPhantomToolUseTurn({ stopReason: "toolUse", content: [] })).toBe(true);
    expect(isPhantomToolUseTurn({ stopReason: "toolUse" })).toBe(true);
  });
});

describe("resolvePhantomToolUseRetryMode (openclaw-infra#206, 3rd reopen)", () => {
  // 060329 2026-09-26 11:58Z: read → exec (pre-send-check) → read → a
  // reasoning-only assistant message with stopReason=toolUse; retries=0.
  const thinkingOnly = { stopReason: "toolUse", content: [{ type: "thinking", thinking: "…" }] };
  const prose = {
    stopReason: "toolUse",
    content: [{ type: "text", text: "…</parameter>\n</invoke>" }],
  };

  it("a side-effect turn is continued with the steer, not vetoed", () => {
    expect(
      resolvePhantomToolUseRetryMode({
        lastAssistant: thinkingOnly,
        hadPotentialSideEffects: true,
        retries: 0,
        maxRetries: 2,
      }),
    ).toBe("steer");
    expect(
      resolvePhantomToolUseRetryMode({
        lastAssistant: prose,
        hadPotentialSideEffects: true,
        retries: 1,
        maxRetries: 2,
      }),
    ).toBe("steer");
  });

  it("a clean turn is resubmitted as before", () => {
    expect(
      resolvePhantomToolUseRetryMode({
        lastAssistant: prose,
        hadPotentialSideEffects: false,
        retries: 0,
        maxRetries: 2,
      }),
    ).toBe("resubmit");
  });

  it("spent retries and non-phantom turns get nothing", () => {
    expect(
      resolvePhantomToolUseRetryMode({
        lastAssistant: prose,
        hadPotentialSideEffects: true,
        retries: 2,
        maxRetries: 2,
      }),
    ).toBeNull();
    expect(
      resolvePhantomToolUseRetryMode({
        lastAssistant: { stopReason: "toolUse", content: [{ type: "toolCall", name: "exec" }] },
        hadPotentialSideEffects: true,
        retries: 0,
        maxRetries: 2,
      }),
    ).toBeNull();
    expect(
      resolvePhantomToolUseRetryMode({
        lastAssistant: { stopReason: "stop", content: [] },
        hadPotentialSideEffects: false,
        retries: 0,
        maxRetries: 2,
      }),
    ).toBeNull();
  });

  it("the steer keeps completed tool results and forbids re-running them", () => {
    expect(PHANTOM_TOOL_USE_RETRY_INSTRUCTION).toMatch(/do NOT re-run those tools/);
    expect(PHANTOM_TOOL_USE_RETRY_INSTRUCTION).toMatch(/already returned SEND stays SEND/);
    expect(PHANTOM_TOOL_USE_RETRY_INSTRUCTION).toMatch(/emit it as a real tool call now/);
  });
});
