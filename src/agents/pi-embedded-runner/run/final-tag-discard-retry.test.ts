import { describe, expect, it } from "vitest";
import { resolveFinalTagDiscardRetryInstruction } from "./incomplete-turn.js";

// Minimal attempt fixture: only the fields the resolver reads. The 2026-07-29
// silent-drop incident contract: a turn whose ENTIRE reply the gate discarded,
// with nothing else delivered, must be recovered — never end as unexplained
// silence for a member who just sent a message. Extended 2026-07-30: turns
// that completed a mutating tool action (weigh-in save, meal log — nearly
// every real coaching turn) recover by SALVAGING the discarded text (no model
// re-run: Bedrock rejects tool-bearing transcripts without toolConfig, and a
// resubmission with tools could repeat the mutation).
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
      expect(plan.instruction).toContain("discarded");
    }
  });

  it("fires when assistantTexts is fully empty (pre-sentinel shape)", () => {
    const plan = resolveFinalTagDiscardRetryInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({ assistantTexts: [] }),
    });
    expect(plan).not.toBeNull();
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

  it("salvages the discarded text when the attempt recorded potential side effects", () => {
    // 2026-07-30 incident (050244/050225): weight saved via tool, untagged
    // confirmation eaten, member got pure silence. A model re-run is unsafe
    // here (duplicate mutation; Bedrock toolConfig contract), so the eaten
    // text itself becomes the reply payload — default-deliver-over-silence.
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
          finalTagDiscardedText: "   ",
        }),
      }),
    ).toBeNull();
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

  it("side-effect turns still respect the messaging-tool delivered veto", () => {
    expect(
      resolveFinalTagDiscardRetryInstruction({
        aborted: false,
        timedOut: false,
        attempt: makeAttempt({
          replayMetadata: { hadPotentialSideEffects: true },
          messagingToolSentTexts: ["📝 Breakfast logged!"],
          didSendViaMessagingTool: true,
        }),
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
