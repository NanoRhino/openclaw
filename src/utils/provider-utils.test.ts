// Provider utility tests cover provider normalization and utility behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveProviderReasoningOutputModeWithPluginMock } = vi.hoisted(() => ({
  resolveProviderReasoningOutputModeWithPluginMock: vi.fn(),
}));

vi.mock("../plugins/provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/provider-runtime.js")>(
    "../plugins/provider-runtime.js",
  );
  return {
    ...actual,
    resolveProviderReasoningOutputModeWithPlugin: resolveProviderReasoningOutputModeWithPluginMock,
  };
});

import { isReasoningTagProvider, resolveReasoningTagHint } from "./provider-utils.js";

describe("isReasoningTagProvider", () => {
  beforeEach(() => {
    resolveProviderReasoningOutputModeWithPluginMock.mockReset();
    resolveProviderReasoningOutputModeWithPluginMock.mockReturnValue(undefined);
  });

  it("falls back to provider hooks for unknown providers", () => {
    resolveProviderReasoningOutputModeWithPluginMock.mockReturnValue("tagged");

    expect(
      isReasoningTagProvider("custom-provider", {
        workspaceDir: process.cwd(),
        modelId: "custom/model",
      }),
    ).toBe(true);
    expect(resolveProviderReasoningOutputModeWithPluginMock).toHaveBeenCalledTimes(1);
  });

  it("returns native when hooks do not provide an override", () => {
    expect(isReasoningTagProvider("custom-provider")).toBe(false);
    expect(resolveProviderReasoningOutputModeWithPluginMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["google-generative-ai", false],
    [null, false],
    [undefined, false],
    ["", false],
  ] as const)("returns %s for %s", (value, expected) => {
    expect(isReasoningTagProvider(value, { workspaceDir: process.cwd() })).toBe(expected);
  });

  it.each([
    ["google", true],
    ["Google", true],
    ["google-gemini-cli", true],
    ["anthropic", false],
    ["openai", false],
    ["openrouter", false],
    ["ollama", false],
    ["minimax", false],
    ["minimax-cn", false],
  ] as const)("uses provider hooks when available for %s", (value, expected) => {
    resolveProviderReasoningOutputModeWithPluginMock.mockReturnValueOnce(
      expected ? "tagged" : "native",
    );

    expect(isReasoningTagProvider(value, { workspaceDir: process.cwd() })).toBe(expected);
    expect(resolveProviderReasoningOutputModeWithPluginMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveReasoningTagHint", () => {
  beforeEach(() => {
    resolveProviderReasoningOutputModeWithPluginMock.mockReset();
    resolveProviderReasoningOutputModeWithPluginMock.mockReturnValue(undefined);
  });

  it("follows the gate when enforceFinalTag is true, ignoring provider detection", () => {
    // Non-tagged provider would resolve false, but the gate wins.
    expect(resolveReasoningTagHint(true, "openai", { workspaceDir: process.cwd() })).toBe(true);
    expect(resolveProviderReasoningOutputModeWithPluginMock).not.toHaveBeenCalled();
  });

  it("follows the gate when enforceFinalTag is false, ignoring provider detection", () => {
    // Tagged provider would resolve true, but an explicit false gate wins.
    expect(
      resolveReasoningTagHint(false, "google-generative-ai", { workspaceDir: process.cwd() }),
    ).toBe(false);
    expect(resolveProviderReasoningOutputModeWithPluginMock).not.toHaveBeenCalled();
  });

  it("falls back to provider detection when the gate is undefined", () => {
    // 7.1 line: provider detection is plugin-hook-driven only (no built-in
    // provider map, unlike the 4.24 line this test was ported from).
    resolveProviderReasoningOutputModeWithPluginMock.mockReturnValueOnce("tagged");
    expect(
      resolveReasoningTagHint(undefined, "google-generative-ai", { workspaceDir: process.cwd() }),
    ).toBe(true);
    expect(resolveReasoningTagHint(undefined, "openai", { workspaceDir: process.cwd() })).toBe(
      false,
    );
  });
});
