import { bedrockProviderModule } from "@mariozechner/pi-ai/bedrock-provider";
// Runtime EFFECT proof for the Bedrock dual-cachePoint reposition.
//
// This does NOT hand-call the reposition. It drives pi-ai's REAL streamBedrock
// through the amazon-bedrock plugin's REAL wrapStreamFn, and captures the actual
// Converse command pi-ai assembled — via a downstream onPayload that the plugin's
// streamWithPayloadPatch chains AFTER the reposition. That capturing onPayload
// only runs if pi-ai actually invokes options.onPayload (the exact behavior
// doubted on .8: "pi-ai bedrock streamFn doesn't call onPayload"). It then throws
// to abort before pi-ai's real network send — no AWS SDK mock, no network.
import { beforeEach, describe, expect, it } from "vitest";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../../src/agents/system-prompt-cache-boundary.js";
import type { OpenClawConfig } from "../../src/config/config.js";
import { buildPluginApi } from "../../src/plugins/api-builder.js";
import type { PluginRuntime } from "../../src/plugins/runtime/types.js";
import amazonBedrockPlugin from "./index.js";

// pi-ai's REAL bedrock stream fn (the one OpenClaw's streamSimple dispatches to).
const streamBedrock = bedrockProviderModule.streamBedrock;

const ANTHROPIC_MODEL = "us.anthropic.claude-sonnet-4-6-v1";
const CAPTURE_ABORT = "__captured_before_send__";

async function getWrapStreamFn() {
  const providers: Array<{ wrapStreamFn?: unknown }> = [];
  const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };
  const api = buildPluginApi({
    id: "amazon-bedrock",
    name: "Amazon Bedrock Provider",
    source: "test",
    registrationMode: "full",
    config: {} as OpenClawConfig,
    runtime: {} as PluginRuntime,
    logger: noopLogger,
    resolvePath: (input: string) => input,
    handlers: {
      registerProvider(provider: { wrapStreamFn?: unknown }) {
        providers.push(provider);
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  await amazonBedrockPlugin.register(api);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return providers[0].wrapStreamFn as any;
}

/** Drive one real streamBedrock turn; return the Converse command pi-ai assembled. */
async function captureConverseCommand(cacheRetention: string): Promise<Record<string, unknown>> {
  const wrapStreamFn = await getWrapStreamFn();
  // The real plugin decides (regular Claude id) to install the reposition onPayload,
  // wrapping pi-ai's real streamBedrock.
  const wrapped = wrapStreamFn({
    provider: "amazon-bedrock",
    modelId: ANTHROPIC_MODEL,
    streamFn: streamBedrock,
  });
  const model = {
    id: ANTHROPIC_MODEL,
    provider: "amazon-bedrock",
    api: "bedrock-converse-stream",
    input: ["text"],
    maxTokens: 4096,
    reasoning: false,
  };
  const context = {
    systemPrompt: `STABLE SYSTEM PREFIX${SYSTEM_PROMPT_CACHE_BOUNDARY}DYNAMIC TAIL BELOW`,
    messages: [{ role: "user", content: "hello" }],
    tools: [],
  };

  let captured: Record<string, unknown> | undefined;
  // streamWithPayloadPatch chains this AFTER applyBedrockSystemPromptCacheBoundary,
  // so `payload` here is the reshaped Converse command. Throwing aborts pi-ai
  // before it constructs/sends the real ConverseStreamCommand.
  const capturingOnPayload = (payload: Record<string, unknown>) => {
    captured = structuredClone(payload);
    throw new Error(CAPTURE_ABORT);
  };

  const streamObj = wrapped(model, context, {
    cacheRetention,
    maxTokens: 512,
    onPayload: capturingOnPayload,
  });
  try {
    await streamObj.result();
  } catch {
    // Aborted by capturingOnPayload before send (or finalized with the abort error).
  }
  if (!captured) {
    throw new Error("pi-ai never invoked onPayload — reposition would never run in production");
  }
  return captured;
}

describe("Bedrock cache boundary — runtime effect through real pi-ai streamBedrock", () => {
  beforeEach(() => {
    process.env.AWS_BEDROCK_SKIP_AUTH = "1"; // dummy creds; we abort before any send anyway
  });

  it("pi-ai invokes onPayload and the outbound Converse system is split at the boundary", async () => {
    const command = await captureConverseCommand("short");

    // The proof: pi-ai's own buildSystemPrompt produced ONE text block + a trailing
    // cachePoint; after the reposition the outbound system is the 3-block boundary
    // form. If onPayload had never fired, captureConverseCommand would have thrown.
    expect(command.system).toEqual([
      { text: "STABLE SYSTEM PREFIX" },
      { cachePoint: { type: "default" } },
      { text: "DYNAMIC TAIL BELOW" },
    ]);
    // Boundary marker consumed (never sent to Bedrock).
    expect(JSON.stringify(command.system)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
    // Last-user cachePoint (pi-ai native) still present → dual cachePoint.
    const messages = command.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const lastUser = messages[messages.length - 1];
    expect(lastUser.content.some((b) => b.cachePoint != null)).toBe(true);
  });

  it("long retention propagates a 1h ttl to the repositioned system cachePoint", async () => {
    const command = await captureConverseCommand("long");
    expect(command.system).toEqual([
      { text: "STABLE SYSTEM PREFIX" },
      { cachePoint: { type: "default", ttl: "1h" } },
      { text: "DYNAMIC TAIL BELOW" },
    ]);
  });

  it("leaves additionalModelRequestFields intact (orthogonal to patch-010 output_config.effort)", async () => {
    const command = await captureConverseCommand("short");
    // patch-010 injects additionalModelRequestFields.output_config.effort AFTER
    // onPayload, on a different key. The reposition only touches `system`, so
    // whatever pi-ai placed under additionalModelRequestFields is preserved.
    expect(command).toHaveProperty("additionalModelRequestFields");
    const amrf = command.additionalModelRequestFields;
    expect(amrf === undefined || typeof amrf === "object").toBe(true);
  });
});
