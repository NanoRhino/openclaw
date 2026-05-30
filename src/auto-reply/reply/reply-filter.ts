// reply-filter v6 (delivery chokepoint, supersedes patch-004)
//
// Strips agent-internal narration / tool references / meta-summary paragraphs
// from outbound text before they reach the channel handler. Two-phase filter:
//  1. Fast regex reject per paragraph (no API call).
//  2. LLM classification (Bedrock Haiku by default; Anthropic API fallback).
//     The LLM is asked to return a small JSON object {"filter": true|false};
//     parsing strips optional ```json fences and falls back to the legacy
//     "true"-prefix heuristic if JSON.parse fails.
//
// Activation is gated by ~/.openclaw/reply-filter.json (or
// $OPENCLAW_STATE_DIR/reply-filter.json). The agent-id is derived from the
// session key segment ("agent:<agentId>:..."); the filter applies only to
// agents matching the include/exclude list.
//
// Configuration is hot-reloaded via mtime stamping so toggling enabled/exclude
// at runtime takes effect without a restart.

import _replyFilterFs from "node:fs";
import type { OpenClawConfig } from "../../config/types.js";

type ReplyFilterMode = "include" | "exclude";

type ReplyFilterCfg = {
  enabled?: boolean;
  mode?: ReplyFilterMode;
  include?: readonly string[];
  exclude?: readonly string[];
  llm?: boolean;
  provider?: "bedrock" | "anthropic";
  model?: string;
  region?: string;
  apiKey?: string;
};

type FilterResult = { drop: boolean; text: string };

let _replyFilterCfg: ReplyFilterCfg | null = null;
let _replyFilterCfgMtime = 0;

function _loadReplyFilterCfg(): ReplyFilterCfg | null {
  try {
    if (!_replyFilterFs) return null;
    const cfgPath = process.env.OPENCLAW_STATE_DIR
      ? process.env.OPENCLAW_STATE_DIR + "/reply-filter.json"
      : (process.env.HOME ?? "/root") + "/.openclaw/reply-filter.json";
    const stat = _replyFilterFs.statSync(cfgPath);
    if (stat.mtimeMs !== _replyFilterCfgMtime) {
      _replyFilterCfg = JSON.parse(_replyFilterFs.readFileSync(cfgPath, "utf-8"));
      _replyFilterCfgMtime = stat.mtimeMs;
    }
  } catch {
    _replyFilterCfg = null;
  }
  return _replyFilterCfg;
}

function _fastReject(p: string): boolean {
  if (
    /(?:data\/|\.json|\.md|\.py|\.sh|baseDir|workspaceDir|scripts\/)/.test(p) &&
    !/^[>*\-]/.test(p)
  )
    return true;
  if (
    /(?:已写入|已保存到|已记录到|已更新.*文件|written to|saved to|logged to)/i.test(p) &&
    /\.(?:json|md|csv)\b/.test(p)
  )
    return true;
  if (/^\s*NO_REPLY\s*$/.test(p)) return true;
  if (/(?:已通过.{1,6}回复|已发送到|already sent|already replied)/i.test(p)) return true;
  if (
    /^(?:Let me |I'll (?:now |check |look |read |update )|I will (?:now |check )|Now I(?:'ll| will| need to) |Now let me |Looking at |Checking |Reading |Writing |Updating |Creating |Running |Calling |Executing )/i.test(
      p,
    )
  )
    return true;
  if (
    /^(?:我来(?:看|查|检查|读|更新)|让我(?:看|查|检查)|我先(?:看|查|读)|现在我(?:来|去)|我看[看下一](?:这|你|那)|我检查一下|我查[看一])/i.test(
      p,
    )
  )
    return true;
  if (
    /^(?:Here'?s what I (?:did|found)|Done[.!]?\s*(?:I |Here)|OK[,.]?\s*(?:I've |I (?:just |already )))/i.test(
      p,
    )
  )
    return true;
  if (/^好的[，,]?\s*我(?:已经|来|先)/.test(p)) return true;
  if (/^(?:执行|调用|运行|正在(?:读取|写入|更新|检查|处理))/.test(p) && p.length < 80) return true;
  if (
    /\b(insufficient[_ ]data|no (?:message sent|action taken)|cron (?:preserved|job preserved)|will retry tomorrow|pre-send check)\b/i.test(
      p,
    )
  )
    return true;
  if (
    /^(?:The message should (?:combine|include|mention|start)|compose a|write a message that|draft the|send a (?:photo|image) invite)/i.test(
      p,
    )
  )
    return true;
  if (
    /\b(?:days_silent|Tier [0-3]|current_streak|Stage:|consecutive_increases|active_strategy|logging_gaps|no same weekday data)\b/.test(
      p,
    )
  )
    return true;
  return false;
}

type _ReplyFilterCacheEntry = boolean;

const _replyFilterCache: Map<string, _ReplyFilterCacheEntry> & {
  _brClient?: unknown;
} = new Map() as Map<string, _ReplyFilterCacheEntry> & { _brClient?: unknown };

const _FILTER_PROMPT = `Classify this chatbot paragraph. Output ONLY "true" (filter) or "false" (keep).

Filter if ANY of these apply:
- Internal narration ("Let me check...", "Now I'll...", "Now I have everything needed...")
- Tool/file references (data/, .json, .md, scripts/, baseDir, workspaceDir)
- Internal reports ("已写入", "已保存", "saved to", "written to")
- Delivery notices ("已通过微信回复", "already sent")
- Meta-summary ("Here's what I did", "Done. I...")
- Cron/scheduling status ("insufficient data", "cron preserved", "will retry", "no action taken", "no message sent", "skipping pattern detection")
- Composition instructions ("The message should combine...", "compose a...", "send a photo invite with...")
- Internal reasoning about user state ("days_silent", "Tier 2", "current_streak", "Stage:", "consecutive_increases", "active_strategy", "logging_gaps")
- English-language planning or analysis clearly not meant for the end user

Keep if: the text is a normal user-facing message in the user's language (Chinese, etc.), a greeting, a meal reminder, encouragement, dietary advice, or any content clearly written FOR the user.

"""
{text}
"""

Reply with ONLY a JSON object: {"filter": true} or {"filter": false}. No explanation, no markdown fences, no surrounding text — just the raw JSON.`;

async function _classifyParagraph(text: string, filterCfg: ReplyFilterCfg): Promise<boolean> {
  const cacheKey = text.trim().slice(0, 200);
  const cached = _replyFilterCache.get(cacheKey);
  if (cached !== undefined) return cached;
  try {
    const prompt = _FILTER_PROMPT.replace("{text}", text.slice(0, 500));
    let answer: string | undefined;
    if ((filterCfg.provider ?? "bedrock") === "bedrock") {
      const model = filterCfg.model ?? "anthropic.claude-haiku-4-5-20250620-v1:0";
      const region = filterCfg.region ?? "us-east-1";
      const _sdkCandidates = [
        process.cwd() + "/node_modules/@aws-sdk/client-bedrock-runtime/dist-cjs/index.js",
        process.cwd() + "/openclaw/node_modules/@aws-sdk/client-bedrock-runtime/dist-cjs/index.js",
        (process.env.HOME ?? "/root") +
          "/.openclaw/extensions/qqbot/node_modules/@aws-sdk/client-bedrock-runtime/dist-cjs/index.js",
        (process.env.HOME ?? "/root") +
          "/.openclaw/extensions/wechat/node_modules/@aws-sdk/client-bedrock-runtime/dist-cjs/index.js",
      ];
      const sdkPath = _sdkCandidates.find((p) => {
        try {
          return _replyFilterFs.existsSync(p);
        } catch {
          return false;
        }
      });
      if (!sdkPath) {
        console.error("[reply-filter] AWS SDK not found at known paths");
        return false;
      }
      let _brMod: unknown;
      try {
        _brMod = (await import(sdkPath)) as unknown;
      } catch {
        try {
          const { createRequire: _cr2 } = await import("node:module");
          _brMod = _cr2(import.meta.url)(sdkPath) as unknown;
        } catch (e2) {
          const err = e2 as Error;
          console.error("[reply-filter] Cannot load AWS SDK:", err?.message?.slice(0, 80));
          return false;
        }
      }
      const { BedrockRuntimeClient, InvokeModelCommand } = _brMod as {
        BedrockRuntimeClient: new (opts: { region: string }) => {
          send: (cmd: unknown) => Promise<{ body: Uint8Array }>;
        };
        InvokeModelCommand: new (opts: unknown) => unknown;
      };
      if (!_replyFilterCache._brClient) {
        _replyFilterCache._brClient = new BedrockRuntimeClient({ region });
      }
      const cmd = new InvokeModelCommand({
        modelId: model,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 30,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const client = _replyFilterCache._brClient as {
        send: (cmd: unknown) => Promise<{ body: Uint8Array }>;
      };
      const res = await client.send(cmd);
      const body = JSON.parse(new TextDecoder().decode(res.body));
      answer = body?.content?.[0]?.text?.trim();
    } else {
      const model = filterCfg.model ?? "claude-haiku-4-5";
      let apiKey = filterCfg.apiKey;
      if (!apiKey) {
        const home = process.env.HOME ?? "/root";
        const authPath = home + "/.openclaw/agents/main/agent/auth-profiles.json";
        const authData = JSON.parse(_replyFilterFs.readFileSync(authPath, "utf-8"));
        apiKey = authData?.profiles?.["anthropic:default"]?.key;
      }
      if (!apiKey) return false;
      const resp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 30,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(3000),
      });
      const result = (await resp.json()) as { content?: Array<{ text?: string }> };
      answer = result?.content?.[0]?.text?.trim();
    }
    // v6: prefer JSON output {"filter": true|false}; strip optional markdown
    // fences in case the model wraps the JSON. Fall back to the legacy
    // "true"-prefix heuristic when the response is not a {"filter": ...}
    // object — covers JSON.parse failures AND legitimate JSON like a bare
    // `true`/`false` token (which parses but lacks the `filter` key).
    const rawAnswer = (answer ?? "").trim();
    const cleanedAnswer = rawAnswer
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    let shouldFilter: boolean | undefined;
    try {
      const parsed = JSON.parse(cleanedAnswer) as unknown;
      if (parsed && typeof parsed === "object" && "filter" in parsed) {
        shouldFilter = (parsed as { filter?: unknown }).filter === true;
      }
    } catch {
      // fall through to legacy heuristic
    }
    if (shouldFilter === undefined) {
      shouldFilter = cleanedAnswer.toLowerCase().startsWith("true");
    }
    if (_replyFilterCache.size > 200) {
      const brClient = _replyFilterCache._brClient;
      _replyFilterCache.clear();
      if (brClient) _replyFilterCache._brClient = brClient;
    }
    _replyFilterCache.set(cacheKey, shouldFilter);
    return shouldFilter;
  } catch (e) {
    const err = e as Error;
    console.error("[reply-filter] LLM classify error:", err?.name, err?.message?.slice(0, 120));
    return false;
  }
}

export async function filterReplyText(
  text: string,
  _cfg: OpenClawConfig | undefined,
  sessionKey: string | undefined,
): Promise<FilterResult> {
  const filterCfg = _loadReplyFilterCfg();
  if (!filterCfg?.enabled) return { drop: false, text };
  // FAIL-SAFE (patch-003): sessionKey 缺失时不再 fallback 成 "main"，让 filter 必跑
  // 旧实现把 sessionKey 空 → "main" → 命中 exclude，结果给微信用户漏了 model reasoning
  const agentId = sessionKey?.split(":")?.[1];

  // === patch-003 telemetry (filter-bypass-suspect) ===
  // 留证据：每次 chokepoint 触发时如果 sessionKey 缺失就 warn，方便定位是哪个上游路径传丢了
  if (!agentId) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "filter-bypass-suspect: sessionKey missing at chokepoint",
        sessionKey: sessionKey ?? null,
        mode: filterCfg.mode,
        textHead: typeof text === "string" ? text.slice(0, 80) : null,
        ts: new Date().toISOString(),
      }),
    );
  }
  // === end telemetry ===

  const list = filterCfg.exclude ?? filterCfg.include ?? [];
  // agentId 为空时永远不命中 exclude，filter 必跑（fail-safe）
  if (filterCfg.mode === "exclude" && agentId && list.includes(agentId))
    return { drop: false, text };
  // include 模式同理：sessionKey 空 → 视为不在白名单，filter 跑
  if (filterCfg.mode === "include" && !(agentId && list.includes(agentId)))
    return { drop: false, text };
  if (!text) return { drop: false, text };
  // NO_REPLY handling: smart strip instead of blind drop
  if (/\bNO_REPLY\b/.test(text)) {
    if (/^\s*NO_REPLY\s*$/.test(text)) return { drop: true, text: "" };
    const _nrParas = text.split(/\n\n+/).filter((p) => {
      const t = p.trim();
      if (/^\s*NO_REPLY\s*$/.test(t)) return false;
      if (/^(?:Wait|Hmm|Actually|Let me reconsider|On second thought)/i.test(t)) return false;
      return true;
    });
    if (_nrParas.length === 0) return { drop: true, text: "" };
    text = _nrParas.join("\n\n");
  }
  if (text.trim().length < 10) return { drop: false, text };
  // Phase 1: fast regex reject per paragraph
  const paragraphs = text.split(/\n\n+/);
  const afterRegex = paragraphs.filter((p) => !_fastReject(p.trim()));
  if (afterRegex.length === 0) return { drop: true, text: "" };
  // Phase 2: LLM classification on surviving paragraphs
  if (filterCfg.llm !== false) {
    const results = await Promise.all(
      afterRegex.map(async (p) => {
        const shouldFilter = await _classifyParagraph(p.trim(), filterCfg);
        return shouldFilter ? null : p;
      }),
    );
    const kept = results.filter((p): p is string => p !== null);
    if (kept.length === 0) return { drop: true, text: "" };
    return { drop: false, text: kept.join("\n\n") };
  }
  return { drop: false, text: afterRegex.join("\n\n") };
}
