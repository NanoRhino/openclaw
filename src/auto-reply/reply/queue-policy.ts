import type { QueueSettings } from "./queue.js";

export type ActiveRunQueueAction = "run-now" | "enqueue-followup" | "drop";

export function resolveActiveRunQueueAction(params: {
  isActive: boolean;
  isHeartbeat: boolean;
  shouldFollowup: boolean;
  queueMode: QueueSettings["mode"];
  resetTriggered?: boolean;
}): ActiveRunQueueAction {
  if (!params.isActive) {
    return "run-now";
  }
  if (params.isHeartbeat) {
    return "drop";
  }
  if (params.resetTriggered) {
    return "run-now";
  }
  // interrupt 也走入队:851 的 inline block 已对 active run 发了 abort,被 abort 的
  // run 在 finally 里 kick followup drain,新消息由 drain 在旧 run 真正释放 mutex 后
  // 干净接力。取代了"撞 mutex → 等待重试 → 放弃 → still-shutting-down 静默漏回"的老路。
  // (reset 仍走上面的 run-now —— 它要换 session、立刻在新上下文响应,不入队。)
  if (
    params.shouldFollowup ||
    params.queueMode === "steer" ||
    params.queueMode === "queue" ||
    params.queueMode === "interrupt"
  ) {
    return "enqueue-followup";
  }
  return "run-now";
}
