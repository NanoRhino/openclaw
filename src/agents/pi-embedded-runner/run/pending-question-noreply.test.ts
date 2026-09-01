import { describe, expect, it } from "vitest";
import {
  PENDING_QUESTION_SILENT_REPLY_RETRY_INSTRUCTION,
  resolvePendingQuestionSilentReplyRetryInstruction,
} from "./incomplete-turn.js";

// 2026-08-28 incident contract (openclaw-infra#165, agent 060334): the coach
// asked "has your doctor given you any new activity guidance?", the user
// answered "Resume as normal" 26s later, and the model emitted a bare NO_REPLY
// — the medical-clearance answer was never acknowledged and the activity
// restriction never updated. The resolver must claim exactly that shape and
// nothing else: intentional NO_REPLY silence stays by-design everywhere.

const COACH_QUESTION =
  "<final>\nGood to know — thanks for the update. Since it's out now, has your doctor " +
  "given you any new activity guidance for after removal? I don't want to assume " +
  "you're fully cleared until you've heard from them — once you know, I'll adjust " +
  "things accordingly.\n</final>";

function assistantMessage(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function userMessage(text: string) {
  return { role: "user", content: [{ type: "text", text }] };
}

function makeAttempt(overrides: Record<string, unknown> = {}) {
  return {
    assistantTexts: ["NO_REPLY"],
    messagesSnapshot: [
      assistantMessage(COACH_QUESTION),
      userMessage("Resume as normal"),
      assistantMessage("NO_REPLY"),
    ],
    messagingToolSentTexts: [] as string[],
    messagingToolSentMediaUrls: [] as string[],
    didSendViaMessagingTool: false,
    replayMetadata: { hadPotentialSideEffects: false },
    ...overrides,
    // oxlint-disable-next-line no-explicit-any
  } as any;
}

function resolve(params: Record<string, unknown> = {}) {
  return resolvePendingQuestionSilentReplyRetryInstruction({
    trigger: "user",
    aborted: false,
    timedOut: false,
    attempt: makeAttempt(),
    ...params,
    // oxlint-disable-next-line no-explicit-any
  } as any);
}

describe("resolvePendingQuestionSilentReplyRetryInstruction", () => {
  it("fires on the incident shape: silent-only reply to an answer to the assistant's own question", () => {
    expect(resolve()).toBe(PENDING_QUESTION_SILENT_REPLY_RETRY_INSTRUCTION);
  });

  it("does not fire for cron / heartbeat / memory / unset triggers", () => {
    for (const trigger of ["cron", "heartbeat", "memory", "manual", undefined]) {
      expect(resolve({ trigger })).toBeNull();
    }
  });

  it("does not fire in group conversations (NO_REPLY is routine under mention gating)", () => {
    expect(resolve({ groupId: "group-123" })).toBeNull();
  });

  it("does not fire when the prior assistant text asks no question", () => {
    expect(
      resolve({
        attempt: makeAttempt({
          messagesSnapshot: [
            assistantMessage("Great job hitting your protein target today."),
            userMessage("Thanks"),
            assistantMessage("NO_REPLY"),
          ],
        }),
      }),
    ).toBeNull();
  });

  it("does not treat URL query strings as questions", () => {
    expect(
      resolve({
        attempt: makeAttempt({
          messagesSnapshot: [
            assistantMessage(
              "Your report is ready: https://file.nanorhino.com/r?id=abc&x=1 enjoy.",
            ),
            userMessage("Ok"),
            assistantMessage("NO_REPLY"),
          ],
        }),
      }),
    ).toBeNull();
  });

  it("does not fire when a real visible reply exists this attempt", () => {
    expect(
      resolve({ attempt: makeAttempt({ assistantTexts: ["Got it — resuming normal activity."] }) }),
    ).toBeNull();
  });

  it("does not fire when the attempt had potential side effects (retry could replay mutations)", () => {
    expect(
      resolve({ attempt: makeAttempt({ replayMetadata: { hadPotentialSideEffects: true } }) }),
    ).toBeNull();
  });

  it("does not fire when the messaging tool already delivered", () => {
    expect(
      resolve({
        attempt: makeAttempt({
          didSendViaMessagingTool: true,
          messagingToolSentTexts: ["📝 Logged."],
        }),
      }),
    ).toBeNull();
  });

  it("does not fire when aborted or timed out", () => {
    expect(resolve({ aborted: true })).toBeNull();
    expect(resolve({ timedOut: true })).toBeNull();
  });

  it("walks past earlier NO_REPLY turns to find the hanging question (double-text shape)", () => {
    expect(
      resolve({
        attempt: makeAttempt({
          messagesSnapshot: [
            assistantMessage(COACH_QUESTION),
            userMessage("Resume"),
            assistantMessage("NO_REPLY"),
            userMessage("as normal"),
            assistantMessage("NO_REPLY"),
          ],
        }),
      }),
    ).toBe(PENDING_QUESTION_SILENT_REPLY_RETRY_INSTRUCTION);
  });

  it("handles string-content user messages and stands down with no prior assistant text", () => {
    expect(
      resolve({
        attempt: makeAttempt({
          messagesSnapshot: [{ role: "user", content: "hello" }, assistantMessage("NO_REPLY")],
        }),
      }),
    ).toBeNull();
    expect(resolve({ attempt: makeAttempt({ messagesSnapshot: [] }) })).toBeNull();
  });
});
