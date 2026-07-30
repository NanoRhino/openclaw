import { normalizeToolName } from "./tool-policy.js";

export type ExplicitToolAllowlistSource = {
  label: string;
  entries: string[];
};

export function collectExplicitToolAllowlistSources(
  sources: Array<{ label: string; allow?: string[] }>,
): ExplicitToolAllowlistSource[] {
  return sources.flatMap((source) => {
    const entries = (source.allow ?? []).map((entry) => entry.trim()).filter(Boolean);
    return entries.length ? [{ label: source.label, entries }] : [];
  });
}

export function buildEmptyExplicitToolAllowlistError(params: {
  sources: ExplicitToolAllowlistSource[];
  callableToolNames: string[];
  toolsEnabled: boolean;
  disableTools?: boolean;
}): Error | null {
  // A deliberately tool-less run (disableTools, e.g. the final-tag discard
  // retry on a side-effect turn) is the intended state, not an allowlist
  // mistake — the guard exists to catch configs whose allowlist names no
  // registered tool. Erroring here turned every such retry into a
  // surface_error on agents with an explicit tools.allow (2026-07-30: all
  // production coach agents; the retry crashed and only model-fallback
  // rescued the reply).
  if (params.disableTools === true) {
    return null;
  }
  const callableToolNames = params.callableToolNames.map(normalizeToolName).filter(Boolean);
  if (params.sources.length === 0 || callableToolNames.length > 0) {
    return null;
  }
  const requested = params.sources
    .map((source) => `${source.label}: ${source.entries.map(normalizeToolName).join(", ")}`)
    .join("; ");
  const reason = params.toolsEnabled
    ? "no registered tools matched"
    : "the selected model does not support tools";
  return new Error(
    `No callable tools remain after resolving explicit tool allowlist (${requested}); ${reason}. Fix the allowlist or enable the plugin that registers the requested tool.`,
  );
}
