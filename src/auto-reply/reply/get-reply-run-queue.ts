import { logVerbose } from "../../globals.js";
import type { ReplyPayload } from "../types.js";
import type { ActiveRunQueueAction } from "./queue-policy.js";
import type { QueueSettings } from "./queue.js";

export type ReplyRunQueueBusyState = {
  activeSessionId: string | undefined;
  isActive: boolean;
  isStreaming: boolean;
};

export const REPLY_RUN_STILL_SHUTTING_DOWN_TEXT =
  "⚠️ Previous run is still shutting down. Please try again in a moment.";

export async function resolvePreparedReplyQueueState(params: {
  activeRunQueueAction: ActiveRunQueueAction;
  activeSessionId: string | undefined;
  queueMode: QueueSettings["mode"];
  sessionKey: string | undefined;
  sessionId: string;
  abortActiveRun: (sessionId: string) => boolean;
  waitForActiveRunEnd: (sessionId: string) => Promise<unknown>;
  refreshPreparedState: () => Promise<void>;
  resolveBusyState: () => ReplyRunQueueBusyState;
  // patch-010: 旧 run abort 后仍未 drain 完时的额外轮询重试次数(默认 3)。
  // 每次重试再 await waitForActiveRunEnd(内部带 15s 超时)。修连发竞态导致的
  // "still shutting down" 静默漏回(abort 异步, 旧 run shutdown 有窗口)。
  maxShutdownRetries?: number;
}): Promise<
  { kind: "continue"; busyState: ReplyRunQueueBusyState } | { kind: "reply"; reply: ReplyPayload }
> {
  if (params.activeRunQueueAction !== "run-now" || !params.activeSessionId) {
    return { kind: "continue", busyState: params.resolveBusyState() };
  }

  if (params.queueMode === "interrupt") {
    const aborted = params.abortActiveRun(params.activeSessionId);
    logVerbose(
      `Interrupting active run for ${params.sessionKey ?? params.sessionId} (aborted=${aborted})`,
    );
  }

  // patch-010: abort 是异步的, 旧 run 有 shutdown 窗口。等一次后若仍 active,
  // 不要立刻放弃(原逻辑直接返回 "still shutting down", 该提示又被 reply-filter
  // 吞掉 -> 用户连发消息静默漏回)。改为有限次轮询重试, 等旧 run 真正 drain 完再继续。
  const maxRetries = Math.max(0, params.maxShutdownRetries ?? 3);
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await params.waitForActiveRunEnd(params.activeSessionId);
    await params.refreshPreparedState();
    const refreshedBusyState = params.resolveBusyState();
    if (!refreshedBusyState.isActive) {
      return { kind: "continue", busyState: refreshedBusyState };
    }
  }
  // 重试耗尽仍 active(极少见): 返回 shutdown 提示。注意 reply-filter 会吞掉它,
  // 所以这只是保底, A 的重试已让绝大多数连发竞态在这之前就 continue。
  return {
    kind: "reply",
    reply: {
      text: REPLY_RUN_STILL_SHUTTING_DOWN_TEXT,
    },
  };
}
