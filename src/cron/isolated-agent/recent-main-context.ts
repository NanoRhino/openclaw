import path from "node:path";
import { stripInboundMetadata } from "../../auto-reply/reply/strip-inbound-meta.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions/paths.js";
import { loadSessionStore } from "../../config/sessions/store-load.js";
import { streamSessionTranscriptLinesReverse } from "../../config/sessions/transcript-stream.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { CHARS_PER_TOKEN_ESTIMATE, estimateStringChars } from "../../utils/cjk-chars.js";

const DEFAULT_TURNS = 10;
const DEFAULT_MAX_TOKENS = 6000;

type VisibleMessage = { role: "user" | "assistant"; text: string };

function sanitizeVisibleUserText(text: string): string {
  const stripped = stripInboundMetadata(text).trim();
  const wrapped = stripped.match(/^User text:\s*\n?([\s\S]*?)(?:\nTranscript:\s*\n?[\s\S]*)?$/i);
  return (wrapped?.[1] ?? stripped).trim();
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function findFreshestLocalDirectSession(
  store: Record<string, SessionEntry>,
): SessionEntry | undefined {
  return Object.entries(store)
    .filter(([key, entry]) => !key.includes(":cron:") && entry.chatType === "direct")
    .sort(([, left], [, right]) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0]?.[1];
}

function parseVisibleMessage(line: string): VisibleMessage | undefined {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!record || typeof record !== "object" || !("message" in record)) {
    return undefined;
  }
  const message = (record as { message?: unknown }).message;
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const candidate = message as {
    role?: unknown;
    content?: unknown;
    provider?: unknown;
    model?: unknown;
  };
  if (candidate.role !== "user" && candidate.role !== "assistant") {
    return undefined;
  }
  if (candidate.provider === "openclaw" && candidate.model === "delivery-mirror") {
    return undefined;
  }
  const raw = Array.isArray(candidate.content)
    ? candidate.content
        .filter(
          (part): part is { type: "text"; text: string } =>
            Boolean(part) &&
            typeof part === "object" &&
            (part as { type?: unknown }).type === "text" &&
            typeof (part as { text?: unknown }).text === "string",
        )
        .map((part) => part.text)
        .join("\n")
    : typeof candidate.content === "string"
      ? candidate.content
      : "";
  const text = candidate.role === "user" ? sanitizeVisibleUserText(raw) : raw.trim();
  return text ? { role: candidate.role, text } : undefined;
}

function estimateTokens(text: string): number {
  return Math.ceil(estimateStringChars(text) / CHARS_PER_TOKEN_ESTIMATE);
}

export async function buildRecentMainContext(params: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const env = params.env ?? process.env;
  const turns = positiveInt(env.CRON_RECENT_TURNS, DEFAULT_TURNS);
  const maxTokens = positiveInt(env.CRON_RECENT_MAX_TOKENS, DEFAULT_MAX_TOKENS);
  const storePath = path.join(
    resolveSessionTranscriptsDirForAgent(params.agentId, env),
    "sessions.json",
  );
  const store = loadSessionStore(storePath, {
    skipCache: true,
  });
  const entry = findFreshestLocalDirectSession(store);
  const transcript = entry?.sessionFile?.trim();
  if (!transcript) {
    return undefined;
  }

  const newestFirst: VisibleMessage[] = [];
  let assistantTurns = 0;
  let tokens = 0;
  for await (const line of streamSessionTranscriptLinesReverse(transcript)) {
    const message = parseVisibleMessage(line);
    if (!message) {
      continue;
    }
    const previous = newestFirst.at(-1);
    if (previous?.role === message.role && previous.text === message.text) {
      continue;
    }
    const nextTokens = estimateTokens(`${message.role}: ${message.text}`);
    if (tokens + nextTokens > maxTokens) {
      break;
    }
    newestFirst.push(message);
    tokens += nextTokens;
    if (message.role === "assistant") {
      assistantTurns += 1;
      if (assistantTurns >= turns) {
        break;
      }
    }
  }
  if (newestFirst.length === 0) {
    return undefined;
  }
  const lines = newestFirst.reverse().map((message) => {
    const label = message.role === "user" ? "User" : "Assistant";
    return `${label}: ${message.text}`;
  });
  return `<recent_main_context>\n${lines.join("\n")}\n</recent_main_context>`;
}
