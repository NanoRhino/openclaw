import type { HookHandler } from "../../hooks.js";

function readOptionalNumber(context: Record<string, unknown>, key: string): number | undefined {
  const value = context[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Whether this session's channel may receive the (English, internal-flavored) compaction
 * progress notices. Allowlist by channel: only the wecom operator channel sees them; end-user
 * channels (wechat, douyin, …) must not — the notices are operational status, not a coach reply,
 * and leaked to a wechat user once when reply-filter's LLM call timed out and failed open.
 *
 * sessionKey shape is `agent:<agentId>:<channel>:<...>` (e.g.
 * `agent:wechat-dm-xxx:wechat:default:direct:xxx`, `agent:strategic-management:wecom:direct:xxx`).
 * Parse the channel segment rather than substring-matching, so an agentId that happens to contain
 * "wecom"/"wechat" can't fool the gate.
 */
function compactionNoticeAllowed(sessionKey: string): boolean {
  const parts = (sessionKey || "").split(":");
  // parts[0] === "agent", parts[1] === agentId, parts[2] === channel
  const channel = parts.length >= 3 && parts[0] === "agent" ? parts[2] : undefined;
  return channel === "wecom";
}

const handler: HookHandler = async (event) => {
  try {
    const context = event.context;

    // 仅 wecom 运营渠道展示 compaction 进度;wechat/抖音等终端用户渠道一律不发(白名单)。
    if (event.type === "session" && !compactionNoticeAllowed(event.sessionKey)) {
      return;
    }

    if (event.type === "session" && event.action === "compact:before") {
      const messageCount = readOptionalNumber(context, "messageCount");
      const messageSuffix =
        messageCount !== undefined && messageCount >= 0 ? ` (${messageCount} messages)` : "";
      event.messages.push(
        `🧹 Compacting context${messageSuffix} so I can continue without losing history…`,
      );
      return;
    }

    if (event.type === "session" && event.action === "compact:after") {
      const tokensBefore = readOptionalNumber(context, "tokensBefore");
      const tokensAfter = readOptionalNumber(context, "tokensAfter");
      const tokenDelta =
        tokensBefore !== undefined && tokensAfter !== undefined
          ? ` (${tokensBefore.toLocaleString()} → ${tokensAfter.toLocaleString()} tokens)`
          : "";
      event.messages.push(`✅ Context compacted${tokenDelta}. Continuing from where I left off.`);
    }
  } catch (error) {
    console.warn(
      `[compaction-notifier] failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export default handler;
