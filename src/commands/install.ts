// FILE: src/commands/install.ts
// VERSION: 0.5.0
// START_MODULE_CONTRACT
//   PURPOSE: Install vv-opencode into OpenCode runtime/TUI config and bootstrap the canonical vvoc.json config plus managed prompts.
//   SCOPE: Scope parsing, path resolution, pinned runtime/TUI plugin registration, managed OpenCode agent registration, managed agent prompt and plan directory scaffolding, and canonical vvoc config creation.
//   DEPENDS: [citty, src/lib/opencode.ts]
//   LINKS: [M-CLI-COMMANDS, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Install command definition for plugin registration and vvoc config bootstrap.
//   runInstall - Testable install flow with injectable native host verification.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-CLI-JSON-PIN-SYNC-R1 T-001 - Kept the native cli.json TUI client pin in sync beside the opencode.json server pin.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import {
  assertSupportedOpenCodeRuntime,
  describeWriteResult,
  ensureManagedSkillSymlink,
  ensureCliPackageInstalled,
  ensurePackageInstalled,
  installManagedAgentPrompts,
  installVvocConfig,
  installManagedSkillFiles,
  readVvocConfig,
  resolvePaths,
  syncManagedAgentRegistrations,
  type OpenCodeRuntimeInspection,
  type Scope,
} from "../lib/opencode.js";

export default defineCommand({
  meta: {
    name: "install",
    description: "Install vv-opencode into OpenCode config.",
  },
  args: {
    scope: {
      type: "enum",
      options: ["global", "project"],
      default: "global",
      description: "Write to global or project config.",
    },
    "config-dir": {
      type: "string",
      description: "Override the global config home used for opencode/ and vvoc/.",
    },
    force: {
      type: "boolean",
      description: "Allow overwriting managed prompt files when needed.",
    },
  },
  async run({ args }) {
    await runInstall(args as Record<string, unknown>);
  },
});

export async function runInstall(
  args: Record<string, unknown>,
  options: { inspectRuntime?: () => Promise<OpenCodeRuntimeInspection> } = {},
): Promise<void> {
  // START_BLOCK_APPLY_INSTALL_COMMAND
  const scope = args.scope === "project" ? "project" : "global";
  const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
  const paths = await resolvePaths({
    scope: scope as Scope,
    cwd: process.cwd(),
    configDir,
  });
  // Preflight: fail closed on an unverifiable or out-of-window host, and
  // strictly validate any existing vvoc.json, before mutating anything so the
  // command fails loudly up front instead of after a partial install.
  await assertSupportedOpenCodeRuntime(options.inspectRuntime);
  await readVvocConfig(paths);
  const opencode = await ensurePackageInstalled(paths);
  const cliPin = await ensureCliPackageInstalled(paths);
  const managedAgents = await syncManagedAgentRegistrations(paths);

  console.log(`${opencode.changed ? "Updated" : "Kept"} ${opencode.path}`);
  console.log(`${cliPin.changed ? "Updated" : "Kept"} ${cliPin.path} (TUI client pin)`);
  console.log(
    `${managedAgents.changed ? "Updated" : "Kept"} ${managedAgents.path} (managed agents)`,
  );

  for (const result of await installManagedAgentPrompts(paths, {
    force: Boolean(args.force),
  })) {
    console.log(describeWriteResult(result));
  }

  for (const result of await installManagedSkillFiles(paths, {
    force: Boolean(args.force),
  })) {
    console.log(describeWriteResult(result));
  }

  const vvocConfig = await installVvocConfig(paths);
  console.log(describeWriteResult(vvocConfig));

  if (paths.scope === "global") {
    const symlinkResult = await ensureManagedSkillSymlink(configDir);
    console.log(describeWriteResult(symlinkResult));
  }
  // END_BLOCK_APPLY_INSTALL_COMMAND
}
