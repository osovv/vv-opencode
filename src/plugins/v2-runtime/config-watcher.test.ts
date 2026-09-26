// FILE: src/plugins/v2-runtime/config-watcher.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify debounced config watching: coalescing, stop behavior, callback error isolation, and the missing-config no-op.
//   SCOPE: Unit tests for watchProjectVvocConfig with injected path resolution and watch factories only.
//   DEPENDS: [src/plugins/v2-runtime/config-watcher.ts]
//   LINKS: [V-M-PLUGIN-V2-RUNTIME, M-PLUGIN-V2-RUNTIME]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   makeFakeWatch - Builds a controllable watch factory capturing event callbacks.
//   sleep - Small real-timer sleep for debounce windows.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-MIGRATION T-002 - Added the config watcher test suite.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { watchProjectVvocConfig } from "./config-watcher.js";

interface FakeWatch {
  emit: () => void;
  error: (error: unknown) => void;
  closeCount: number;
}

function makeFakeWatch() {
  let onEvent: () => void = () => {};
  let onError: (error: unknown) => void = () => {};
  const handle: FakeWatch = {
    emit: () => onEvent(),
    error: (error) => onError(error),
    closeCount: 0,
  };
  const createWatch = (_filePath: string, event: () => void, error: (error: unknown) => void) => {
    onEvent = event;
    onError = error;
    return {
      close: () => {
        handle.closeCount += 1;
      },
    };
  };
  return { handle, createWatch };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

describe("watchProjectVvocConfig", () => {
  test("coalesces a burst of events into one debounced change notification", async () => {
    const { handle, createWatch } = makeFakeWatch();
    const changes: string[] = [];
    const stop = await watchProjectVvocConfig(
      "/tmp/proj-a",
      (configPath) => changes.push(configPath),
      {
        debounceMs: 10,
        resolveProjectConfigPath: async () => "/tmp/proj-a/.vvoc/vvoc.json",
        createWatch,
      },
    );

    handle.emit();
    handle.emit();
    handle.emit();
    await sleep(40);

    expect(changes).toEqual(["/tmp/proj-a/.vvoc/vvoc.json"]);
    stop();
  });

  test("stops notifying after stop() and closes the watcher once", async () => {
    const { handle, createWatch } = makeFakeWatch();
    const changes: string[] = [];
    const stop = await watchProjectVvocConfig(
      "/tmp/proj-a",
      (configPath) => changes.push(configPath),
      {
        debounceMs: 10,
        resolveProjectConfigPath: async () => "/tmp/proj-a/.vvoc/vvoc.json",
        createWatch,
      },
    );

    stop();
    stop();
    handle.emit();
    await sleep(40);

    expect(changes).toEqual([]);
    expect(handle.closeCount).toBe(1);
  });

  test("isolates a throwing change callback and keeps the watcher alive", async () => {
    const { handle, createWatch } = makeFakeWatch();
    const warnings: string[] = [];
    let calls = 0;
    const stop = await watchProjectVvocConfig(
      "/tmp/proj-a",
      () => {
        calls += 1;
        if (calls === 1) throw new Error("callback boom");
      },
      {
        debounceMs: 10,
        resolveProjectConfigPath: async () => "/tmp/proj-a/.vvoc/vvoc.json",
        createWatch,
        warn: (message) => warnings.push(message),
      },
    );

    handle.emit();
    await sleep(40);
    handle.emit();
    await sleep(40);

    expect(calls).toBe(2);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("callback boom");
    stop();
  });

  test("returns a no-op watcher with a warning when no project config exists", async () => {
    const warnings: string[] = [];
    const changes: string[] = [];
    const stop = await watchProjectVvocConfig(
      "/tmp/empty",
      (configPath) => changes.push(configPath),
      {
        resolveProjectConfigPath: async () => undefined,
        createWatch: () => {
          throw new Error("must not create a watcher");
        },
        warn: (message) => warnings.push(message),
      },
    );

    stop();
    expect(changes).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("/tmp/empty");
  });

  test("reports watcher errors without throwing to the caller", async () => {
    const { handle, createWatch } = makeFakeWatch();
    const warnings: string[] = [];
    const stop = await watchProjectVvocConfig("/tmp/proj-a", () => {}, {
      resolveProjectConfigPath: async () => "/tmp/proj-a/.vvoc/vvoc.json",
      createWatch,
      warn: (message) => warnings.push(message),
    });

    handle.error(new Error("watcher died"));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("watcher died");
    stop();
  });
});
