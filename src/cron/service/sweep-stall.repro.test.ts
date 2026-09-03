/**
 * session reaper 卡住不能拖死 cron 调度。
 *
 * 2026-09-03 线上事故：某台 gateway 的 cron 在 11:25:21 之后停止调度，网关其余功能
 * 全部正常、无任何报错，70 个任务积压 40 分钟，最后靠重启恢复。
 *
 * 机制：onTimer 的 finally 里先 await sweepCronRunSessions（内部三步都是没有超时的
 * 文件 I/O），再 `state.running = false`。sweep 自己的 try/catch 接不住"永不 resolve"，
 * 于是 running 永远为 true，之后每次 tick 进 onTimer 立刻 return —— 静默停摆。
 */
import { describe, expect, it, vi } from "vitest";
import {
  noopLogger,
  setupCronRegressionFixtures,
  writeCronJobs,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createCronServiceState } from "./state.js";
import { onTimer } from "./timer.js";

const sweepGate = { block: false, release: () => {}, calls: 0 };
vi.mock("../session-reaper.js", () => ({
  sweepCronRunSessions: vi.fn(async () => {
    sweepGate.calls += 1;
    if (sweepGate.block) {
      await new Promise<void>((resolve) => {
        sweepGate.release = resolve;
      });
    }
    return { swept: true, pruned: 0 };
  }),
}));

const fixtures = setupCronRegressionFixtures({ prefix: "cron-sweep-stall-" });

function makeState(storePath: string) {
  return createCronServiceState({
    cronEnabled: true,
    storePath,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn().mockResolvedValue({ status: "ok", summary: "ok" }),
    // 必须给，否则 finally 里 storePaths 为空、整段 sweep 被跳过，测试会假绿。
    sessionStorePath: `${storePath}.sessions.json`,
  });
}

describe("session reaper 卡住不应拖死调度", () => {
  it("sweep 永不返回时，onTimer 仍然收尾，running 复位", async () => {
    const { storePath } = fixtures.makeStorePath();
    await writeCronJobs(storePath, []);
    const state = makeState(storePath);

    sweepGate.block = true;
    vi.useRealTimers();
    const started = Date.now();
    await onTimer(state);
    const elapsed = Date.now() - started;

    expect(state.running, "sweep 卡住时 running 必须复位，否则调度永久静默").toBe(false);
    expect(elapsed, "应当被超时兜住，而不是无限等待").toBeLessThan(45_000);

    sweepGate.release();
    sweepGate.block = false;
  }, 60_000);

  it("sweep 正常时行为不变", async () => {
    const { storePath } = fixtures.makeStorePath();
    await writeCronJobs(storePath, []);
    const state = makeState(storePath);
    sweepGate.block = false;
    const before = sweepGate.calls;

    await onTimer(state);

    expect(state.running).toBe(false);
    expect(sweepGate.calls, "正常路径仍要真正执行清理").toBeGreaterThan(before);
  }, 30_000);

  it("running 卡死超过阈值时，看门狗强制复位并 error 告警", async () => {
    const { storePath } = fixtures.makeStorePath();
    await writeCronJobs(storePath, []);
    const errors: unknown[][] = [];
    const state = makeState(storePath);
    state.deps.log = {
      ...state.deps.log,
      error: (...args: unknown[]) => {
        errors.push(args);
      },
    } as typeof state.deps.log;

    // 模拟"上一轮卡死"：running 置位、起始时刻远在阈值之前
    let clock = 1_000_000;
    state.deps.nowMs = () => clock;
    state.running = true;
    state.runningSinceMs = clock;
    clock += 11 * 60_000; // 超过 10 分钟阈值

    sweepGate.block = false;
    await onTimer(state);

    expect(errors.length, "卡死必须 error 级告警，否则下次仍是静默故障").toBeGreaterThan(0);
    expect(JSON.stringify(errors)).toContain("scheduler stuck");
    expect(state.running, "本轮跑完后应复位").toBe(false);
  }, 30_000);

  it("running 未超阈值时，照旧早退不打扰", async () => {
    const { storePath } = fixtures.makeStorePath();
    await writeCronJobs(storePath, []);
    const state = makeState(storePath);
    let clock = 2_000_000;
    state.deps.nowMs = () => clock;
    state.running = true;
    state.runningSinceMs = clock;
    clock += 30_000; // 只过了 30 秒，属正常长任务

    const before = sweepGate.calls;
    await onTimer(state);

    expect(state.running, "未超阈值不应被强制复位").toBe(true);
    expect(sweepGate.calls, "早退路径不应执行清理").toBe(before);
    state.running = false;
  }, 30_000);
});
