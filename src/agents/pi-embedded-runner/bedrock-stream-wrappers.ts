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

export { isAnthropicBedrockModel };
