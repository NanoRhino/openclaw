import path from "node:path";
import { stripInboundMetadata } from "../../auto-reply/reply/strip-inbound-meta.js";
import { resolveSessionTranscriptsDirForAgent } from "../../config/sessions/paths.js";
import { loadSessionStore } from "../../config/sessions/store-load.js";
import { streamSessionTranscriptLinesReverse } from "../../config/sessions/transcript-stream.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { CHARS_PER_TOKEN_ESTIMATE, estimateStringChars } from "../../utils/cjk-chars.js";

const DEFAULT_TURNS = 10;
const DEFAULT_MAX_TOKENS = 6000;

type VisibleMessage = { role: "user" | "assistant"; text: string; timestamp?: string };

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

const WEEKDAY_ZH: Record<string, string> = {
  Mon: "周一",
  Tue: "周二",
  Wed: "周三",
  Thu: "周四",
  Fri: "周五",
  Sat: "周六",
  Sun: "周日",
};

/** `2026-08-21 07:41 周五 Asia/Shanghai` — same clock as the cron prompt's Current time (UTC ISO made
 *  everything before 08:00 Beijing look like "yesterday"). Falls back to ISO on any failure. */
function formatLocalTimestamp(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      weekday: "short",
    }).formatToParts(date);
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} ${WEEKDAY_ZH[get("weekday")] ?? get("weekday")} ${timeZone}`;
  } catch {
    return date.toISOString();
  }
}

function parseVisibleMessage(line: string, timeZone?: string): VisibleMessage | undefined {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!record || typeof record !== "object" || !("message" in record)) {
    return undefined;
  }
  const envelope = record as { message?: unknown; timestamp?: unknown };
  const message = envelope.message;
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const candidate = message as {
    role?: unknown;
    content?: unknown;
    provider?: unknown;
    model?: unknown;
    timestamp?: unknown;
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
  const rawTimestamp = envelope.timestamp ?? candidate.timestamp;
  const parsedTimestamp =
    typeof rawTimestamp === "number"
      ? new Date(rawTimestamp)
      : typeof rawTimestamp === "string"
        ? new Date(rawTimestamp)
        : undefined;
  const timestamp =
    parsedTimestamp && !Number.isNaN(parsedTimestamp.getTime())
      ? timeZone
        ? formatLocalTimestamp(parsedTimestamp, timeZone)
        : parsedTimestamp.toISOString()
      : undefined;
  return text ? { role: candidate.role, text, timestamp } : undefined;
}

function estimateTokens(text: string): number {
  return Math.ceil(estimateStringChars(text) / CHARS_PER_TOKEN_ESTIMATE);
}

export async function buildRecentMainContext(params: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
  /** Render timestamps in this timezone (per-workspace); default keeps UTC ISO. */
  timeZone?: string;
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
    const message = parseVisibleMessage(line, params.timeZone);
    if (!message) {
      continue;
    }
    const previous = newestFirst.at(-1);
    if (previous?.role === message.role && previous.text === message.text) {
      continue;
    }
    const timestampPrefix = message.timestamp ? `[${message.timestamp}] ` : "";
    const nextTokens = estimateTokens(`${timestampPrefix}${message.role}: ${message.text}`);
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
    const timestampPrefix = message.timestamp ? `[${message.timestamp}] ` : "";
    return `${timestampPrefix}${label}: ${message.text}`;
  });
  return `<recent_main_context>\n${lines.join("\n")}\n</recent_main_context>`;
}
