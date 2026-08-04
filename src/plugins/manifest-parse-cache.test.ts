import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearPluginManifestParseCache,
  getPluginManifestParseCacheSize,
  MANIFEST_PARSE_CACHE_MAX_ENTRIES,
} from "./manifest-parse-cache.js";
import { loadPluginManifest } from "./manifest.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-manifest-parse-cache", tempDirs);
}

function writeManifest(dir: string, manifest: Record<string, unknown>): string {
  const manifestPath = path.join(dir, "openclaw.plugin.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  return manifestPath;
}

/** Force a distinct stat so cache invalidation is not racing filesystem timestamp resolution. */
function rewriteManifest(manifestPath: string, manifest: Record<string, unknown>): void {
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(manifestPath, future, future);
}

beforeEach(() => {
  delete process.env.OPENCLAW_DISABLE_MANIFEST_PARSE_CACHE;
  clearPluginManifestParseCache();
});

afterEach(() => {
  delete process.env.OPENCLAW_DISABLE_MANIFEST_PARSE_CACHE;
  clearPluginManifestParseCache();
  cleanupTrackedTempDirs(tempDirs);
});

describe("plugin manifest parse cache", () => {
  it("shares one parsed manifest across repeated loads of the same file", () => {
    const dir = makeTempDir();
    writeManifest(dir, { id: "shared", configSchema: { type: "object" } });

    const first = loadPluginManifest(dir, false);
    const second = loadPluginManifest(dir, false);

    expect(first.ok).toBe(true);
    expect(second).toBe(first);
    if (first.ok && second.ok) {
      expect(second.manifest).toBe(first.manifest);
      expect(second.manifest.configSchema).toBe(first.manifest.configSchema);
    }
    expect(getPluginManifestParseCacheSize()).toBe(1);
  });

  it("re-parses after the manifest file changes", () => {
    const dir = makeTempDir();
    const manifestPath = writeManifest(dir, { id: "before", configSchema: { type: "object" } });

    const first = loadPluginManifest(dir, false);
    rewriteManifest(manifestPath, { id: "after", configSchema: { type: "object" } });
    const second = loadPluginManifest(dir, false);

    expect(first.ok && first.manifest.id).toBe("before");
    expect(second.ok && second.manifest.id).toBe("after");
    expect(second).not.toBe(first);
    expect(getPluginManifestParseCacheSize()).toBe(1);
  });

  it("bypasses the cache when OPENCLAW_DISABLE_MANIFEST_PARSE_CACHE is set", () => {
    const dir = makeTempDir();
    writeManifest(dir, { id: "bypassed", configSchema: { type: "object" } });
    process.env.OPENCLAW_DISABLE_MANIFEST_PARSE_CACHE = "1";

    const first = loadPluginManifest(dir, false);
    const second = loadPluginManifest(dir, false);

    expect(first.ok && first.manifest.id).toBe("bypassed");
    expect(second).not.toBe(first);
    expect(second.ok && second.manifest.id).toBe("bypassed");
    expect(Object.isFrozen(first)).toBe(false);
    expect(getPluginManifestParseCacheSize()).toBe(0);
  });

  it("deep-freezes shared manifests so consumers cannot mutate them in place", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      id: "frozen",
      channels: ["sms"],
      configSchema: { type: "object", properties: { token: { type: "string" } } },
    });

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.manifest)).toBe(true);
    expect(Object.isFrozen(result.manifest.configSchema)).toBe(true);
    expect(Object.isFrozen(result.manifest.configSchema.properties)).toBe(true);
    expect(Object.isFrozen(result.manifest.channels)).toBe(true);
    expect(() => {
      (result.manifest as { id: string }).id = "mutated";
    }).toThrow(TypeError);
    expect(result.manifest.id).toBe("frozen");
  });

  it("does not cache failed parses", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), "not json at all {{{}}", "utf-8");

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(false);
    expect(getPluginManifestParseCacheSize()).toBe(0);
  });

  it("evicts least recently used entries beyond the cap", () => {
    const dir = makeTempDir();
    const overflow = 3;
    const total = MANIFEST_PARSE_CACHE_MAX_ENTRIES + overflow;
    const pluginDirs: string[] = [];
    for (let index = 0; index < total; index += 1) {
      const pluginDir = path.join(dir, `plugin-${index}`);
      fs.mkdirSync(pluginDir);
      writeManifest(pluginDir, { id: `plugin-${index}`, configSchema: { type: "object" } });
      pluginDirs.push(pluginDir);
    }

    for (const pluginDir of pluginDirs) {
      expect(loadPluginManifest(pluginDir, false).ok).toBe(true);
    }

    expect(getPluginManifestParseCacheSize()).toBe(MANIFEST_PARSE_CACHE_MAX_ENTRIES);
    // The most recent loads survive; the oldest were evicted.
    const newest = loadPluginManifest(pluginDirs[total - 1]!, false);
    expect(newest.ok && newest.manifest.id).toBe(`plugin-${total - 1}`);
  });
});
