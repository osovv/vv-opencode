// FILE: src/plugins/guardian.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify Guardian plugin registration behavior.
//   SCOPE: Hidden subagent config registration and managed prompt loading for the Guardian plugin.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/plugins/guardian/index.ts]
//   LINKS: [V-M-PLUGIN-GUARDIAN]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   GuardianPlugin config tests - Verify hidden subagent registration with an explicit step limit.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added coverage for Guardian plugin config registration as a hidden subagent.]
// END_CHANGE_SUMMARY

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuardianPlugin } from "./guardian/index.js";

test("GuardianPlugin registers guardian as a hidden subagent", async () => {
  const configHome = await mkdtemp(join(tmpdir(), "vvoc-guardian-config-home-"));
  const projectDir = await mkdtemp(join(tmpdir(), "vvoc-guardian-plugin-"));
  const previousConfigHome = process.env.XDG_CONFIG_HOME;

  try {
    process.env.XDG_CONFIG_HOME = configHome;
    await mkdir(join(configHome, "vvoc", "agents"), { recursive: true });
    await writeFile(
      join(configHome, "vvoc", "agents", "guardian.md"),
      "Custom guardian prompt.\n",
      "utf8",
    );

    const plugin = await GuardianPlugin({
      client: {
        app: {
          log: async () => undefined,
        },
      } as never,
      project: {} as never,
      directory: projectDir,
      worktree: projectDir,
      serverUrl: new URL("http://localhost"),
      $: {} as never,
    });

    const config: Record<string, unknown> = {};
    await plugin.config?.(config as never);

    const guardian = (config.agent as Record<string, Record<string, unknown>>)?.guardian;
    expect(guardian?.mode).toBe("subagent");
    expect(guardian?.hidden).toBe(true);
    expect(guardian?.steps).toBe(2);
    expect(guardian?.prompt).toBe("Custom guardian prompt.");
  } finally {
    if (previousConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousConfigHome;
    }
    await rm(configHome, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
});
