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

  it("salvages a plugin-tool meal log even though replay metadata saw no side effect", () => {
    // openclaw-infra#505 (2026-09-28, agent 050171): meal_checkin saved the
    // meal, the untagged confirmation was eaten, and because plugin tool names
    // are unknown to the core mutation classifier the turn was re-prompted
    // with the wrap-in-<final> steer (41/45 retries in 7 days). A completed
    // plugin-tool call must salvage, not re-run the model.
    const plan = resolveFinalTagDiscardRetryInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({
        toolMetas: [{ toolName: "meal_checkin" }],
        finalTagDiscardedText: "📝 早餐记录好啦！\n🍽 华夫饼 220千卡 + 蛋卷 160千卡 = 380千卡",
      }),
    });
    expect(plan?.kind).toBe("salvage");
    if (plan?.kind === "salvage") {
      expect(plan.text).toBe("📝 早餐记录好啦！\n🍽 华夫饼 220千卡 + 蛋卷 160千卡 = 380千卡");
    }
  });

  it("salvages when a plugin tool ran alongside read-only core tools", () => {
    const plan = resolveFinalTagDiscardRetryInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({
        toolMetas: [{ toolName: "read" }, { toolName: "Exercise_Checkin" }],
      }),
    });
    expect(plan?.kind).toBe("salvage");
  });

  it("keeps the retry for turns whose tools were all read-only core tools", () => {
    const plan = resolveFinalTagDiscardRetryInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({
        toolMetas: [{ toolName: "read" }, { toolName: "memory_search" }, { toolName: "web_fetch" }],
      }),
    });
    expect(plan?.kind).toBe("retry");
  });

  it("keeps the retry for tool-less turns (empty toolMetas)", () => {
    const plan = resolveFinalTagDiscardRetryInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({ toolMetas: [] }),
    });
    expect(plan?.kind).toBe("retry");
  });

  it("plugin-tool turns end silent when no discarded text was captured", () => {
    expect(
      resolveFinalTagDiscardRetryInstruction({
        aborted: false,
        timedOut: false,
        attempt: makeAttempt({
          toolMetas: [{ toolName: "meal_checkin" }],
          finalTagDiscardedText: "NO_REPLY",
        }),
      }),
    ).toBeNull();
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

  it("salvages a tool-loop turn that discarded SEVERAL messages (one sentinel each)", () => {
    // 2026-08-13 incident (050273): preamble message discarded (92 chars),
    // tools ran (meal + exercise saved), answer message discarded (671-char
    // breakfast card). assistantTexts held TWO sentinels — the old
    // single-token comparison saw "NO_REPLY\n\nNO_REPLY", concluded real text
    // survived, and the member got pure silence for a live meal log. The
    // salvage payload must be the LAST discarded message (the answer), never
    // the internal-monologue preamble.
    const plan = resolveFinalTagDiscardRetryInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({
        assistantTexts: ["NO_REPLY", "NO_REPLY"],
        replayMetadata: { hadPotentialSideEffects: true },
        finalTagDiscardedText: "📝 Breakfast logged! 671 kcal — nice protein start.",
      }),
    });
    expect(plan?.kind).toBe("salvage");
    if (plan?.kind === "salvage") {
      expect(plan.text).toBe("📝 Breakfast logged! 671 kcal — nice protein start.");
    }
  });

  it("retries a multi-discard turn with no side effects", () => {
    const plan = resolveFinalTagDiscardRetryInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({
        assistantTexts: ["NO_REPLY", "NO_REPLY", "NO_REPLY"],
      }),
    });
    expect(plan?.kind).toBe("retry");
  });

  it("still stands down when real text survived among the sentinels", () => {
    expect(
      resolveFinalTagDiscardRetryInstruction({
        aborted: false,
        timedOut: false,
        attempt: makeAttempt({
          assistantTexts: ["NO_REPLY", "Here is your summary.", "NO_REPLY"],
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

describe("resolveFinalTagDiscardRetryInstruction — unclosed <think> (openclaw-infra#206, 2026-10-05)", () => {
  // 060341 09:42Z: meal_checkin ran (meals written), then the assistant opened
  // <think>, never closed it, never opened <final>, and ran the card inside the
  // reasoning. Visible text = "" → the plain discard flag never fired; with the
  // new flag the only sane recovery is a steer — never a salvage of reasoning prose.
  it("steers a retry on a side-effect turn instead of salvaging the reasoning prose", () => {
    const plan = resolveFinalTagDiscardRetryInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({
        assistantTexts: [],
        finalTagDiscardedText: "",
        finalTagDiscardedUnclosedThink: true,
        replayMetadata: { hadPotentialSideEffects: true },
        toolMetas: [{ toolName: "meal_checkin" }],
      }),
    });
    expect(plan?.kind).toBe("retry");
    if (plan?.kind === "retry") {
      expect(plan.instruction).toContain("never closed it");
      expect(plan.instruction).toContain("do not call it again");
      expect(plan.instruction).toContain("<final></final>");
    }
  });

  it("steers the same retry on a tool-less turn (060341 09:41Z 'Skipped dinner..felt bad')", () => {
    const plan = resolveFinalTagDiscardRetryInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({
        assistantTexts: [],
        finalTagDiscardedText: "",
        finalTagDiscardedUnclosedThink: true,
      }),
    });
    expect(plan?.kind).toBe("retry");
    if (plan?.kind === "retry") {
      expect(plan.instruction).toContain("never closed it");
    }
  });

  it("without the flag a side-effect turn with no captured text still ends silent (unchanged)", () => {
    const plan = resolveFinalTagDiscardRetryInstruction({
      aborted: false,
      timedOut: false,
      attempt: makeAttempt({
        assistantTexts: [],
        finalTagDiscardedText: "",
        replayMetadata: { hadPotentialSideEffects: true },
      }),
    });
    expect(plan).toBeNull();
  });
});
