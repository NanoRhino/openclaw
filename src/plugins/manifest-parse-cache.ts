import type { Stats } from "node:fs";

/**
 * Process-level cache for parsed plugin manifest files.
 *
 * Manifest discovery is already cached, but the JSON5 parse itself was not:
 * every per-workspace registry build re-read and re-parsed each manifest, so a
 * host running many agent workspaces kept one copy of every parse product per
 * workspace and re-ran the synchronous parses in bursts. Parsed manifests are
 * immutable metadata derived purely from file bytes, so one deep-frozen copy
 * per file identity is shared across all workspaces instead.
 *
 * Entries are keyed by absolute path and validated against the stat of the
 * verified file descriptor, so any content change (or replace-by-rename)
 * invalidates the entry. `OPENCLAW_DISABLE_MANIFEST_PARSE_CACHE=1` restores the
 * previous parse-every-time behavior.
 */

export const MANIFEST_PARSE_CACHE_MAX_ENTRIES = 512;

export type ManifestFileStat = Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">;

export type ManifestParseCacheIdentity = {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
};

type ManifestParseCacheEntry = {
  readonly identity: ManifestParseCacheIdentity;
  readonly value: unknown;
};

const manifestParseCache = new Map<string, ManifestParseCacheEntry>();

function isDisabledFlag(raw: string | undefined): boolean {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized !== "0" && normalized !== "false" && normalized !== "off";
}

export function isManifestParseCacheDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isDisabledFlag(env.OPENCLAW_DISABLE_MANIFEST_PARSE_CACHE);
}

/**
 * Returns the cache identity for an opened manifest file, or `null` when the
 * cache is disabled or the stat cannot be trusted (fail open: parse fresh).
 */
export function resolveManifestParseCacheIdentity(
  stat: ManifestFileStat,
  env: NodeJS.ProcessEnv = process.env,
): ManifestParseCacheIdentity | null {
  if (isManifestParseCacheDisabled(env)) {
    return null;
  }
  try {
    const identity: ManifestParseCacheIdentity = {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
    const usable =
      Number.isFinite(identity.dev) &&
      Number.isFinite(identity.ino) &&
      Number.isFinite(identity.size) &&
      Number.isFinite(identity.mtimeMs) &&
      Number.isFinite(identity.ctimeMs);
    return usable ? identity : null;
  } catch {
    return null;
  }
}

function isSameIdentity(
  left: ManifestParseCacheIdentity,
  right: ManifestParseCacheIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

export function readManifestParseCache<T>(
  key: string,
  identity: ManifestParseCacheIdentity,
): T | undefined {
  try {
    const entry = manifestParseCache.get(key);
    if (!entry) {
      return undefined;
    }
    if (!isSameIdentity(entry.identity, identity)) {
      manifestParseCache.delete(key);
      return undefined;
    }
    // Re-insert so eviction drops the least recently used manifest.
    manifestParseCache.delete(key);
    manifestParseCache.set(key, entry);
    return entry.value as T;
  } catch {
    return undefined;
  }
}

/**
 * Deep-freezes and stores the parse product, returning the frozen value so the
 * first caller shares the same object the cache hands out later.
 */
export function writeManifestParseCache<T>(
  key: string,
  identity: ManifestParseCacheIdentity,
  value: T,
): T {
  try {
    const frozen = deepFreeze(value);
    manifestParseCache.delete(key);
    manifestParseCache.set(key, { identity, value: frozen });
    while (manifestParseCache.size > MANIFEST_PARSE_CACHE_MAX_ENTRIES) {
      const oldest = manifestParseCache.keys().next();
      if (oldest.done) {
        break;
      }
      manifestParseCache.delete(oldest.value);
    }
    return frozen;
  } catch {
    return value;
  }
}

export function clearPluginManifestParseCache(): void {
  manifestParseCache.clear();
}

export function getPluginManifestParseCacheSize(): number {
  return manifestParseCache.size;
}

export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Object.isFrozen(value)) {
    return value;
  }
  // Freeze before recursing so self-referential structures terminate.
  Object.freeze(value);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
