import { describe, expect, it } from "vitest";
import { resolveFinalTagDiscardRetryInstruction } from "./incomplete-turn.js";

// Ported from the 4.24 line (2026-07-30 silent-drop incidents): a turn whose
// ENTIRE reply the enforceFinalTag gate discarded, with nothing else
// delivered, must be recovered — retry for pure-chat turns, salvage of the
// discarded text for side-effect turns (no model re-run: Bedrock rejects
// tool-bearing transcripts without toolConfig; resubmission could repeat the
// mutation).
function makeAttempt(overrides: Record<string, unknown> = {}) {
  return {
    assistantTexts: ["NO_REPLY"],
    finalTagDiscardedEntireReply: true,
    finalTagDiscardedText: "Down to 242.2 — nice steady progress.",
    messagingToolSentTexts: [] as string[],
    didSendViaMessagingTool: false,
    replayMetadata: { hadPotentialSideEffects: false },
    ...overrides,
    // oxlint-disable-next-line no-explicit-any
  } as any;
}

describe("resolveFinalTagDiscardRetryInstruction", () => {
  it("retries when the gate ate the whole reply and nothing was delivered", () => {
    const plan = resolveFinalTagDiscardRetryInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttempt(),
    });
    expect(plan?.kind).toBe("retry");
    if (plan?.kind === "retry") {
      expect(plan.instruction).toContain("<final></final>");
    }
  });

  it("salvages the discarded text when the attempt recorded potential side effects", () => {
    const plan = resolveFinalTagDiscardRetryInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({ replayMetadata: { hadPotentialSideEffects: true } }),
    });
    expect(plan?.kind).toBe("salvage");
    if (plan?.kind === "salvage") {
      expect(plan.text).toBe("Down to 242.2 — nice steady progress.");
    }
  });

  it("side-effect turns end silent when no discarded text was captured", () => {
    expect(
      resolveFinalTagDiscardRetryInstruction({
        aborted: false,
        timedOut: false,
        attempt: makeAttempt({
          replayMetadata: { hadPotentialSideEffects: true },
          finalTagDiscardedText: undefined,
        }),
      }),
    ).toBeNull();
  });

  it("does not fire without the discard flag or when content was delivered", () => {
    expect(
      resolveFinalTagDiscardRetryInstruction({
        aborted: false,
        timedOut: false,
        attempt: makeAttempt({ finalTagDiscardedEntireReply: false }),
      }),
    ).toBeNull();
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
    expect(
      resolveFinalTagDiscardRetryInstruction({
        aborted: false,
        timedOut: false,
        attempt: makeAttempt({ assistantTexts: ["Here is your summary."] }),
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
