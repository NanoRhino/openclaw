import { describe, expect, it, vi } from "vitest";
import {
  buildCurrentTurnPrompt,
  buildCurrentTurnPromptContextPrefix,
  buildRuntimeContextSystemContext,
  queueRuntimeContextForNextTurn,
  resolveRuntimeContextPromptParts,
} from "./runtime-context-prompt.js";

describe("runtime context prompt submission", () => {
  it("keeps unchanged prompts as a normal user prompt", () => {
    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt: "visible ask",
        transcriptPrompt: "visible ask",
      }),
    ).toEqual({ prompt: "visible ask" });
  });

  it("moves hidden runtime context out of the visible prompt", () => {
    const effectivePrompt = [
      "visible ask",
      "",
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
      "secret runtime context",
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    ].join("\n");

    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt,
        transcriptPrompt: "visible ask",
      }),
    ).toEqual({
      prompt: "visible ask",
      runtimeContext:
        "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret runtime context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
    });
  });

  it("preserves prompt additions as hidden runtime context", () => {
    expect(
      resolveRuntimeContextPromptParts({
        effectivePrompt: ["runtime prefix", "", "visible ask", "", "retry instruction"].join("\n"),
        transcriptPrompt: "visible ask",
      }),
    ).toEqual({
      prompt: "visible ask",
      runtimeContext: "runtime prefix\n\nretry instruction",
    });
  });

  it("uses a marker prompt for runtime-only events", () => {
    const parts = resolveRuntimeContextPromptParts({
      effectivePrompt: "internal event",
      transcriptPrompt: "",
    });

    expect(parts).toEqual({
      prompt: "Continue the OpenClaw runtime event.",
      runtimeContext: "internal event",
      runtimeOnly: true,
      runtimeSystemContext: [
        "OpenClaw runtime event.",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "internal event",
      ].join("\n"),
    });
  });

  it("uses current-turn context as prompt-local text", () => {
    expect(
      buildCurrentTurnPromptContextPrefix({
        text: "Conversation info (untrusted metadata):\n```json\n{}\n```",
      }),
    ).toBe("Conversation info (untrusted metadata):\n```json\n{}\n```");
  });

  it("omits empty current-turn context", () => {
    expect(buildCurrentTurnPromptContextPrefix(undefined)).toBe("");
    expect(buildCurrentTurnPromptContextPrefix({ text: "   " })).toBe("");
  });

  it("joins current-turn context and prompt with the requested separator", () => {
    expect(
      buildCurrentTurnPrompt({
        context: { text: "Current message:\n#34975 obviyus:", promptJoiner: " " },
        prompt: "What do you mean hidden?",
      }),
    ).toBe("Current message:\n#34975 obviyus: What do you mean hidden?");

    expect(
      buildCurrentTurnPrompt({
        context: { text: "Conversation context:" },
        prompt: "visible ask",
      }),
    ).toBe("Conversation context:\n\nvisible ask");
  });

  it("queues runtime context as a hidden next-turn custom message", async () => {
    const sentMessages: Array<{ content: string }> = [];
    const sendCustomMessage = vi.fn(async (message: { content: string }) => {
      sentMessages.push(message);
    });

    await queueRuntimeContextForNextTurn({
      session: { sendCustomMessage },
      runtimeContext: "secret runtime context",
    });

    expect(sendCustomMessage).toHaveBeenCalledWith(
      {
        customType: "openclaw.runtime-context",
        content: "secret runtime context",
        display: false,
        details: { source: "openclaw-runtime-context" },
      },
      { deliverAs: "nextTurn" },
    );
    expect(sentMessages[0]?.content).not.toContain(
      "OpenClaw runtime context for the immediately preceding user message.",
    );
    expect(sentMessages[0]?.content).not.toContain("not user-authored");
  });

  it("labels next-turn runtime context only when used as prompt-local system context", () => {
    const systemContext = buildRuntimeContextSystemContext("secret runtime context");

    expect(systemContext).toContain(
      "OpenClaw runtime context for the immediately preceding user message.",
    );
    expect(systemContext).toContain("not user-authored");
    expect(systemContext).toContain("secret runtime context");
  });

  it("labels runtime-only events as system context", async () => {
    const { buildRuntimeEventSystemContext } = await import("./runtime-context-prompt.js");

    expect(buildRuntimeEventSystemContext("internal event")).toContain("OpenClaw runtime event.");
    expect(buildRuntimeEventSystemContext("internal event")).toContain("not user-authored");
  });

  // ── A1a: orphan user text 不走 runtime-context ─────────────────────────────
  //
  // 2026-07-06 Morii 案 root cause: mergeOrphanedTrailingUserPrompt 生成的
  // effectivePrompt 以 QUEUED marker 打头。老 resolveRuntimeContextPromptParts
  // 把 [QUEUED marker + orphan text] 切进 runtimeContext, 后续 turn 组装
  // messages 时 stripHistoricalRuntimeContextCustomMessages 按 lastUserIndex
  // 剔除, 导致 orphan text 内容永久丢失(agent 看不到"叫我玖玖")。
  //
  // 修法: orphan 段落识别后, orphan text 拼进 prompt(transcript 侧), runtime-
  // context 不带 QUEUED marker。这样 orphan text 变成消息树上真 user 节点的
  // content, 不再依赖会被 strip 的 runtime-context 承载。
  it("merges orphaned user text into the visible prompt instead of runtime context", () => {
    const orphanText = "叫我玖玖";
    const newUserText = "你不是有个软件吗？那个软件怎么下载呀";
    const queuedMarker =
      "[Queued user message that arrived while the previous turn was still active]";

    // mergeOrphanedTrailingUserPrompt 生成的 effectivePrompt 形态
    const effectivePrompt = [queuedMarker, orphanText, "", newUserText].join("\n");

    const parts = resolveRuntimeContextPromptParts({
      effectivePrompt,
      transcriptPrompt: newUserText,
    });

    // orphan text 进 prompt(会写进消息树的 user 节点), 不进 runtimeContext
    expect(parts.prompt).toContain(orphanText);
    expect(parts.prompt).toContain(newUserText);
    // QUEUED marker 是运维标记, 不应流入 user 消息
    expect(parts.prompt).not.toContain(queuedMarker);
    // runtimeContext 要么没有, 要么不含 orphan text(否则等于回到老 bug)
    if (parts.runtimeContext !== undefined) {
      expect(parts.runtimeContext).not.toContain(orphanText);
      expect(parts.runtimeContext).not.toContain(queuedMarker);
    }
  });

  it("keeps non-orphan runtime context in the hidden channel(回归安全)", () => {
    // 老场景:纯粹的 runtime-context 内容(不是 orphan)不受影响
    // effectivePrompt 头部含一段既不是 QUEUED marker 也不是 delimited block 的 prefix
    const effectivePrompt = ["runtime prefix", "", "visible ask"].join("\n");

    const parts = resolveRuntimeContextPromptParts({
      effectivePrompt,
      transcriptPrompt: "visible ask",
    });

    expect(parts.prompt).toBe("visible ask");
    expect(parts.runtimeContext).toBe("runtime prefix");
  });

  it("runtime-only event 场景不走 orphan 分支(prompt 空 → 保留 runtime-only)", () => {
    // transcriptPrompt 为空 = 系统触发的 runtime event, orphan 内容应保留在
    // runtimeContext 里走 runtime-only 分支, 不能被误当"user prompt 附加内容"。
    // 若强行拼进 prompt, 下游 messages 状态会异常。
    const queuedMarker =
      "[Queued user message that arrived while the previous turn was still active]";
    const effectivePrompt = [queuedMarker, "叫我yvon", "", "some runtime event body"].join("\n");

    const parts = resolveRuntimeContextPromptParts({
      effectivePrompt,
      transcriptPrompt: "",
    });

    // 空 prompt → 走 runtime-only, prompt 是固定标记
    expect(parts.prompt).toBe("Continue the OpenClaw runtime event.");
    expect(parts.runtimeOnly).toBe(true);
    // orphan 内容不擅自剥离, 完整跟 runtime event body 一起进 runtimeContext
    expect(parts.runtimeContext).toContain("叫我yvon");
  });
});
