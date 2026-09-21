import { describe, expect, it } from "vitest";
import { isIncompleteTerminalAssistantTurn, isPhantomToolUseTurn } from "./incomplete-turn.js";

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
