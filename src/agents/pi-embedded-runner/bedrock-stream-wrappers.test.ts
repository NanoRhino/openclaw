import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../system-prompt-cache-boundary.js";
import {
  applyBedrockLastUserCacheBoundary,
  applyBedrockSystemPromptCacheBoundary,
} from "./bedrock-stream-wrappers.js";

describe("applyBedrockLastUserCacheBoundary", () => {
  const point = (ttl?: string) => ({
    cachePoint: ttl ? { type: "default", ttl } : { type: "default" },
  });

  it("moves the cache point before the current inbound and drops the last-user point", () => {
    const payload = {
      messages: [
        { role: "assistant", content: [{ text: "prior reply" }] },
        {
          role: "user",
          content: [{ text: "Conversation info (untrusted metadata):\n...\n\nhi" }, point()],
        },
      ],
    };

    const changed = applyBedrockLastUserCacheBoundary(payload, "long");

    expect(changed).toBe(true);
    expect(payload.messages[1].content).toEqual([
      { text: "Conversation info (untrusted metadata):\n...\n\nhi" },
    ]);
    expect(payload.messages[0].content).toEqual([{ text: "prior reply" }, point("1h")]);
  });

  it("repositions before the inbound even when tool results follow it", () => {
    const payload = {
      messages: [
        { role: "assistant", content: [{ text: "prior reply" }] },
        { role: "user", content: [{ text: "log my lunch" }] },
        { role: "assistant", content: [{ toolUse: { toolUseId: "t1", name: "meal", input: {} } }] },
        { role: "user", content: [{ toolResult: { toolUseId: "t1", content: [] } }, point()] },
      ],
    };

    const changed = applyBedrockLastUserCacheBoundary(payload, "short");

    expect(changed).toBe(true);
    expect(payload.messages[3].content).toEqual([{ toolResult: { toolUseId: "t1", content: [] } }]);
    expect(payload.messages[0].content).toEqual([{ text: "prior reply" }, point()]);
    expect(payload.messages[1].content).toEqual([{ text: "log my lunch" }]);
  });

  it("returns false and leaves the payload untouched when the inbound is first", () => {
    const payload = {
      messages: [{ role: "user", content: [{ text: "first message" }, point()] }],
    };

    const changed = applyBedrockLastUserCacheBoundary(payload, "long");

    expect(changed).toBe(false);
    expect(payload.messages[0].content).toEqual([{ text: "first message" }, point()]);
  });

  it("does nothing when cacheRetention is none", () => {
    const payload = {
      messages: [
        { role: "assistant", content: [{ text: "a" }] },
        { role: "user", content: [{ text: "b" }, point()] },
      ],
    };
    expect(applyBedrockLastUserCacheBoundary(payload, "none")).toBe(false);
    expect(payload.messages[1].content).toEqual([{ text: "b" }, point()]);
  });
});

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
