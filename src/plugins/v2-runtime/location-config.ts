// FILE: src/plugins/v2-runtime/location-config.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Resolve the effective vvoc configuration per session location for the OpenCode v2 runtime, replacing the v1 startup-snapshot model.
//   SCOPE: Per-directory effective config resolution through the existing layer engine with TTL caching, session-to-directory mapping through the v2 session API, watcher-driven invalidation, and fail-closed behavior for unresolvable locations.
//   DEPENDS: [src/lib/config-layers.ts]
//   LINKS: [M-PLUGIN-V2-RUNTIME, V-M-PLUGIN-V2-RUNTIME, M-CONFIG-LAYERS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   LocationConfigSnapshot - Effective config resolved for one directory plus source metadata and load time.
//   LocationResolverOptions - Injectable loader, logger, TTL, and clock for deterministic tests.
//   createLocationResolver - Build a per-directory caching resolver with session mapping and invalidation.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-002 - Created the per-location config resolver for the v2 runtime.]
// END_CHANGE_SUMMARY

import { loadVvocConfigForRead } from "../../lib/config-layers.js";
import type { ConfigSource } from "../../lib/config-layers.js";
import type { VvocConfig } from "../../lib/vvoc-config.js";

// START_BLOCK_LOCATION_CONFIG_SNAPSHOT
/**
 * Effective vvoc config resolved for one session location directory.
 */
export interface LocationConfigSnapshot {
  readonly directory: string;
  readonly config: VvocConfig;
  readonly source: ConfigSource;
  readonly warnings: readonly string[];
  readonly loadedAt: number;
}
// END_BLOCK_LOCATION_CONFIG_SNAPSHOT

// START_BLOCK_LOCATION_RESOLVER_OPTIONS
export interface LocationResolverOptions {
  /**
   * Injectable effective-config loader for one directory. Defaults to the
   * layer engine with effective scope and default fallback, mirroring the v1
   * startup snapshot semantics for that directory.
   */
  loadForDirectory?: (
    directory: string,
  ) => Promise<Omit<LocationConfigSnapshot, "directory" | "loadedAt">>;

  /** TTL in milliseconds for cached entries; defaults to 2000. */
  ttlMs?: number;

  /** Injectable logger receiving resolution failure warnings. */
  warn?: (message: string) => void;

  /** Injectable clock in milliseconds for deterministic tests. */
  now?: () => number;
}

type CacheEntry = {
  value: LocationConfigSnapshot | undefined;
  expiresAt: number;
};
// END_BLOCK_LOCATION_RESOLVER_OPTIONS

// START_BLOCK_CREATE_LOCATION_RESOLVER
export interface LocationResolver {
  /** Resolve the effective config for one directory, or undefined when it cannot be loaded (fail closed). */
  forDirectory(directory: string): Promise<LocationConfigSnapshot | undefined>;
  /** Resolve the effective config for a session through its persisted location directory. */
  forSession(
    sessionID: string,
    sessionGet: (input: {
      sessionID: string;
    }) => Promise<{ location?: { directory?: string } } | undefined>,
  ): Promise<LocationConfigSnapshot | undefined>;
  /** Drop the cached entry for one directory so the next read reloads from disk. */
  invalidate(directory: string): void;
  /** Number of directories currently cached; exposed for tests and diagnostics. */
  readonly cachedDirectories: readonly string[];
}

/**
 * Build the per-location resolver.
 *
 * A directory whose config fails to load resolves to undefined after a logged
 * warning, and that failure is cached for the TTL so a broken project does not
 * hammer the filesystem from every hook invocation. Plugins treat undefined as
 * disabled for that location, preserving the v1 fail-closed posture.
 */
export function createLocationResolver(options: LocationResolverOptions = {}): LocationResolver {
  const ttlMs = options.ttlMs ?? 2000;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const now = options.now ?? Date.now;
  const load =
    options.loadForDirectory ??
    (async (directory: string) => {
      const read = await loadVvocConfigForRead({
        cwd: directory,
        scope: "effective",
        allowDefault: true,
      });
      return { config: read.config, source: read.source, warnings: read.warnings };
    });

  const cache = new Map<string, CacheEntry>();

  async function resolve(directory: string): Promise<LocationConfigSnapshot | undefined> {
    const key = directory;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) {
      return cached.value;
    }

    let value: LocationConfigSnapshot | undefined;
    try {
      value = { directory, ...(await load(directory)), loadedAt: now() };
    } catch (error) {
      warn(
        `[vvoc][v2-runtime] config resolution failed for ${directory}: ${String(error)}; plugins stay disabled for this location`,
      );
      value = undefined;
    }
    cache.set(key, { value, expiresAt: now() + ttlMs });
    return value;
  }

  return {
    async forDirectory(directory) {
      return resolve(directory);
    },
    async forSession(sessionID, sessionGet) {
      let directory: string | undefined;
      try {
        const session = await sessionGet({ sessionID });
        directory = session?.location?.directory;
      } catch (error) {
        warn(
          `[vvoc][v2-runtime] session lookup failed for ${sessionID}: ${String(error)}; plugins stay disabled for this session`,
        );
        return undefined;
      }
      if (!directory) {
        warn(
          `[vvoc][v2-runtime] session ${sessionID} has no location directory; plugins stay disabled for this session`,
        );
        return undefined;
      }
      return resolve(directory);
    },
    invalidate(directory) {
      cache.delete(directory);
    },
    get cachedDirectories() {
      return [...cache.keys()];
    },
  };
}
// END_BLOCK_CREATE_LOCATION_RESOLVER
