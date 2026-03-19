import type { ReplyFilterConfig } from "../../config/types.agents.js";

const filterCache = new Map<string, boolean>();
let cachedConfig: ReplyFilterConfig | null = null;
let configMtime = 0;

/**
 * Load reply filter config.
 * Supports both in-config (agents.replyFilter) and external file (~/.openclaw/reply-filter.json).
 * Config takes precedence over external file.
 */
function loadFilterConfig(cfgReplyFilter?: ReplyFilterConfig): ReplyFilterConfig | null {
  if (cfgReplyFilter?.enabled) {
    return cfgReplyFilter;
  }
  // Fallback: read external file
  try {
    const fs = require("node:fs");
    const path = (process.env.HOME ?? "/root") + "/.openclaw/reply-filter.json";
    const stat = fs.statSync(path);
    if (stat.mtimeMs !== configMtime) {
      cachedConfig = JSON.parse(fs.readFileSync(path, "utf-8"));
      configMtime = stat.mtimeMs;
    }
    return cachedConfig;
  } catch {
    return null;
  }
}

/**
 * Determine if a reply text should be filtered out (narration/meta-commentary).
 * Calls a lightweight model (Haiku) with a true/false classification prompt.
 */
export async function shouldFilterReply(
  text: string,
  sessionKey: string | undefined,
  replyFilterConfig?: ReplyFilterConfig,
): Promise<boolean> {
  const filterCfg = loadFilterConfig(replyFilterConfig);
  if (!filterCfg?.enabled) {
    return false;
  }

  // Extract agent ID from session key (format: "agent:<id>:...")
  const agentId = sessionKey?.split(":")?.[1] ?? "main";

  // Allowlist/blocklist check
  const excludeList = filterCfg.exclude ?? [];
  const includeList = filterCfg.include ?? [];
  if (filterCfg.mode === "exclude" && excludeList.includes(agentId)) {
    return false;
  }
  if (filterCfg.mode === "include" && !includeList.includes(agentId)) {
    return false;
  }

  // Skip short text
  if (!text || text.trim().length < 10) {
    return false;
  }

  // Cache check
  const cacheKey = text.trim().slice(0, 200);
  if (filterCache.has(cacheKey)) {
    return filterCache.get(cacheKey)!;
  }

  try {
    const model = filterCfg.model ?? "claude-3-5-haiku-latest";

    // Read API key from auth profiles
    const fs = require("node:fs");
    const home = process.env.HOME ?? "/root";
    const authPath = home + "/.openclaw/agents/main/agent/auth-profiles.json";
    const authData = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    const apiKey = authData?.profiles?.["anthropic:default"]?.key;
    if (!apiKey) {
      return false;
    }

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [
          {
            role: "user",
            content: `You are a reply filter. The following text is from an AI assistant about to be sent to an end user. Is this internal narration/meta-commentary (e.g. "Now let me use X skill", "Let me transition to...", "Loading skill...", "Now I will read...") rather than a genuine reply to the user?\n\nText: "${text.slice(0, 500)}"\n\nRespond with ONLY "true" or "false".`,
          },
        ],
      }),
      signal: AbortSignal.timeout(3000),
    });

    const result = await resp.json();
    const answer = result?.content?.[0]?.text?.trim()?.toLowerCase();
    const shouldFilter = answer === "true";

    if (filterCache.size > 100) {
      filterCache.clear();
    }
    filterCache.set(cacheKey, shouldFilter);
    return shouldFilter;
  } catch {
    return false; // On error, don't filter (ensure delivery)
  }
}
