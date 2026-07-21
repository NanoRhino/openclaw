import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRecentMainContext } from "./recent-main-context.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(lines: unknown[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-main-context-"));
  roots.push(root);
  const sessionsDir = path.join(root, "agents", "wechat-user", "sessions");
  const transcript = path.join(sessionsDir, "main-session.jsonl");
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(transcript, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  await fs.writeFile(
    path.join(sessionsDir, "sessions.json"),
    JSON.stringify({
      "agent:wechat-user:wechat:default:direct:user": {
        sessionId: "main-session",
        sessionFile: transcript,
        chatType: "direct",
        updatedAt: 20,
      },
      "agent:wechat-user:cron:old": {
        sessionId: "cron-session",
        sessionFile: path.join(sessionsDir, "cron-session.jsonl"),
        chatType: "direct",
        updatedAt: 30,
      },
    }),
  );
  return { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv;
}

function message(role: string, text: string, extra: Record<string, unknown> = {}) {
  return { type: "message", message: { role, content: [{ type: "text", text }], ...extra } };
}

describe("buildRecentMainContext", () => {
  it("uses the freshest non-cron local direct transcript and strips internal content", async () => {
    const env = await fixture([
      message(
        "user",
        'Conversation info (untrusted metadata):\n```json\n{"sender":"傅小桐"}\n```\n\nSender (untrusted metadata):\n```json\n{"name":"傅小桐"}\n```\n\n我一会饿了可以吃一小把松子吗',
      ),
      message("assistant", "可以，控制在十几颗。"),
      message("toolResult", "secret tool output"),
      message("assistant", "duplicate", { provider: "openclaw", model: "delivery-mirror" }),
    ]);

    const result = await buildRecentMainContext({ agentId: "wechat-user", env });

    expect(result).toContain("User: 我一会饿了可以吃一小把松子吗");
    expect(result).toContain("Assistant: 可以，控制在十几颗。");
    expect(result).not.toContain("secret tool output");
    expect(result).not.toContain("duplicate");
    expect(result).not.toContain("Conversation info");
  });

  it("enforces the local token budget", async () => {
    const env = await fixture([
      message("user", "旧消息"),
      message("assistant", "旧回复"),
      message("user", "最新消息"),
      message("assistant", "最新回复"),
    ]);
    env.CRON_RECENT_MAX_TOKENS = "20";

    const result = await buildRecentMainContext({ agentId: "wechat-user", env });

    expect(result).toContain("最新回复");
    expect(result).not.toContain("旧消息");
  });
});
