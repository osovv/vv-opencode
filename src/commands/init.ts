// FILE: src/commands/init.ts
// VERSION: 0.5.0
// START_MODULE_CONTRACT
//   PURPOSE: Interactive project initialization: registers @osovv/vv-opencode in OpenCode plugin array and scaffolds the canonical vvoc.json config plus managed prompts. Uses @clack/prompts for TTY prompts. Interactive mode is the default; --non-interactive flag enables batch mode.
//   SCOPE: Scope selection, plugin registration, managed OpenCode agent registration, managed agent prompt scaffolding, canonical config scaffolding, and idempotent re-run handling.
//   DEPENDS: [citty, @clack/prompts, src/lib/opencode.js]
//   LINKS: [M-CLI-INIT, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Init command definition for vvoc.
//   runInit - Run the initialization flow.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.5.0 - Switched init to seed the canonical global vvoc.json config file.]
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
  type Scope,
} from "../lib/opencode.js";

export default defineCommand({
  meta: {
    name: "init",
    description: "Initialize vvoc in a project or globally.",
  },
  args: {
    scope: {
      type: "enum",
      options: ["global", "project"],
      default: "global",
      description: "Initialize globally or per-project.",
    },
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
    "config-dir": {
      type: "string",
      description: "Override the global config home.",
    },
  },
  async run({ args }) {
    // START_BLOCK_RUN_INIT
    const nonInteractive = args["non-interactive"] === true;
    const scope = (args.scope === "project" ? "project" : "global") as Scope;
    const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
    const cwd = process.cwd();

    p.intro("Initializing vvoc");

    try {
      await runInit({ scope, cwd, configDir, nonInteractive });
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

async function runInit(options: {
  scope: Scope;
  cwd: string;
  configDir?: string;
  nonInteractive: boolean;
}): Promise<void> {
  const { scope, cwd, configDir, nonInteractive } = options;

  let selectedScope: Scope = scope;
  if (!nonInteractive) {
    const scopeAnswer = await p.select({
      message: "Select installation scope:",
      options: [
        { label: "Global (all projects)", value: "global" },
        { label: "Project (current directory only)", value: "project" },
      ],
      initialValue: scope,
    });

    if (p.isCancel(scopeAnswer)) {
      throw new Error("ABORTED");
    }
    selectedScope = scopeAnswer as Scope;

    const reloadedPaths = await resolvePaths({ scope: selectedScope, cwd, configDir });
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

  const finalPaths = await resolvePaths({ scope: selectedScope, cwd, configDir });

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

export async function runInitNonInteractive(options: {
  scope: Scope;
  cwd: string;
  configDir?: string;
}): Promise<void> {
  const { scope, cwd, configDir } = options;
  const paths = await resolvePaths({ scope, cwd, configDir });

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
