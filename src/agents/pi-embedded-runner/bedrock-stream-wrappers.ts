import crypto from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import {
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  splitSystemPromptCacheBoundary,
  stripSystemPromptCacheBoundary,
} from "../system-prompt-cache-boundary.js";
import { isAnthropicBedrockModel } from "./anthropic-family-cache-semantics.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

export function createBedrockNoCacheWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    underlying(model, context, {
      ...options,
      cacheRetention: "none",
    });
}

// --- History image projection -------------------------------------------------
//
// A meal photo is stored in the transcript as an image content block; pi-ai keeps
// it native for vision-capable Claude, so every subsequent turn re-serializes the
// full base64 into the Converse request body (multi-MB alloc + wire bytes per
// photo per turn -- the dinner-peak memory driver). The image's coaching value is
// already extracted into the meal log by the time it becomes history, so we
// replace *history* image blocks with a byte-stable text placeholder before the
// AWS SDK serializes the command. The current turn's image is left untouched so
// the model can still analyze it. This is a payload-only projection: the on-disk
// transcript and the resident AgentMessage array are never rewritten.

type BedrockPayloadBlock = Record<string, unknown>;
type BedrockPayloadMessage = { role?: unknown; content?: unknown };

/**
 * A "real" inbound user message carries a top-level text or image block. Bedrock
 * Converse folds tool results into user-role messages whose blocks are
 * `{ toolResult }` / `{ cachePoint }` only, so those are not inbounds. The last
 * such inbound (and everything after it -- the in-progress tool rounds) is the
 * current turn; everything before it is history.
 */
function isConverseInboundUserMessage(message: BedrockPayloadMessage): boolean {
  if (message.role !== "user" || !Array.isArray(message.content)) {
    return false;
  }
  return message.content.some(
    (block) =>
      Boolean(block) &&
      typeof block === "object" &&
      ("text" in (block as object) || "image" in (block as object)),
  );
}

/**
 * Stable 8-hex digest of a Converse image's bytes so the same photo always
 * projects to the exact same placeholder string (it sits inside the cached
 * prefix and must never become a per-turn cache-break source).
 */
function hashConverseImage(image: Record<string, unknown>): string {
  const source = image.source as { bytes?: unknown } | undefined;
  const bytes = source?.bytes;
  const hash = crypto.createHash("sha256");
  if (bytes instanceof Uint8Array) {
    hash.update(bytes);
  } else if (typeof bytes === "string") {
    hash.update(bytes);
  } else {
    // Unexpected source shape (e.g. an s3Location instead of inline bytes): hash a
    // JSON projection so the placeholder is still deterministic per image.
    try {
      hash.update(JSON.stringify(source ?? image));
    } catch {
      hash.update("unknown");
    }
  }
  return hash.digest("hex").slice(0, 8);
}

function historyImagePlaceholderBlock(imageBlock: Record<string, unknown>): { text: string } {
  const image = imageBlock.image as Record<string, unknown>;
  return { text: `[photo ${hashConverseImage(image)}: analyzed meal image]` };
}

/**
 * Replace image blocks in a content array in place with placeholders. Images can
 * appear directly in a message's content and nested inside a `toolResult`'s
 * content; both are handled. Blocks are replaced 1:1 (never removed), so no
 * content array is left empty -- an empty content array is a Converse
 * ValidationException.
 */
function replaceHistoryImagesInContent(content: unknown[]): void {
  for (let i = 0; i < content.length; i += 1) {
    const block = content[i];
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as BedrockPayloadBlock;
    if (record.image && typeof record.image === "object") {
      content[i] = historyImagePlaceholderBlock(record);
      continue;
    }
    const toolResult = record.toolResult as { content?: unknown } | undefined;
    if (toolResult && Array.isArray(toolResult.content)) {
      replaceHistoryImagesInContent(toolResult.content);
    }
  }
}

/**
 * Project history (non-current-turn) image blocks in a Bedrock Converse payload to
 * byte-stable text placeholders, in place. Runs before the cache-boundary patches
 * so cache points are placed over the already-shrunk history. No-op when there is
 * no history before the current inbound.
 */
export function replaceBedrockHistoryImages(payload: Record<string, unknown>): void {
  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return;
  }
  let inboundIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isConverseInboundUserMessage(messages[i] as BedrockPayloadMessage)) {
      inboundIdx = i;
      break;
    }
  }
  // inboundIdx <= 0 means the current inbound is the first message (or none was
  // found): there is no history to project.
  if (inboundIdx <= 0) {
    return;
  }
  for (let i = 0; i < inboundIdx; i += 1) {
    const message = messages[i] as BedrockPayloadMessage;
    if (Array.isArray(message.content)) {
      replaceHistoryImagesInContent(message.content);
    }
  }
}

/**
 * Wrap a Bedrock StreamFn so every request has its history images projected to
 * placeholders via pi-ai's onPayload hook (the command input, before the SDK
 * serializes it to the wire).
 */
export function createBedrockHistoryImageProjectionWrapper(
  baseStreamFn: StreamFn | undefined,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) =>
    streamWithPayloadPatch(underlying, model, context, options, (payload) =>
      replaceBedrockHistoryImages(payload),
    );
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
