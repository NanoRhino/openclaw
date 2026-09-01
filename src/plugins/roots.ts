import fs from "node:fs";
import path from "node:path";
import { resolveConfigDir, resolveUserPath } from "../utils.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";

export type PluginSourceRoots = {
  stock?: string;
  global: string;
  workspace?: string;
};

export type PluginCacheInputs = {
  roots: PluginSourceRoots;
  loadPaths: string[];
};

export function resolvePluginSourceRoots(params: {
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): PluginSourceRoots {
  const env = params.env ?? process.env;
  const workspaceRoot = params.workspaceDir ? resolveUserPath(params.workspaceDir, env) : undefined;
  const stock = resolveBundledPluginsDir(env);
  const global = path.join(resolveConfigDir(env), "extensions");
  // Only treat the workspace extensions dir as a plugin root when it exists. Discovery skips a
  // missing dir anyway, but the path also feeds the plugin registry cache key: with hundreds of
  // agent workspaces that carry no local plugins, an unconditional per-workspace root fragments
  // the LRU-bounded cache and forces a full synchronous plugin discovery on nearly every run.
  const workspaceExtensionsDir = workspaceRoot
    ? path.join(workspaceRoot, ".openclaw", "extensions")
    : undefined;
  const workspace =
    workspaceExtensionsDir && fs.existsSync(workspaceExtensionsDir)
      ? workspaceExtensionsDir
      : undefined;
  return { stock, global, workspace };
}

// Shared env-aware key inputs for plugin loader registry reuse.
export function resolvePluginCacheInputs(params: {
  workspaceDir?: string;
  loadPaths?: string[];
  env?: NodeJS.ProcessEnv;
}): PluginCacheInputs {
  const env = params.env ?? process.env;
  const roots = resolvePluginSourceRoots({
    workspaceDir: params.workspaceDir,
    env,
  });
  // Preserve caller order because load-path precedence follows input order.
  const loadPaths = (params.loadPaths ?? [])
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolveUserPath(entry, env));
  return { roots, loadPaths };
}
