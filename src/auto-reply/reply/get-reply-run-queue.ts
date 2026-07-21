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

  // 此函数现在只剩 reset(/new、/reset)会走到(reset 被强制当 interrupt 处理且仍
  // run-now —— 它要换 session、立刻在新上下文响应,不入队)。连发场景的 interrupt
  // 已改走 enqueue-followup + drain(见 queue-policy.ts),不再经过这里,patch-010
  // 那套"abort 后等待重试 → 耗尽放弃 → still-shutting-down 静默漏回"已废弃删除。
  // reset 是低频用户主动操作,保留框架原始的"等一次,仍 active 才保底提示"语义即可。
  await params.waitForActiveRunEnd(params.activeSessionId);
  await params.refreshPreparedState();
  const refreshedBusyState = params.resolveBusyState();
  if (refreshedBusyState.isActive) {
    return {
      kind: "reply",
      reply: {
        text: REPLY_RUN_STILL_SHUTTING_DOWN_TEXT,
      },
    };
  }
  return { kind: "continue", busyState: refreshedBusyState };
}
