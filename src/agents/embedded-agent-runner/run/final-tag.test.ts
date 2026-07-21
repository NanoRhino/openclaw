import { describe, expect, it } from "vitest";
import { resolveEmbeddedEnforceFinalTag } from "./final-tag.js";

describe("resolveEmbeddedEnforceFinalTag", () => {
  it("honors an explicit caller override", () => {
    expect(resolveEmbeddedEnforceFinalTag({ explicit: true, provider: "anthropic" })).toBe(true);
    expect(
      resolveEmbeddedEnforceFinalTag({ explicit: false, provider: "google-generative-ai" }),
    ).toBe(false);
  });

  it("resolves per-agent config before defaults", () => {
    const config = {
      agents: {
        defaults: { enforceFinalTag: true },
        list: [{ id: "cron-agent", enforceFinalTag: false }],
      },
    };
    expect(resolveEmbeddedEnforceFinalTag({ config, agentId: "cron-agent" })).toBe(false);
    expect(resolveEmbeddedEnforceFinalTag({ config, agentId: "chat-agent" })).toBe(true);
  });

  it("falls back to provider detection when config is unset", () => {
    // 7.1 line: provider detection is plugin-hook-driven only (no built-in
    // provider map, unlike the 4.24 line this test was ported from), so a bare
    // resolution without a plugin hook lands on false for every provider.
    expect(resolveEmbeddedEnforceFinalTag({ provider: "google-generative-ai" })).toBe(false);
    expect(resolveEmbeddedEnforceFinalTag({ provider: "anthropic" })).toBe(false);
  });
});
