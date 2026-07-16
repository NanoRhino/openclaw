import type { PluginJitiLoaderCache } from "./jiti-loader-cache.js";
import { getCachedPluginJitiLoader } from "./jiti-loader-cache.js";
import { withProfile } from "./plugin-load-profile.js";

export type PluginSourceLoader = (modulePath: string) => unknown;

// patch-008: share one loader cache across all createPluginSourceLoader calls,
// for parity with createPluginJitiLoader (see loader.ts sharedPluginJitiLoaders).
// This cache keys on import.meta.url so it leaks far less than the module-loader
// cache, but a fresh per-call Map is still an unbounded retained copy.
const sharedPluginSourceLoaders: PluginJitiLoaderCache = new Map();

export function createPluginSourceLoader(): PluginSourceLoader {
  const loaders = sharedPluginSourceLoaders;
  return (modulePath) => {
    const jiti = getCachedPluginJitiLoader({
      cache: loaders,
      modulePath,
      importerUrl: import.meta.url,
      jitiFilename: import.meta.url,
    });
    // Direct source loads are not associated with a specific plugin id —
    // preserve the existing `plugin=(direct)` field used by tooling that
    // scrapes [plugin-load-profile] lines.
    return withProfile({ pluginId: "(direct)", source: modulePath }, "source-loader", () =>
      jiti(modulePath),
    );
  };
}
