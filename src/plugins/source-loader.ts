import { withProfile } from "./plugin-load-profile.js";
import {
  createPluginModuleLoaderCache,
  getCachedPluginSourceModuleLoader,
  type PluginModuleLoaderCache,
} from "./plugin-module-loader-cache.js";

export type PluginSourceLoader = (modulePath: string) => unknown;

// Process-global loader cache. Plugin source is immutable at runtime, so the
// jiti loaders (keyed by `${loaderFilename}::{tryNative,aliasMap}`) are safe to
// reuse for the lifetime of the process. Creating a fresh cache per call
// retained one loader set — and its cache-key strings — per caller, leaking
// ~hundreds of copies of every provider module graph. Mirrors the module-level
// singleton already used by public-surface-loader.ts, setup-registry.ts, etc.
const moduleLoaders: PluginModuleLoaderCache = createPluginModuleLoaderCache();

export function createPluginSourceLoader(): PluginSourceLoader {
  return (modulePath) => {
    const sourceLoader = getCachedPluginSourceModuleLoader({
      cache: moduleLoaders,
      modulePath,
      importerUrl: import.meta.url,
      loaderFilename: import.meta.url,
    });
    // Direct source loads are not associated with a specific plugin id —
    // preserve the existing `plugin=(direct)` field used by tooling that
    // scrapes [plugin-load-profile] lines.
    return withProfile({ pluginId: "(direct)", source: modulePath }, "source-loader", () =>
      sourceLoader(modulePath),
    );
  };
}
