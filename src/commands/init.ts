// FILE: src/commands/init.ts
// VERSION: 0.6.0
// START_MODULE_CONTRACT
//   PURPOSE: Interactive global initialization: register @osovv/vv-opencode in OpenCode config and scaffold the canonical vvoc.json config plus managed prompts. Uses @clack/prompts for TTY prompts. Interactive mode is the default; --non-interactive flag enables batch mode.
//   SCOPE: Global plugin registration, managed OpenCode agent registration, managed agent prompt scaffolding, canonical config scaffolding, and idempotent re-run handling.
//   DEPENDS: [citty, @clack/prompts, src/lib/opencode.js]
//   LINKS: [M-CLI-INIT, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Init command definition for vvoc.
//   runInit - Run the initialization flow.
//   runInitNonInteractive - Run the non-interactive initialization flow.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.6.0 - Removed scope/config-dir prompts and always initialize the canonical global config layout.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import {
  ensurePackageInstalled,
  installManagedAgentPrompts,
  installVvocConfig,
  inspectInstallation,
  resolvePaths,
  syncManagedAgentRegistrations,
} from "../lib/opencode.js";

export default defineCommand({
  meta: {
    name: "init",
    description: "Initialize vvoc globally.",
  },
  args: {
    plugins: {
      type: "string",
      default: "@osovv/vv-opencode",
      description: "Comma-separated list of plugins to enable.",
    },
    "non-interactive": {
      type: "boolean",
      default: false,
      description: "Skip interactive prompts and use defaults.",
    },
  },
  async run({ args }) {
    // START_BLOCK_RUN_INIT
    const nonInteractive = args["non-interactive"] === true;

    p.intro("Initializing vvoc");

    try {
      await runInit({ nonInteractive });
      p.outro("vvoc initialized successfully");
    } catch (err) {
      if (err instanceof Error && err.message === "ABORTED") {
        p.cancel("Initialization cancelled");
        process.exitCode = 130;
      } else {
        p.cancel("Initialization failed: " + (err instanceof Error ? err.message : String(err)));
        process.exitCode = 1;
      }
    }
    // END_BLOCK_RUN_INIT
  },
});

async function runInit(options: { configDir?: string; nonInteractive: boolean }): Promise<void> {
  const { configDir, nonInteractive } = options;

  if (!nonInteractive) {
    const reloadedPaths = await resolvePaths({ configDir });
    const inspection = await inspectInstallation(reloadedPaths);

    if (inspection.opencode.pluginConfigured && inspection.vvoc.exists) {
      const overwrite = await p.confirm({
        message: `@osovv/vv-opencode is already configured. Overwrite?`,
        initialValue: false,
      });

      if (p.isCancel(overwrite)) {
        throw new Error("ABORTED");
      }
      if (!overwrite) {
        p.cancel("Already configured. Run `vvoc sync` to update configs.");
        return;
      }
    }
  }

  const finalPaths = await resolvePaths({ configDir });

  p.log.step("Registering plugin in OpenCode config...");
  const pkgResult = await ensurePackageInstalled(finalPaths);
  p.log.info(pkgResult.path + " - " + (pkgResult.changed ? "updated" : "already up to date"));

  p.log.step("Registering managed agents...");
  const agentRegistration = await syncManagedAgentRegistrations(finalPaths);
  p.log.info(
    agentRegistration.path + " - " + (agentRegistration.changed ? "updated" : "already up to date"),
  );

  p.log.step("Scaffolding managed agent prompts...");
  for (const result of await installManagedAgentPrompts(finalPaths, { force: true })) {
    p.log.info(result.path + " - " + result.action);
  }

  p.log.step("Scaffolding canonical vvoc config...");
  const vvocConfigResult = await installVvocConfig(finalPaths);
  p.log.info(vvocConfigResult.path + " - " + vvocConfigResult.action);

  p.outro(`vvoc initialized successfully

💡 Highly recommended: Install RTK for 60-90% token savings on git/test/lint commands
   curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
   rtk init -g --opencode`);
}

export async function runInitNonInteractive(
  options: {
    configDir?: string;
  } = {},
): Promise<void> {
  const { configDir } = options;
  const paths = await resolvePaths({ configDir });

  const inspection = await inspectInstallation(paths);
  if (inspection.opencode.pluginConfigured && inspection.vvoc.exists) {
    console.log("Already configured. Run `vvoc sync` to update configs.");
    return;
  }

  await ensurePackageInstalled(paths);
  await syncManagedAgentRegistrations(paths);
  await installManagedAgentPrompts(paths, { force: true });
  await installVvocConfig(paths);
}
