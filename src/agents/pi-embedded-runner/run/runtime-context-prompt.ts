import {
  OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER,
  OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  OPENCLAW_RUNTIME_CONTEXT_NOTICE,
  OPENCLAW_RUNTIME_EVENT_HEADER,
} from "../../internal-runtime-context.js";
import type { CurrentTurnPromptContext } from "./params.js";
export { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE };

const OPENCLAW_RUNTIME_EVENT_USER_PROMPT = "Continue the OpenClaw runtime event.";

// 与 attempt.prompt-helpers.ts 里的 QUEUED_USER_MESSAGE_MARKER 保持一致。
// mergeOrphanedTrailingUserPrompt 会在 effectivePrompt 头部拼上
//   [QUEUED marker]\n<orphan text>\n\n<new prompt>
// 这里把该段落识别出来, 让 orphan text 走 transcript 侧(进入消息树 user 节点),
// 而不是被塞进 runtime-context 后被 stripHistoricalRuntimeContextCustomMessages
// 按 lastUserIndex 剔除(2026-07-06 Morii 案 "叫我玖玖" 永久丢失 root cause)。
// marker 本身作为运维标记不应流入 user 消息, 因此从 prompt 里剥离。
const QUEUED_USER_MESSAGE_MARKER =
  "[Queued user message that arrived while the previous turn was still active]";

type RuntimeContextSession = {
  sendCustomMessage: (
    message: {
      customType: string;
      content: string;
      display: boolean;
      details?: Record<string, unknown>;
    },
    options?: { deliverAs?: "nextTurn"; triggerTurn?: boolean },
  ) => Promise<void>;
};

type RuntimeContextPromptParts = {
  prompt: string;
  runtimeContext?: string;
  runtimeOnly?: boolean;
  runtimeSystemContext?: string;
};

export function buildCurrentTurnPromptContextPrefix(
  context: CurrentTurnPromptContext | undefined,
): string {
  return context?.text.trim() ?? "";
}

export function buildCurrentTurnPrompt(params: {
  context: CurrentTurnPromptContext | undefined;
  prompt: string;
}): string {
  const prefix = buildCurrentTurnPromptContextPrefix(params.context);
  if (!prefix) {
    return params.prompt;
  }
  if (!params.prompt) {
    return prefix;
  }
  return [prefix, params.prompt].join(params.context?.promptJoiner ?? "\n\n");
}

function removeLastPromptOccurrence(text: string, prompt: string): string | null {
  const index = text.lastIndexOf(prompt);
  if (index === -1) {
    return null;
  }
  const before = text.slice(0, index).trimEnd();
  const after = text.slice(index + prompt.length).trimStart();
  return [before, after]
    .filter((part) => part.length > 0)
    .join("\n\n")
    .trim();
}

/** 若 runtimeContext 头部是 [QUEUED marker]\n<orphan text> 块, 拆出 orphan text
 *  与剩余的 runtime-context。返回 { orphanText, remaining } 或 null。 */
function extractQueuedOrphanText(
  runtimeContext: string,
): { orphanText: string; remaining: string } | null {
  const normalized = runtimeContext.replace(/\r\n/g, "\n");
  if (!normalized.startsWith(QUEUED_USER_MESSAGE_MARKER)) {
    return null;
  }
  // 结构: [marker]\n<orphan text>[\n\n<remaining>?]
  const afterMarker = normalized.slice(QUEUED_USER_MESSAGE_MARKER.length);
  // 允许 marker 后直接 \n<orphan>
  if (!afterMarker.startsWith("\n")) {
    return null;
  }
  const rest = afterMarker.slice(1);
  // orphan 段落 = 到下一个空行(\n\n)或字符串末尾
  const doubleNewline = rest.indexOf("\n\n");
  const orphanText = doubleNewline === -1 ? rest.trim() : rest.slice(0, doubleNewline).trim();
  const remaining = doubleNewline === -1 ? "" : rest.slice(doubleNewline + 2).trim();
  if (!orphanText) {
    return null;
  }
  return { orphanText, remaining };
}

export function resolveRuntimeContextPromptParts(params: {
  effectivePrompt: string;
  transcriptPrompt?: string;
}): RuntimeContextPromptParts {
  const transcriptPrompt = params.transcriptPrompt;
  if (transcriptPrompt === undefined || transcriptPrompt === params.effectivePrompt) {
    return { prompt: params.effectivePrompt };
  }

  const prompt = transcriptPrompt.trim();
  const rawRuntimeContext =
    removeLastPromptOccurrence(params.effectivePrompt, transcriptPrompt)?.trim() ||
    params.effectivePrompt.trim();

  // Orphan-aware: 若 runtimeContext 承载了 mergeOrphanedTrailingUserPrompt 拼进来
  // 的 [QUEUED marker]\n<orphan text>, 把 orphan text 拼进 prompt(去掉 marker),
  // runtimeContext 只留剩下的部分。这样 orphan text 会以真 user 消息形态进入消息树,
  // 不再依赖会被 stripHistoricalRuntimeContextCustomMessages 剔除的 runtime-context。
  const orphanSplit = rawRuntimeContext ? extractQueuedOrphanText(rawRuntimeContext) : null;
  const promptWithOrphan = orphanSplit ? `${orphanSplit.orphanText}\n\n${prompt}` : prompt;
  const runtimeContext = orphanSplit ? orphanSplit.remaining : rawRuntimeContext;

  if (!promptWithOrphan) {
    return runtimeContext
      ? {
          prompt: OPENCLAW_RUNTIME_EVENT_USER_PROMPT,
          runtimeContext,
          runtimeOnly: true,
          runtimeSystemContext: buildRuntimeEventSystemContext(runtimeContext),
        }
      : { prompt: "" };
  }

  return runtimeContext
    ? { prompt: promptWithOrphan, runtimeContext }
    : { prompt: promptWithOrphan };
}

function buildRuntimeContextMessageContent(params: {
  runtimeContext: string;
  kind: "next-turn" | "runtime-event";
}): string {
  return [
    params.kind === "runtime-event"
      ? OPENCLAW_RUNTIME_EVENT_HEADER
      : OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER,
    OPENCLAW_RUNTIME_CONTEXT_NOTICE,
    "",
    params.runtimeContext,
  ].join("\n");
}

export function buildRuntimeContextSystemContext(runtimeContext: string): string {
  return buildRuntimeContextMessageContent({ runtimeContext, kind: "next-turn" });
}

export function buildRuntimeEventSystemContext(runtimeContext: string): string {
  return buildRuntimeContextMessageContent({ runtimeContext, kind: "runtime-event" });
}

export async function queueRuntimeContextForNextTurn(params: {
  session: RuntimeContextSession;
  runtimeContext?: string;
}): Promise<void> {
  const runtimeContext = params.runtimeContext?.trim();
  if (!runtimeContext) {
    return;
  }
  await params.session.sendCustomMessage(
    {
      customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
      content: runtimeContext,
      display: false,
      details: { source: "openclaw-runtime-context" },
    },
    { deliverAs: "nextTurn" },
  );
}
