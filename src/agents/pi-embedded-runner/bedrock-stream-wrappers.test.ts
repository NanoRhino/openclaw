import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../system-prompt-cache-boundary.js";
import {
  applyBedrockLastUserCacheBoundary,
  applyBedrockSystemPromptCacheBoundary,
  replaceBedrockHistoryImages,
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

describe("replaceBedrockHistoryImages", () => {
  const bytes = (...vals: number[]) => Uint8Array.from(vals);
  const imageBlock = (source: Uint8Array | string, format = "jpeg") => ({
    image: { format, source: { bytes: source } },
  });
  const PLACEHOLDER_RE = /^\[photo [0-9a-f]{8}: analyzed meal image\]$/;

  it("replaces a history image with a compact placeholder and leaves the current turn image native", () => {
    const currentBytes = bytes(9, 9, 9);
    const payload = {
      messages: [
        { role: "user", content: [{ text: "here is lunch" }, imageBlock(bytes(1, 2, 3))] },
        { role: "assistant", content: [{ text: "Logged: 620 kcal." }] },
        { role: "user", content: [{ text: "and here is dinner" }, imageBlock(currentBytes)] },
      ],
    };

    replaceBedrockHistoryImages(payload);

    // History (turn 1) image -> placeholder text block.
    const historyBlocks = payload.messages[0].content;
    expect(historyBlocks).toHaveLength(2);
    expect(historyBlocks[0]).toEqual({ text: "here is lunch" });
    expect((historyBlocks[1] as { text: string }).text).toMatch(PLACEHOLDER_RE);
    expect(historyBlocks[1]).not.toHaveProperty("image");

    // Current turn (last inbound) image is untouched (still native bytes).
    expect(payload.messages[2].content[1]).toEqual(imageBlock(currentBytes));
  });

  it("produces a byte-identical placeholder for the same image across independent replays", () => {
    const build = () => ({
      messages: [
        { role: "user", content: [imageBlock(bytes(4, 5, 6, 7))] },
        { role: "assistant", content: [{ text: "ok" }] },
        { role: "user", content: [{ text: "next" }] },
      ],
    });

    const a = build();
    const b = build();
    replaceBedrockHistoryImages(a);
    replaceBedrockHistoryImages(b);

    const textA = (a.messages[0].content[0] as { text: string }).text;
    const textB = (b.messages[0].content[0] as { text: string }).text;
    expect(textA).toMatch(PLACEHOLDER_RE);
    expect(textA).toBe(textB); // byte-stable: safe inside the cached prefix
  });

  it("gives distinct images distinct placeholders and equal images equal placeholders", () => {
    const payload = {
      messages: [
        { role: "user", content: [imageBlock(bytes(1, 1, 1))] },
        { role: "user", content: [imageBlock(bytes(2, 2, 2))] },
        { role: "user", content: [imageBlock(bytes(1, 1, 1))] },
        { role: "assistant", content: [{ text: "ok" }] },
        { role: "user", content: [{ text: "current" }] },
      ],
    };

    replaceBedrockHistoryImages(payload);

    const p0 = (payload.messages[0].content[0] as { text: string }).text;
    const p1 = (payload.messages[1].content[0] as { text: string }).text;
    const p2 = (payload.messages[2].content[0] as { text: string }).text;
    expect(p0).not.toBe(p1); // different bytes -> different hash
    expect(p0).toBe(p2); // identical bytes -> identical hash
  });

  it("replaces images nested inside a history toolResult and keeps the array non-empty", () => {
    const payload = {
      messages: [
        { role: "user", content: [{ text: "log this" }] },
        { role: "assistant", content: [{ toolUse: { toolUseId: "t1", name: "meal", input: {} } }] },
        {
          role: "user",
          content: [
            {
              toolResult: {
                toolUseId: "t1",
                content: [{ text: "detected plate" }, imageBlock(bytes(8, 8))],
                status: "success",
              },
            },
          ],
        },
        { role: "assistant", content: [{ text: "done" }] },
        { role: "user", content: [{ text: "what were the macros?" }] },
      ],
    };

    replaceBedrockHistoryImages(payload);

    const toolResultContent = (
      payload.messages[2].content[0] as { toolResult: { content: unknown[] } }
    ).toolResult.content;
    expect(toolResultContent).toHaveLength(2);
    expect(toolResultContent[0]).toEqual({ text: "detected plate" });
    expect((toolResultContent[1] as { text: string }).text).toMatch(PLACEHOLDER_RE);
    expect(toolResultContent[1]).not.toHaveProperty("image");
  });

  it("keeps an image-only history message non-empty by replacing 1:1", () => {
    const payload = {
      messages: [
        { role: "user", content: [imageBlock(bytes(3, 3, 3))] },
        { role: "assistant", content: [{ text: "ok" }] },
        { role: "user", content: [{ text: "current turn" }] },
      ],
    };

    replaceBedrockHistoryImages(payload);

    expect(payload.messages[0].content).toHaveLength(1);
    expect((payload.messages[0].content[0] as { text: string }).text).toMatch(PLACEHOLDER_RE);
  });

  it("handles mixed text+image content, replacing only the image", () => {
    const payload = {
      messages: [
        {
          role: "user",
          content: [{ text: "before" }, imageBlock(bytes(5, 5)), { text: "after" }],
        },
        { role: "assistant", content: [{ text: "ok" }] },
        { role: "user", content: [{ text: "current" }] },
      ],
    };

    replaceBedrockHistoryImages(payload);

    const content = payload.messages[0].content;
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({ text: "before" });
    expect((content[1] as { text: string }).text).toMatch(PLACEHOLDER_RE);
    expect(content[2]).toEqual({ text: "after" });
  });

  it("preserves current-turn tool-round images that follow the inbound", () => {
    const currentToolImage = imageBlock(bytes(7, 7, 7));
    const payload = {
      messages: [
        { role: "user", content: [{ text: "old photo turn" }, imageBlock(bytes(1, 1))] },
        { role: "assistant", content: [{ text: "logged" }] },
        // current turn starts here:
        { role: "user", content: [{ text: "analyze this new one" }] },
        {
          role: "assistant",
          content: [{ toolUse: { toolUseId: "t9", name: "vision", input: {} } }],
        },
        {
          role: "user",
          content: [
            { toolResult: { toolUseId: "t9", content: [currentToolImage], status: "success" } },
          ],
        },
      ],
    };

    replaceBedrockHistoryImages(payload);

    // History image replaced.
    expect((payload.messages[0].content[1] as { text: string }).text).toMatch(PLACEHOLDER_RE);
    // Current-turn tool image (after the inbound) is untouched.
    const toolContent = (payload.messages[4].content[0] as { toolResult: { content: unknown[] } })
      .toolResult.content;
    expect(toolContent[0]).toEqual(currentToolImage);
  });

  it("is a no-op when the only image is in the current (first) inbound", () => {
    const only = imageBlock(bytes(2, 4, 6));
    const payload = {
      messages: [{ role: "user", content: [{ text: "just this photo" }, only] }],
    };

    replaceBedrockHistoryImages(payload);

    expect(payload.messages[0].content[1]).toEqual(only);
  });

  it("tolerates empty / missing messages without throwing", () => {
    expect(() => replaceBedrockHistoryImages({})).not.toThrow();
    expect(() => replaceBedrockHistoryImages({ messages: [] })).not.toThrow();
    expect(() => replaceBedrockHistoryImages({ messages: "nope" })).not.toThrow();
  });

  it("hashes string-form image bytes stably (defensive non-Uint8Array source)", () => {
    const payload = {
      messages: [
        { role: "user", content: [imageBlock("YWJjZA==" as unknown as Uint8Array)] },
        { role: "assistant", content: [{ text: "ok" }] },
        { role: "user", content: [{ text: "current" }] },
      ],
    };

    replaceBedrockHistoryImages(payload);
    expect((payload.messages[0].content[0] as { text: string }).text).toMatch(PLACEHOLDER_RE);
  });
});
