import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __testing, loadOpenClawPlugins } from "./loader.js";
import {
  makeTempDir,
  mkdirSafe,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
} from "./loader.test-fixtures.js";
import { getActivePluginRegistryWorkspaceDir } from "./runtime.js";

// The collapse is opt-in via OPENCLAW_SHARED_REGISTRY_KEY=1 (fleet operators set
// it in the gateway env); these tests exercise the enabled behavior explicitly.
const SHARED_KEY_ENV = "OPENCLAW_SHARED_REGISTRY_KEY";
let previousSharedKeyEnv: string | undefined;

beforeEach(() => {
  previousSharedKeyEnv = process.env[SHARED_KEY_ENV];
  process.env[SHARED_KEY_ENV] = "1";
});

afterEach(() => {
  if (previousSharedKeyEnv === undefined) {
    delete process.env[SHARED_KEY_ENV];
  } else {
    process.env[SHARED_KEY_ENV] = previousSharedKeyEnv;
  }
  resetPluginLoaderTestStateForTest();
});

// Shared, workspace-independent env so the only thing that varies between loads
// is the workspaceDir. A fixed state dir keeps the global extensions root stable,
// and a nonexistent bundled dir keeps the stock root stable.
function sharedEnv(stateDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
  };
}

function workspaceWithLocalExtension(): string {
  const workspaceDir = makeTempDir();
  // Any entry under {workspace}/.openclaw/extensions counts as local plugin
  // material and must keep a per-workspace cache key.
  mkdirSafe(path.join(workspaceDir, ".openclaw", "extensions", "demo"));
  return workspaceDir;
}

const CONFIG = { plugins: { allow: [] } };

describe("registry cache key collapse for workspaces without local plugins", () => {
  it("keeps legacy per-workspace keys when the env flag is not set", () => {
    delete process.env[SHARED_KEY_ENV];
    const env = sharedEnv(makeTempDir());
    const workspaceA = makeTempDir();
    const workspaceB = makeTempDir();

    const { cacheKey: keyA } = __testing.resolvePluginLoadCacheContext({
      config: CONFIG,
      workspaceDir: workspaceA,
      env,
    });
    const { cacheKey: keyB } = __testing.resolvePluginLoadCacheContext({
      config: CONFIG,
      workspaceDir: workspaceB,
      env,
    });

    expect(keyA).not.toBe(keyB);
    expect(keyA).toContain(path.join(workspaceA, ".openclaw", "extensions"));
  });

  it("produces one shared key for two different workspaces that have no local plugins", () => {
    const env = sharedEnv(makeTempDir());
    const workspaceA = makeTempDir();
    const workspaceB = makeTempDir();
    expect(workspaceA).not.toBe(workspaceB);

    const { cacheKey: keyA } = __testing.resolvePluginLoadCacheContext({
      config: CONFIG,
      workspaceDir: workspaceA,
      env,
    });
    const { cacheKey: keyB } = __testing.resolvePluginLoadCacheContext({
      config: CONFIG,
      workspaceDir: workspaceB,
      env,
    });

    expect(keyA).toBe(keyB);
    // The collapsed key is keyed on the shared sentinel, not either workspace path.
    expect(keyA.startsWith("workspace:none::")).toBe(true);
    expect(keyA).not.toContain(workspaceA);
    expect(keyB).not.toContain(workspaceB);
  });

  it("keeps a distinct per-workspace key when the workspace has a local extensions dir", () => {
    const env = sharedEnv(makeTempDir());
    const bareWorkspace = makeTempDir();
    const localPluginWorkspace = workspaceWithLocalExtension();

    const { cacheKey: bareKey } = __testing.resolvePluginLoadCacheContext({
      config: CONFIG,
      workspaceDir: bareWorkspace,
      env,
    });
    const { cacheKey: localKey } = __testing.resolvePluginLoadCacheContext({
      config: CONFIG,
      workspaceDir: localPluginWorkspace,
      env,
    });

    expect(localKey).not.toBe(bareKey);
    // The distinct key embeds the real workspace extensions path; the collapsed
    // key does not.
    expect(localKey).toContain(path.join(localPluginWorkspace, ".openclaw", "extensions"));
    expect(bareKey.startsWith("workspace:none::")).toBe(true);
  });

  it("re-derives a per-workspace key once a workspace adds a local extensions dir", () => {
    const env = sharedEnv(makeTempDir());
    const workspaceDir = makeTempDir();

    const { cacheKey: before } = __testing.resolvePluginLoadCacheContext({
      config: CONFIG,
      workspaceDir,
      env,
    });
    expect(before.startsWith("workspace:none::")).toBe(true);

    // The detection is a filesystem check at key-build time, so creating the dir
    // flips the next key back to the per-workspace form with no cache to bust.
    mkdirSafe(path.join(workspaceDir, ".openclaw", "extensions", "demo"));
    const { cacheKey: after } = __testing.resolvePluginLoadCacheContext({
      config: CONFIG,
      workspaceDir,
      env,
    });

    expect(after).not.toBe(before);
    expect(after).toContain(path.join(workspaceDir, ".openclaw", "extensions"));
  });

  it("restores the shared cache entry for a second no-plugin workspace and activates it under that workspace", () => {
    useNoBundledPlugins();
    const env = sharedEnv(makeTempDir());
    const workspaceA = makeTempDir();
    const workspaceB = makeTempDir();

    const first = loadOpenClawPlugins({ config: CONFIG, workspaceDir: workspaceA, env });
    // Second load is a different workspace but collapses to the same key, so it is
    // served from the cached (shared) registry state rather than rebuilt.
    const second = loadOpenClawPlugins({ config: CONFIG, workspaceDir: workspaceB, env });

    expect(second).toBe(first);
    // Restore-path safety: the shared entry is activated under the *current*
    // caller's workspace, so workspace A's path never leaks to workspace B.
    expect(getActivePluginRegistryWorkspaceDir()).toBe(workspaceB);

    // A workspace that DOES carry local plugin material keeps its own key and
    // therefore does not reuse the shared entry.
    const localPluginWorkspace = workspaceWithLocalExtension();
    const distinct = loadOpenClawPlugins({
      config: CONFIG,
      workspaceDir: localPluginWorkspace,
      env,
    });
    expect(distinct).not.toBe(first);
  });
});
