import type { OpenClawConfig } from "../../../config/config.js";
import type { ProviderRuntimeModel } from "../../../plugins/provider-runtime-model.types.js";
import { isReasoningTagProvider } from "../../../utils/provider-utils.js";
import { resolveAgentEnforceFinalTag } from "../../agent-scope.js";

export function resolveEmbeddedEnforceFinalTag(params: {
  explicit?: boolean;
  config?: OpenClawConfig;
  agentId?: string;
  provider?: string;
  workspaceDir?: string;
  modelId?: string;
  model?: ProviderRuntimeModel;
}): boolean {
  if (params.explicit !== undefined) {
    return params.explicit;
  }
  const configured = resolveAgentEnforceFinalTag(params.config, params.agentId);
  if (configured !== undefined) {
    return configured;
  }
  return isReasoningTagProvider(params.provider, {
    config: params.config,
    workspaceDir: params.workspaceDir,
    modelId: params.modelId,
    model: params.model,
  });
}
