import { describe, expect, it } from "vitest";
import { resolveActiveRunQueueAction } from "./queue-policy.js";

describe("resolveActiveRunQueueAction", () => {
  it("runs immediately when there is no active run", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: false,
        isHeartbeat: false,
        shouldFollowup: true,
        queueMode: "collect",
      }),
    ).toBe("run-now");
  });

  it("drops heartbeat runs while another run is active", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: true,
        isHeartbeat: true,
        shouldFollowup: true,
        queueMode: "collect",
      }),
    ).toBe("drop");
  });

  it("enqueues followups for non-heartbeat active runs", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: true,
        isHeartbeat: false,
        shouldFollowup: true,
        queueMode: "collect",
      }),
    ).toBe("enqueue-followup");
  });

  it("enqueues steer mode runs while active", () => {
    for (const queueMode of ["steer", "queue"] as const) {
      expect(
        resolveActiveRunQueueAction({
          isActive: true,
          isHeartbeat: false,
          shouldFollowup: false,
          queueMode,
        }),
      ).toBe("enqueue-followup");
    }
  });

  it("enqueues interrupt mode runs while active (abort已在851发出,新消息靠drain接力)", () => {
    // interrupt 连发场景:旧 run 已被 abort,新消息入队由 drain 在旧 run 释放 mutex
    // 后干净接力,取代了"撞 mutex → 等待重试 → 放弃 → still-shutting-down 漏回"。
    expect(
      resolveActiveRunQueueAction({
        isActive: true,
        isHeartbeat: false,
        shouldFollowup: false,
        queueMode: "interrupt",
      }),
    ).toBe("enqueue-followup");
  });

  it("runs interrupt immediately when no active run", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: false,
        isHeartbeat: false,
        shouldFollowup: false,
        queueMode: "interrupt",
      }),
    ).toBe("run-now");
  });

  it("runs reset-triggered turns immediately while another run is active", () => {
    for (const queueMode of ["steer", "queue", "collect", "followup"] as const) {
      expect(
        resolveActiveRunQueueAction({
          isActive: true,
          isHeartbeat: false,
          shouldFollowup: true,
          queueMode,
          resetTriggered: true,
        }),
      ).toBe("run-now");
    }
  });

  it("keeps heartbeat drops ahead of reset-triggered turns", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: true,
        isHeartbeat: true,
        shouldFollowup: true,
        queueMode: "steer",
        resetTriggered: true,
      }),
    ).toBe("drop");
  });

  it("ignores reset-triggered policy when there is no active run", () => {
    expect(
      resolveActiveRunQueueAction({
        isActive: false,
        isHeartbeat: false,
        shouldFollowup: true,
        queueMode: "collect",
        resetTriggered: true,
      }),
    ).toBe("run-now");
  });
});
