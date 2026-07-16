import { resolveAgentMaxConcurrent, resolveSubagentMaxConcurrent } from "../config/agent-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setCommandLaneConcurrency } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";

export function applyGatewayLaneConcurrency(cfg: OpenClawConfig) {
  const cronRunConcurrency = cfg.cron?.maxConcurrentRuns ?? 1;
  setCommandLaneConcurrency(CommandLane.Cron, cronRunConcurrency);
  // Scheduled cron agent turns execute on the nested lane (resolveNestedAgentLane
  // maps the cron lane to nested to avoid deadlock). Without an explicit cap the
  // nested lane falls back to maxConcurrent=1, serializing all reminder turns
  // fleet-wide regardless of cron.maxConcurrentRuns — keep the two aligned.
  setCommandLaneConcurrency(CommandLane.Nested, cronRunConcurrency);
  setCommandLaneConcurrency(CommandLane.Main, resolveAgentMaxConcurrent(cfg));
  setCommandLaneConcurrency(CommandLane.Subagent, resolveSubagentMaxConcurrent(cfg));
}
