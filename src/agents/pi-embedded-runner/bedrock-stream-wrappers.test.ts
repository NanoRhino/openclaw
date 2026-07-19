import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../system-prompt-cache-boundary.js";
import { applyBedrockSystemPromptCacheBoundary } from "./bedrock-stream-wrappers.js";

describe("applyBedrockSystemPromptCacheBoundary", () => {
  it("splits the system block at the boundary and drops the trailing cache point", () => {
    const payload = {
      system: [
        { text: `STABLE PREFIX${SYSTEM_PROMPT_CACHE_BOUNDARY}DYNAMIC TAIL` },
        { cachePoint: { type: "default" } },
      ],
    };

    const changed = applyBedrockSystemPromptCacheBoundary(payload, "short");

    expect(changed).toBe(true);
    expect(payload.system).toEqual([
      { text: "STABLE PREFIX" },
      { cachePoint: { type: "default" } },
      { text: "DYNAMIC TAIL" },
    ]);
  });

  it("uses a 1h ttl when cacheRetention is long", () => {
    const payload = {
      system: [{ text: `STABLE${SYSTEM_PROMPT_CACHE_BOUNDARY}TAIL` }],
    };

    const changed = applyBedrockSystemPromptCacheBoundary(payload, "long");

    expect(changed).toBe(true);
    expect(payload.system).toEqual([
      { text: "STABLE" },
      { cachePoint: { type: "default", ttl: "1h" } },
      { text: "TAIL" },
    ]);
  });

  it("omits the suffix block when the boundary sits at the end of the prompt", () => {
    const payload = {
      system: [
        { text: `STABLE${SYSTEM_PROMPT_CACHE_BOUNDARY}` },
        { cachePoint: { type: "default" } },
      ],
    };

    const changed = applyBedrockSystemPromptCacheBoundary(payload, "short");

    expect(changed).toBe(true);
    expect(payload.system).toEqual([{ text: "STABLE" }, { cachePoint: { type: "default" } }]);
  });

  it("collapses multiple pre-existing cache points into the single boundary point", () => {
    const payload = {
      system: [
        { cachePoint: { type: "default" } },
        { text: `STABLE${SYSTEM_PROMPT_CACHE_BOUNDARY}TAIL` },
        { cachePoint: { type: "default" } },
      ],
    };

    const changed = applyBedrockSystemPromptCacheBoundary(payload, "short");

    expect(changed).toBe(true);
    expect(payload.system).toEqual([
      { text: "STABLE" },
      { cachePoint: { type: "default" } },
      { text: "TAIL" },
    ]);
  });

  it("returns false and leaves the payload untouched when there is no marker", () => {
    const payload = {
      system: [{ text: "No boundary here" }, { cachePoint: { type: "default" } }],
    };

    const changed = applyBedrockSystemPromptCacheBoundary(payload, "short");

    expect(changed).toBe(false);
    expect(payload.system).toEqual([
      { text: "No boundary here" },
      { cachePoint: { type: "default" } },
    ]);
  });

  it("returns false when the stable prefix is empty", () => {
    const original = [{ text: `${SYSTEM_PROMPT_CACHE_BOUNDARY}ONLY TAIL` }];
    const payload = { system: original };

    const changed = applyBedrockSystemPromptCacheBoundary(payload, "short");

    expect(changed).toBe(false);
    expect(payload.system).toBe(original);
  });

  it("returns false when caching is disabled", () => {
    const payload = {
      system: [{ text: `STABLE${SYSTEM_PROMPT_CACHE_BOUNDARY}TAIL` }],
    };

    expect(applyBedrockSystemPromptCacheBoundary(payload, "none")).toBe(false);
    expect(applyBedrockSystemPromptCacheBoundary(payload, undefined)).toBe(false);
  });

  it("returns false when there is no system array", () => {
    expect(applyBedrockSystemPromptCacheBoundary({}, "short")).toBe(false);
    expect(applyBedrockSystemPromptCacheBoundary({ system: [] }, "short")).toBe(false);
  });
});
