// FILE: src/commands/sync.ts
// VERSION: 0.5.0
// START_MODULE_CONTRACT
//   PURPOSE: Sync the canonical vvoc.json config file, managed prompts, and keep OpenCode runtime/TUI plugin specifiers current.
//   SCOPE: Scope parsing, path resolution, pinned runtime/TUI plugin sync, managed OpenCode agent sync, managed agent prompt sync, managed plan directory sync, and canonical vvoc config rewrite.
//   DEPENDS: [citty, src/lib/opencode.ts]
//   LINKS: [M-CLI-COMMANDS, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Sync command definition for vvoc-managed config files.
//   runSync - Testable sync flow with injectable native host verification.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-007 - Added a fail-closed native host window preflight and extracted an injectable runSync flow.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import {
  assertSupportedOpenCodeRuntime,
  describeWriteResult,
  ensureManagedSkillSymlink,
  ensurePackageInstalled,
  ensureTuiPackageInstalled,
  resolvePaths,
  readVvocConfig,
  syncManagedAgentPrompts,
  syncManagedAgentRegistrations,
  syncVvocConfig,
  syncManagedSkillFiles,
  type OpenCodeRuntimeInspection,
  type Scope,
} from "../lib/opencode.js";

export default defineCommand({
  meta: {
    name: "sync",
    description: "Sync managed vv-opencode config files.",
  },
  args: {
    scope: {
      type: "enum",
      options: ["global", "project"],
      default: "global",
      description: "Sync global or project config.",
    },
    "config-dir": {
      type: "string",
      description: "Override the global config home used for opencode/ and vvoc/.",
    },
    force: {
      type: "boolean",
      description: "Allow rewriting unmanaged managed-prompt files.",
    },
  },
  async run({ args }) {
    await runSync(args as Record<string, unknown>);
  },
});

export async function runSync(
  args: Record<string, unknown>,
  options: { inspectRuntime?: () => Promise<OpenCodeRuntimeInspection> } = {},
): Promise<void> {
  // START_BLOCK_APPLY_SYNC_COMMAND
  const scope = args.scope === "project" ? "project" : "global";
  const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
  const paths = await resolvePaths({
    scope: scope as Scope,
    cwd: process.cwd(),
    configDir,
  });
  // Preflight: fail closed on an unverifiable or out-of-window host, and
  // strictly validate any existing vvoc.json, before mutating anything so the
  // command fails loudly up front instead of after a partial sync.
  await assertSupportedOpenCodeRuntime(options.inspectRuntime);
  await readVvocConfig(paths);
  const opencode = await ensurePackageInstalled(paths);
  const tui = await ensureTuiPackageInstalled(paths);
  const managedAgents = await syncManagedAgentRegistrations(paths);
  const managedPrompts = await syncManagedAgentPrompts(paths, { force: Boolean(args.force) });
  const managedSkills = await syncManagedSkillFiles(paths, { force: Boolean(args.force) });
  const vvocConfig = await syncVvocConfig(paths);

  console.log(`${opencode.changed ? "Updated" : "Kept"} ${opencode.path}`);
  console.log(describeWriteResult(tui));
  console.log(
    `${managedAgents.changed ? "Updated" : "Kept"} ${managedAgents.path} (managed agents)`,
  );
  for (const result of managedPrompts) {
    console.log(describeWriteResult(result));
  }
  for (const result of managedSkills) {
    console.log(describeWriteResult(result));
  }
  console.log(describeWriteResult(vvocConfig));

  if (paths.scope === "global") {
    const symlinkResult = await ensureManagedSkillSymlink(configDir);
    console.log(describeWriteResult(symlinkResult));
  }
  // END_BLOCK_APPLY_SYNC_COMMAND
}
