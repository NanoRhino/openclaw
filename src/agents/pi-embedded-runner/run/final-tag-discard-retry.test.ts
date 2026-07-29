import { describe, expect, it } from "vitest";
import { resolveFinalTagDiscardRetryInstruction } from "./incomplete-turn.js";

// Minimal attempt fixture: only the fields the resolver reads. The 2026-07-29
// silent-drop incident contract: a turn whose ENTIRE reply the gate discarded,
// with nothing else delivered, must be retried once — never end as unexplained
// silence for a member who just sent a message.
function makeAttempt(overrides: Record<string, unknown> = {}) {
  return {
    assistantTexts: ["NO_REPLY"],
    finalTagDiscardedEntireReply: true,
    messagingToolSentTexts: [] as string[],
    didSendViaMessagingTool: false,
    replayMetadata: { hadPotentialSideEffects: false },
    ...overrides,
    // oxlint-disable-next-line no-explicit-any
  } as any;
}

describe("resolveFinalTagDiscardRetryInstruction", () => {
  it("fires when the gate ate the whole reply and nothing was delivered", () => {
    const instruction = resolveFinalTagDiscardRetryInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttempt(),
    });
    expect(instruction).toContain("<final></final>");
    expect(instruction).toContain("discarded");
  });

  it("fires when assistantTexts is fully empty (pre-sentinel shape)", () => {
    const instruction = resolveFinalTagDiscardRetryInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({ assistantTexts: [] }),
    });
    expect(instruction).not.toBeNull();
  });

  it("does not fire without the discard flag (genuine intentional silence)", () => {
    expect(
      resolveFinalTagDiscardRetryInstruction({
        aborted: false,
        timedOut: false,
        attempt: makeAttempt({ finalTagDiscardedEntireReply: false }),
      }),
    ).toBeNull();
  });

  it("does not fire when the messaging tool already delivered (meal cards)", () => {
    expect(
      resolveFinalTagDiscardRetryInstruction({
        aborted: false,
        timedOut: false,
        attempt: makeAttempt({
          messagingToolSentTexts: ["📝 Breakfast logged!"],
          didSendViaMessagingTool: true,
        }),
      }),
    ).toBeNull();
  });

  it("does not fire when visible text survived alongside the discard", () => {
    expect(
      resolveFinalTagDiscardRetryInstruction({
        aborted: false,
        timedOut: false,
        attempt: makeAttempt({ assistantTexts: ["Here is your summary."] }),
      }),
    ).toBeNull();
  });

  it("does not fire when the attempt recorded potential side effects", () => {
    expect(
      resolveFinalTagDiscardRetryInstruction({
        aborted: false,
        timedOut: false,
        attempt: makeAttempt({ replayMetadata: { hadPotentialSideEffects: true } }),
      }),
    ).toBeNull();
  });

  it("does not fire on aborted or timed-out turns", () => {
    expect(
      resolveFinalTagDiscardRetryInstruction({
        aborted: true,
        timedOut: false,
        attempt: makeAttempt(),
      }),
    ).toBeNull();
    expect(
      resolveFinalTagDiscardRetryInstruction({
        aborted: false,
        timedOut: true,
        attempt: makeAttempt(),
      }),
    ).toBeNull();
  });
});
