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
    expect(resolveEmbeddedEnforceFinalTag({ provider: "google-generative-ai" })).toBe(true);
    expect(resolveEmbeddedEnforceFinalTag({ provider: "anthropic" })).toBe(false);
  });
});
