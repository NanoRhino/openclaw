import { describe, expect, it } from "vitest";
import { resolveFinalTagDiscardRetryInstruction } from "./incomplete-turn.js";

// Minimal attempt fixture: only the fields the resolver reads. The 2026-07-29
// silent-drop incident contract: a turn whose ENTIRE reply the gate discarded,
// with nothing else delivered, must be retried once — never end as unexplained
// silence for a member who just sent a message. Extended 2026-07-30: turns
// that completed a mutating tool action (weigh-in save, meal log — nearly
// every real coaching turn) retry too, with tools hard-disabled so the
// mutation cannot repeat.
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
    const plan = resolveFinalTagDiscardRetryInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttempt(),
    });
    expect(plan).not.toBeNull();
    expect(plan?.instruction).toContain("<final></final>");
    expect(plan?.instruction).toContain("discarded");
    expect(plan?.disableTools).toBe(false);
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

  it("fires WITH tools disabled when the attempt recorded potential side effects", () => {
    // 2026-07-30 incident (050244/050225): weight saved via tool, untagged
    // confirmation eaten, member got pure silence because the old side-effect
    // veto skipped the retry entirely. The mutating shape must retry — with
    // the tool surface emptied so the completed mutation cannot repeat.
    const plan = resolveFinalTagDiscardRetryInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({ replayMetadata: { hadPotentialSideEffects: true } }),
    });
    expect(plan).not.toBeNull();
    expect(plan?.disableTools).toBe(true);
    expect(plan?.instruction).toContain("do NOT try to call any tool");
    expect(plan?.instruction).toContain("<final></final>");
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
