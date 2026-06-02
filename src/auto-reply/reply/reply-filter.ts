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
  traceLog?: boolean;
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

// === reply-filter v6 trace metadata (patch-008) ===
// _classifyParagraph side-channel: each call writes here, wrapper reads it.
type _ClassifyMeta = {
  raw: string | null;
  error: string | null;
  ms: number;
  cacheHit: boolean;
  llmCalled: boolean;
};
let _lastClassifyMeta: _ClassifyMeta = {
  raw: null,
  error: null,
  ms: 0,
  cacheHit: false,
  llmCalled: false,
};
function _resetClassifyMeta(): void {
  _lastClassifyMeta = {
    raw: null,
    error: null,
    ms: 0,
    cacheHit: false,
    llmCalled: false,
  };
}

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
- Quoted internal reasoning (e.g. "Actually example: ...", "Let me try: ...", text that quotes a draft message in quotes)
- Self-correction/meta-thought ("Wait —", "Hmm,", "Actually, ...", "let me reconsider", "On second thought")
- English-language planning or analysis clearly not meant for the end user

Keep if: the text is a normal user-facing message in the user's language (Chinese, etc.), a greeting, a meal reminder, encouragement, dietary advice, or any content clearly written FOR the user.

"""
{text}
"""

Reply with ONLY a JSON object: {"filter": true} or {"filter": false}. No explanation, no markdown fences, no surrounding text — just the raw JSON.`;

async function _classifyParagraph(text: string, filterCfg: ReplyFilterCfg): Promise<boolean> {
  const _t0 = Date.now();
  _resetClassifyMeta();
  const cacheKey = text.trim().slice(0, 200);
  const cached = _replyFilterCache.get(cacheKey);
  if (cached !== undefined) {
    _lastClassifyMeta.cacheHit = true;
    _lastClassifyMeta.ms = Date.now() - _t0;
    return cached;
  }
  try {
    const prompt = _FILTER_PROMPT.replace("{text}", text.slice(0, 500));
    let answer: string | undefined;
    _lastClassifyMeta.llmCalled = true;
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
      // patch-009: use Bedrock Tools API to enforce JSON schema on output.
      // Previous raw-text mode relied on string parsing which had a 37.8%
      // false-negative rate when LLM appended trailing explanation after
      // the JSON ({"filter":true}\n\nThis is...). Tools API guarantees
      // structured boolean output via stop_reason=tool_use.
      const cmd = new InvokeModelCommand({
        modelId: model,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({
          anthropic_version: "bedrock-2023-05-31",
          max_tokens: 100,
          tools: [
            {
              name: "classify_paragraph",
              description:
                "Classify the paragraph as filter (hide from user) or keep (show to user)",
              input_schema: {
                type: "object",
                properties: {
                  filter: {
                    type: "boolean",
                    description:
                      "true = hide this paragraph from user (it is internal/narration), false = show to user",
                  },
                },
                required: ["filter"],
              },
            },
          ],
          tool_choice: { type: "tool", name: "classify_paragraph" },
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const client = _replyFilterCache._brClient as {
        send: (cmd: unknown) => Promise<{ body: Uint8Array }>;
      };
      const res = await client.send(cmd);
      const body = JSON.parse(new TextDecoder().decode(res.body));
      // Try tools API path first: content[].type=tool_use, input.filter is boolean.
      const _toolUse = (
        body?.content as Array<{ type?: string; input?: { filter?: unknown } }> | undefined
      )?.find((c) => c?.type === "tool_use");
      if (_toolUse && typeof _toolUse.input?.filter === "boolean") {
        answer = JSON.stringify({ filter: _toolUse.input.filter });
      } else if (_toolUse) {
        // Tool was called but `filter` is not a boolean (e.g. Haiku returns "<UNKNOWN>"
        // when uncertain). Conservative: treat as filter:true (DROP) to err on side of
        // hiding suspicious paragraphs rather than leaking them.
        answer = JSON.stringify({ filter: true });
      } else {
        // No tool_use block at all — fallback: capture text for legacy parsing path.
        answer = (body?.content as Array<{ type?: string; text?: string }> | undefined)
          ?.find((c) => c?.type === "text")
          ?.text?.trim();
      }
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
          max_tokens: 100,
          tools: [
            {
              name: "classify_paragraph",
              description:
                "Classify the paragraph as filter (hide from user) or keep (show to user)",
              input_schema: {
                type: "object",
                properties: {
                  filter: {
                    type: "boolean",
                    description:
                      "true = hide this paragraph from user (it is internal/narration), false = show to user",
                  },
                },
                required: ["filter"],
              },
            },
          ],
          tool_choice: { type: "tool", name: "classify_paragraph" },
          messages: [{ role: "user", content: prompt }],
        }),
        signal: AbortSignal.timeout(3000),
      });
      const result = (await resp.json()) as {
        content?: Array<{ type?: string; text?: string; input?: { filter?: unknown } }>;
      };
      // Try tools API path first: content[].type=tool_use, input.filter is boolean.
      const _antToolUse = result?.content?.find((c) => c?.type === "tool_use");
      if (_antToolUse && typeof _antToolUse.input?.filter === "boolean") {
        answer = JSON.stringify({ filter: _antToolUse.input.filter });
      } else if (_antToolUse) {
        // Tool was called but `filter` is not a boolean (uncertain): treat as DROP.
        answer = JSON.stringify({ filter: true });
      } else {
        // No tool_use block — fallback: text content.
        answer = result?.content?.find((c) => c?.type === "text")?.text?.trim();
      }
    }
    // v6: prefer JSON output {"filter": true|false}; strip optional markdown
    // fences in case the model wraps the JSON. Fall back to the legacy
    // "true"-prefix heuristic when the response is not a {"filter": ...}
    // object — covers JSON.parse failures AND legitimate JSON like a bare
    // `true`/`false` token (which parses but lacks the `filter` key).
    const rawAnswer = (answer ?? "").trim();
    _lastClassifyMeta.raw = rawAnswer;
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
    _lastClassifyMeta.ms = Date.now() - _t0;
    return shouldFilter;
  } catch (e) {
    const err = e as Error;
    console.error("[reply-filter] LLM classify error:", err?.name, err?.message?.slice(0, 120));
    _lastClassifyMeta.error = (err?.name ?? "Error") + ": " + (err?.message?.slice(0, 200) ?? "");
    _lastClassifyMeta.ms = Date.now() - _t0;
    return false;
  }
}

export async function filterReplyText(
  text: string,
  _cfg: OpenClawConfig | undefined,
  sessionKey: string | undefined,
): Promise<FilterResult> {
  const t0 = Date.now();
  const filterCfg = _loadReplyFilterCfg();
  const inputText = typeof text === "string" ? text : "";
  const inputLen = inputText.length;
  const traceLogEnabled = filterCfg?.traceLog !== false;
  const agentId = sessionKey?.split(":")?.[1];

  type PerParaEntry = {
    i: number;
    text: string;
    len: number;
    fastRejectHit: boolean;
    llmCalled: boolean;
    llmRaw: string | null;
    llmDecision: boolean | null;
    llmError: string | null;
    llmMs: number | null;
    cacheHit: boolean;
    finalDecision: "drop" | "keep";
  };
  const perPara: PerParaEntry[] = [];

  function emit(decision: string, outputText: string, paragraphCount: number): void {
    if (!traceLogEnabled) return;
    const keptCount = perPara.filter((p) => p.finalDecision === "keep").length;
    const droppedCount = perPara.filter((p) => p.finalDecision === "drop").length;
    console.log(
      JSON.stringify({
        level: "info",
        msg: "reply-filter:trace",
        ts: new Date().toISOString(),
        sessionKey: sessionKey ?? null,
        agentId: agentId ?? null,
        mode: filterCfg?.mode ?? null,
        enabled: !!filterCfg?.enabled,
        decision,
        inputText,
        outputText,
        inputLen,
        outputLen: outputText.length,
        paragraphCount,
        keptCount,
        droppedCount,
        elapsedMs: Date.now() - t0,
        perPara,
      }),
    );
  }

  if (!filterCfg?.enabled) {
    emit("disabled", inputText, 0);
    return { drop: false, text };
  }

  // === filter-bypass-suspect telemetry (kept) ===
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
  if (filterCfg.mode === "exclude" && agentId && list.includes(agentId)) {
    emit("excluded", inputText, 0);
    return { drop: false, text };
  }
  if (filterCfg.mode === "include" && !(agentId && list.includes(agentId))) {
    emit("included_passthrough", inputText, 0);
    return { drop: false, text };
  }
  if (!text) {
    emit("kept_all", text, 0);
    return { drop: false, text };
  }

  // NO_REPLY handling: smart strip instead of blind drop (logic unchanged)
  if (/\bNO_REPLY\b/.test(text)) {
    if (/^\s*NO_REPLY\s*$/.test(text)) {
      emit("dropped_all", "", 1);
      return { drop: true, text: "" };
    }
    const _nrParas = text.split(/\n\n+/).filter((p) => {
      const t = p.trim();
      if (/^\s*NO_REPLY\s*$/.test(t)) return false;
      if (/^(?:Wait|Hmm|Actually|Let me reconsider|On second thought)/i.test(t)) return false;
      return true;
    });
    if (_nrParas.length === 0) {
      emit("dropped_all", "", text.split(/\n\n+/).length);
      return { drop: true, text: "" };
    }
    text = _nrParas.join("\n\n");
  }

  if (text.trim().length < 10) {
    emit("kept_all", text, 1);
    return { drop: false, text };
  }

  // Phase 1: dedup + fast regex reject (logic unchanged, but record per-para trace)
  const paragraphs = text.split(/\n\n+/);
  const _v61SeenParagraphs = new Set<string>();
  const survivors: { idx: number; p: string }[] = [];
  paragraphs.forEach((p, idx) => {
    const key = p.trim();
    let dedup = false;
    if (key.length >= 20) {
      if (_v61SeenParagraphs.has(key)) {
        dedup = true;
      } else {
        _v61SeenParagraphs.add(key);
      }
    }
    const fastHit = !dedup && _fastReject(key);
    if (dedup || fastHit) {
      perPara.push({
        i: idx,
        text: p,
        len: p.length,
        fastRejectHit: fastHit,
        llmCalled: false,
        llmRaw: null,
        llmDecision: null,
        llmError: dedup ? "v6.1_dedup" : null,
        llmMs: null,
        cacheHit: false,
        finalDecision: "drop",
      });
    } else {
      survivors.push({ idx, p });
    }
  });

  if (survivors.length === 0) {
    emit("dropped_all", "", paragraphs.length);
    return { drop: true, text: "" };
  }

  // Phase 2: LLM classification on survivors (logic unchanged)
  if (filterCfg.llm !== false) {
    const results = await Promise.all(
      survivors.map(async ({ idx, p }) => {
        const shouldFilter = await _classifyParagraph(p.trim(), filterCfg);
        const meta = { ..._lastClassifyMeta };
        perPara.push({
          i: idx,
          text: p,
          len: p.length,
          fastRejectHit: false,
          llmCalled: meta.llmCalled,
          llmRaw: meta.raw,
          llmDecision: shouldFilter,
          llmError: meta.error,
          llmMs: meta.ms,
          cacheHit: meta.cacheHit,
          finalDecision: shouldFilter ? "drop" : "keep",
        });
        return shouldFilter ? null : p;
      }),
    );
    const kept = results.filter((p): p is string => p !== null);
    perPara.sort((a, b) => a.i - b.i);
    if (kept.length === 0) {
      emit("dropped_all", "", paragraphs.length);
      return { drop: true, text: "" };
    }
    const outText = kept.join("\n\n");
    emit(kept.length === paragraphs.length ? "kept_all" : "partial", outText, paragraphs.length);
    return { drop: false, text: outText };
  }

  // No-LLM fallback: only fast-reject + dedup applied
  survivors.forEach(({ idx, p }) => {
    perPara.push({
      i: idx,
      text: p,
      len: p.length,
      fastRejectHit: false,
      llmCalled: false,
      llmRaw: null,
      llmDecision: null,
      llmError: null,
      llmMs: null,
      cacheHit: false,
      finalDecision: "keep",
    });
  });
  perPara.sort((a, b) => a.i - b.i);
  const outText = survivors.map((s) => s.p).join("\n\n");
  emit(survivors.length === paragraphs.length ? "kept_all" : "partial", outText, paragraphs.length);
  return { drop: false, text: outText };
}
