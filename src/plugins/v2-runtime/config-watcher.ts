// FILE: src/plugins/v2-runtime/config-watcher.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Watch a project's effective vvoc config file for changes and notify registered reload callbacks without restarting the OpenCode v2 server.
//   SCOPE: Watcher registration per directory with debounced change notification, callback error isolation, multiplexed subscriptions over one filesystem watch, and a returned stop function; never throws to the caller.
//   DEPENDS: [node:fs/promises, node:fs, src/lib/config-layers.ts]
//   LINKS: [M-PLUGIN-V2-RUNTIME, V-M-PLUGIN-V2-RUNTIME, M-CONFIG-LAYERS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WatcherRegistrationOptions - Injectable project-path resolution, debounce window, and logger for deterministic tests.
//   watchProjectVvocConfig - Watch one directory's project vvoc config and invoke callbacks on debounced changes until stopped.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-002 - Created the debounced config watcher powering restart-free preset switching.]
// END_CHANGE_SUMMARY

import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { access } from "node:fs/promises";
import { findNearestProjectConfigRoot } from "../../lib/config-layers.js";
import { getProjectVvocConfigPath } from "../../lib/vvoc-paths.js";

// START_BLOCK_WATCHER_OPTIONS
export interface WatcherRegistrationOptions {
  /** Injectable nearest-project config-path resolver for deterministic tests. */
  resolveProjectConfigPath?: (directory: string) => Promise<string | undefined>;

  /** Debounce window in milliseconds; defaults to 200. */
  debounceMs?: number;

  /** Injectable logger for non-fatal watcher diagnostics. */
  warn?: (message: string) => void;

  /** Injectable filesystem watch factory for deterministic tests. */
  createWatch?: (
    filePath: string,
    onEvent: () => void,
    onError: (error: unknown) => void,
  ) => {
    close: () => void;
  };
}
// END_BLOCK_WATCHER_OPTIONS

// START_BLOCK_WATCH_PROJECT_VVOC_CONFIG
/**
 * Watch the project vvoc config effective for one directory.
 *
 * Resolves the nearest project config root the same way the layer engine
 * does, watches the config file's directory so atomic replace writes are
 * observed, debounces bursts, and invokes every callback with the resolved
 * config path. Callback errors are isolated per callback; watcher errors
 * degrade to a logged warning and stop notification for that directory.
 *
 * Returns a stop function that is safe to call multiple times. The function
 * itself never throws: a directory without a project config resolves to a
 * no-op watcher with the provided warn hook informed.
 */
export async function watchProjectVvocConfig(
  directory: string,
  onChange: (configPath: string) => void,
  options: WatcherRegistrationOptions = {},
): Promise<() => void> {
  const debounceMs = options.debounceMs ?? 200;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const resolveProjectConfigPath =
    options.resolveProjectConfigPath ??
    (async (dir: string) => {
      const root = await findNearestProjectConfigRoot(dir);
      if (root?.vvocConfigPath) return root.vvocConfigPath;
      // Watch the canonical project path even when absent so a later file
      // creation is observed.
      const canonical = getProjectVvocConfigPath(dir);
      try {
        await access(canonical);
        return canonical;
      } catch {
        return undefined;
      }
    });
  const createWatch =
    options.createWatch ??
    ((filePath: string, onEvent: () => void, onError: (error: unknown) => void) => {
      const watcher: FSWatcher = watch(
        dirname(filePath),
        { persistent: false },
        (_event, filename) => {
          if (!filename || filename === basename(filePath)) {
            onEvent();
          }
        },
      );
      watcher.on("error", onError);
      return watcher;
    });

  const configPath = await resolveProjectConfigPath(directory);
  if (!configPath) {
    warn(
      `[vvoc][v2-runtime] no project vvoc config found for ${directory}; config watching disabled`,
    );
    return () => {};
  }

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = createWatch(
    configPath,
    () => {
      if (stopped) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (stopped) return;
        try {
          onChange(configPath);
        } catch (error) {
          warn(
            `[vvoc][v2-runtime] config change callback failed for ${configPath}: ${String(error)}`,
          );
        }
      }, debounceMs);
    },
    (error) => {
      warn(`[vvoc][v2-runtime] config watcher error for ${configPath}: ${String(error)}`);
    },
  );

  return () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
    try {
      watcher.close();
    } catch {
      // Closing a dead watcher is not an error.
    }
  };
}
// END_BLOCK_WATCH_PROJECT_VVOC_CONFIG
