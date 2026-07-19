import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import {
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  splitSystemPromptCacheBoundary,
  stripSystemPromptCacheBoundary,
} from "../system-prompt-cache-boundary.js";
import { isAnthropicBedrockModel } from "./anthropic-family-cache-semantics.js";

export function createBedrockNoCacheWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      cacheRetention: "none",
    });
}

type BedrockContentBlock = Record<string, unknown>;

function isBedrockCachePointBlock(block: unknown): boolean {
  return (
    Boolean(block) && typeof block === "object" && (block as BedrockContentBlock).cachePoint != null
  );
}

function makeBedrockCachePoint(cacheRetention: string): BedrockContentBlock {
  return {
    cachePoint: { type: "default", ...(cacheRetention === "long" ? { ttl: "1h" } : {}) },
  };
}

/**
 * Move the Bedrock Converse system cache point up to the OpenClaw cache boundary
 * so the byte-stable system prefix caches independently of the dynamic tail that
 * sits below the boundary. This mirrors `applyAnthropicCacheControlToSystem` for
 * the Bedrock content-block shape: pi-ai serializes the whole system prompt into
 * a single `{ text }` block with one trailing `{ cachePoint }`, so any change in
 * the dynamic suffix invalidates the entire (37K) block. Splitting at the
 * boundary produces `[{text: stablePrefix}, {cachePoint}, {text: dynamicSuffix}]`
 * and drops the trailing cache point, so the stable prefix is the single system
 * breakpoint and reads from cache every turn.
 *
 * Returns `true` when it repositioned the system cache point at the boundary.
 * Returns `false` (leaving `payload.system` untouched) when there is no boundary
 * marker, so callers can fall back to the default end-of-system placement.
 */
export function applyBedrockSystemPromptCacheBoundary(
  payload: Record<string, unknown>,
  cacheRetention: string | undefined,
): boolean {
  if (!cacheRetention || cacheRetention === "none") {
    return false;
  }
  const system = payload.system;
  if (!Array.isArray(system) || system.length === 0) {
    return false;
  }

  const markerIndex = system.findIndex(
    (block) =>
      Boolean(block) &&
      typeof block === "object" &&
      typeof (block as BedrockContentBlock).text === "string" &&
      ((block as BedrockContentBlock).text as string).includes(SYSTEM_PROMPT_CACHE_BOUNDARY),
  );
  if (markerIndex === -1) {
    return false;
  }

  const split = splitSystemPromptCacheBoundary(
    (system[markerIndex] as BedrockContentBlock).text as string,
  );
  // Without a non-empty stable prefix there is nothing to cache before the
  // boundary; leave the default placement (and let the marker be stripped below).
  if (!split || !split.stablePrefix) {
    return false;
  }

  const cachePoint = makeBedrockCachePoint(cacheRetention);
  const rebuilt: unknown[] = [];
  for (let i = 0; i < system.length; i += 1) {
    const block = system[i];
    if (i === markerIndex) {
      rebuilt.push({ text: split.stablePrefix });
      rebuilt.push(cachePoint);
      if (split.dynamicSuffix) {
        rebuilt.push({ text: stripSystemPromptCacheBoundary(split.dynamicSuffix) });
      }
      continue;
    }
    // Drop any other cache points (e.g. pi-ai's default end-of-system point); the
    // boundary point above is now the single system cache breakpoint.
    if (isBedrockCachePointBlock(block)) {
      continue;
    }
    // Defensively strip stray boundary markers from any other text block.
    if (
      block &&
      typeof block === "object" &&
      typeof (block as BedrockContentBlock).text === "string"
    ) {
      const record = block as BedrockContentBlock;
      rebuilt.push({ ...record, text: stripSystemPromptCacheBoundary(record.text as string) });
      continue;
    }
    rebuilt.push(block);
  }

  system.splice(0, system.length, ...rebuilt);
  return true;
}

function messageHasTextBlock(content: unknown): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        Boolean(block) &&
        typeof block === "object" &&
        typeof (block as BedrockContentBlock).text === "string",
    )
  );
}

/**
 * Move the Converse last-user cache point to sit BEFORE the current inbound user
 * message instead of after it. The current inbound carries a per-turn
 * "untrusted metadata" prefix (Conversation info, etc.) that is present when the
 * message is current but stripped once it becomes history — a byte difference
 * that breaks the messages-prefix cache at that message every turn. Ending the
 * cached span at the prior assistant reply keeps the metadata-bearing inbound
 * OUTSIDE the cached prefix (model-visible prompt is byte-for-byte unchanged),
 * so the cached prefix is a pure function of stored content; the inbound is
 * written fresh this turn and caches cleanly next turn as history (without the
 * ephemeral prefix). Repositions pi-ai's end-of-last-user point rather than
 * adding a third one.
 *
 * The current inbound is the last user-role message carrying a text block; tool
 * results are user-role but carry only toolResult blocks. Returns false (leaving
 * the payload untouched) when the inbound is the first message — there is
 * nothing to cache before it.
 */
export function applyBedrockLastUserCacheBoundary(
  payload: Record<string, unknown>,
  cacheRetention: string | undefined,
): boolean {
  if (!cacheRetention || cacheRetention === "none") {
    return false;
  }
  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length < 2) {
    return false;
  }

  let inboundIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as BedrockContentBlock;
    if (m?.role === "user" && messageHasTextBlock(m.content)) {
      inboundIdx = i;
      break;
    }
  }
  if (inboundIdx <= 0) {
    return false;
  }

  // Drop pi-ai's cache point(s) from the inbound onward (this turn's tail).
  for (let i = inboundIdx; i < messages.length; i += 1) {
    const m = messages[i] as BedrockContentBlock;
    if (!Array.isArray(m.content)) {
      continue;
    }
    const next = (m.content as unknown[]).filter((block) => !isBedrockCachePointBlock(block));
    if (next.length !== (m.content as unknown[]).length) {
      (m as { content: unknown[] }).content = next;
    }
  }

  // Place the reposition point at the tail of the message before the inbound
  // (the prior assistant reply). Idempotent.
  const boundary = messages[inboundIdx - 1] as BedrockContentBlock;
  if (!Array.isArray(boundary.content)) {
    return false;
  }
  const boundaryContent = boundary.content as unknown[];
  if (!boundaryContent.some((block) => isBedrockCachePointBlock(block))) {
    boundaryContent.push(makeBedrockCachePoint(cacheRetention));
  }
  return true;
}

export { isAnthropicBedrockModel };
