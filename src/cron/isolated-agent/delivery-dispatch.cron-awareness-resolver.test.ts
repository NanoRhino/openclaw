import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCronAwarenessSessionKey } from "./delivery-dispatch.js";
import type { SuccessfulDeliveryTarget } from "./delivery-dispatch.js";

// Each test creates an isolated tmp store dir so we don't collide with the
// real on-disk session store. We point resolveDefaultSessionStorePath at it
// via OPENCLAW_HOME (the path resolver honors $HOME / $OPENCLAW_HOME).

let stateDir: string;
const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
});

afterEach(() => {
  if (ORIGINAL_STATE_DIR) {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
  } else {
    delete process.env.OPENCLAW_STATE_DIR;
  }
  try {
    fs.rmSync(stateDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
  vi.resetModules();
});

function makeCfg(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-7",
      },
    },
    session: { mainKey: "main" },
  } as OpenClawConfig;
}

function writeStoreForAgent(
  agentId: string,
  entries: Record<string, Record<string, unknown>>,
): void {
  // Mirror resolveDefaultSessionStorePath's structure under OPENCLAW_STATE_DIR:
  //   <stateDir>/agents/<agentId>/sessions/sessions.json
  // (agentId is lowercased by the path resolver, so we lowercase here too.)
  const agentDir = path.join(stateDir, "agents", agentId.toLowerCase(), "sessions");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "sessions.json"), JSON.stringify(entries, null, 2), "utf-8");
}

function makeDelivery(params: {
  channel: string;
  to?: string;
  mode?: "explicit" | "implicit";
}): SuccessfulDeliveryTarget {
  return {
    ok: true,
    channel: params.channel as SuccessfulDeliveryTarget["channel"],
    to: params.to ?? "",
    mode: params.mode ?? "explicit",
  };
}

describe("resolveCronAwarenessSessionKey (patch-003 v2)", () => {
  it("matches active wechat direct chat session and injects there, not :main", () => {
    const agentId = "wechat-dm-acc1";
    const realChatSk = `agent:${agentId}:wechat:default:direct:acc1`;
    writeStoreForAgent(agentId, {
      [realChatSk]: {
        sessionId: "wechat-direct-session",
        updatedAt: Date.now(),
        lastChannel: "wechat",
        lastTo: "acc1",
      },
      // a stale cron session that should be skipped
      [`agent:${agentId}:cron:job-1`]: {
        sessionId: "cron-1",
        updatedAt: Date.now(),
        lastChannel: "wechat",
        lastTo: "acc1",
      },
    });

    const result = resolveCronAwarenessSessionKey({
      cfg: makeCfg(),
      agentId,
      delivery: makeDelivery({ channel: "wechat", to: "acc1" }),
    });

    expect(result.sessionKey).toBe(realChatSk);
    expect(result.reason).toBe("active");
  });

  it("matches active wecom direct chat session", () => {
    const agentId = "strategic-management";
    const realChatSk = `agent:${agentId}:wecom:direct:fuzhuoran`;
    writeStoreForAgent(agentId, {
      [realChatSk]: {
        sessionId: "wecom-direct",
        updatedAt: Date.now(),
        lastChannel: "wecom",
        lastTo: "fuzhuoran",
      },
    });

    const result = resolveCronAwarenessSessionKey({
      cfg: makeCfg(),
      agentId,
      delivery: makeDelivery({ channel: "wecom", to: "fuzhuoran" }),
    });

    expect(result.sessionKey).toBe(realChatSk);
    expect(result.reason).toBe("active");
  });

  it("matches active wecom group session", () => {
    const agentId = "strategic-management";
    const groupId = "wrfsvodaaayi5sfvsbqhasrdk83jnxvw";
    const realChatSk = `agent:${agentId}:wecom:group:${groupId}`;
    writeStoreForAgent(agentId, {
      [realChatSk]: {
        sessionId: "wecom-group",
        updatedAt: Date.now(),
        lastChannel: "wecom",
        lastTo: groupId,
      },
    });

    const result = resolveCronAwarenessSessionKey({
      cfg: makeCfg(),
      agentId,
      delivery: makeDelivery({ channel: "wecom", to: groupId }),
    });

    expect(result.sessionKey).toBe(realChatSk);
    expect(result.reason).toBe("active");
  });

  it("falls back to :main when no chat session matches (channel, to)", () => {
    const agentId = "wechat-dm-acc1";
    writeStoreForAgent(agentId, {
      // only a cron session, no direct chat session
      [`agent:${agentId}:cron:job-1`]: {
        sessionId: "cron-1",
        updatedAt: Date.now(),
        lastChannel: "wechat",
        lastTo: "acc1",
      },
      // a different user's chat session — should NOT match
      [`agent:${agentId}:wechat:default:direct:other-user`]: {
        sessionId: "other-direct",
        updatedAt: Date.now(),
        lastChannel: "wechat",
        lastTo: "other-user",
      },
    });

    const result = resolveCronAwarenessSessionKey({
      cfg: makeCfg(),
      agentId,
      delivery: makeDelivery({ channel: "wechat", to: "acc1" }),
    });

    expect(result.sessionKey).toBe(`agent:${agentId.toLowerCase()}:main`);
    expect(result.reason).toBe("fallback");
  });

  it("falls back to :main when delivery has no channel/to", () => {
    const agentId = "wechat-dm-acc1";
    writeStoreForAgent(agentId, {
      [`agent:${agentId}:wechat:default:direct:acc1`]: {
        sessionId: "wechat-direct",
        updatedAt: Date.now(),
        lastChannel: "wechat",
        lastTo: "acc1",
      },
    });

    const result = resolveCronAwarenessSessionKey({
      cfg: makeCfg(),
      agentId,
      delivery: makeDelivery({ channel: "", to: undefined }),
    });

    expect(result.reason).toBe("fallback");
  });

  it("falls back to :main when store doesn't exist (fresh user)", () => {
    const agentId = "wechat-dm-brandnew";
    // intentionally no writeStoreForAgent — store file doesn't exist

    const result = resolveCronAwarenessSessionKey({
      cfg: makeCfg(),
      agentId,
      delivery: makeDelivery({ channel: "wechat", to: "brandnew" }),
    });

    expect(result.reason).toBe("fallback");
    expect(result.sessionKey).toBe(`agent:${agentId.toLowerCase()}:main`);
  });
});
