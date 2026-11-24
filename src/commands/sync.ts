// FILE: src/commands/sync.ts
// VERSION: 0.5.0
// START_MODULE_CONTRACT
//   PURPOSE: Sync the canonical vvoc.json config file, managed prompts, and keep OpenCode runtime/TUI plugin specifiers current.
//   SCOPE: Scope parsing, path resolution, explicit host-gated legacy-orchestration migration of project and global vvoc configs, host-gated V1 OpenCode config materialization, pinned runtime/TUI plugin sync, managed OpenCode agent sync, managed agent prompt sync, managed plan directory sync, and canonical vvoc config rewrite.
//   DEPENDS: [citty, src/lib/opencode.ts, src/lib/opencode/vvoc-orchestration-migration.ts]
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
//   LAST_CHANGE: [C-REMOVE-SESSION-ORCHESTRATION-PROFILES T-004 - Sync migrates legacy orchestration sections from project and global vvoc configs with a backup and change report before strict validation.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import {
  assertSupportedOpenCodeRuntime,
  describeWriteResult,
  ensureManagedSkillSymlink,
  ensureCliPackageInstalled,
  ensurePackageInstalled,
  migrateOpenCodeConfig,
  resolvePaths,
  readVvocConfig,
  syncManagedAgentPrompts,
  syncManagedAgentRegistrations,
  syncVvocConfig,
  syncManagedSkillFiles,
  type OpenCodeRuntimeInspection,
  type Scope,
} from "../lib/opencode.js";
import { migrateVvocOrchestration } from "../lib/opencode/vvoc-orchestration-migration.js";

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
  // Explicit legacy-orchestration migration: runs after the host gate and before
  // the strict config read, covers project and global documents, writes a
  // timestamped backup, and reports every removed section. Invalid JSON is left
  // untouched so the strict read below fails loudly.
  const projectPaths = await resolvePaths({
    scope: "project",
    cwd: process.cwd(),
    configDir,
  });
  const vvocMigration = await migrateVvocOrchestration([projectPaths, paths]);
  for (const migratedDocument of vvocMigration.migrated) {
    console.log(
      `Migrated legacy orchestration from ${migratedDocument.path} (removed: ${migratedDocument.sections.join(", ")}; backup: ${migratedDocument.backupPath})`,
    );
  }
  for (const invalidPath of vvocMigration.skippedInvalid) {
    console.log(
      `Left ${invalidPath} unchanged: invalid JSON; strict vvoc validation will fail loudly.`,
    );
  }
  await readVvocConfig(paths);
  // Host-gated V1-to-V2 materialization: only runs once the host is inside the
  // supported window, before the native document is validated and rewritten.
  const migration = await migrateOpenCodeConfig(paths);
  for (const legacyTuiPath of migration.legacyTuiPaths) {
    console.log(`Reported legacy TUI config (left unchanged): ${legacyTuiPath}`);
  }
  if (migration.action === "aborted") {
    const details = [...migration.unmappable, ...migration.reportOnly];
    throw new Error(
      `OpenCode config migration needs manual work before sync can continue:\n${details
        .map((detail) => `  - ${detail}`)
        .join("\n")}`,
    );
  }
  if (migration.action === "migrated") {
    console.log(
      `Migrated ${migration.path} to the native OpenCode 2.0.18 shape (backup: ${migration.backupPath})`,
    );
  }
  const opencode = await ensurePackageInstalled(paths);
  const cliPin = await ensureCliPackageInstalled(paths);
  const managedAgents = await syncManagedAgentRegistrations(paths);
  const managedPrompts = await syncManagedAgentPrompts(paths, { force: Boolean(args.force) });
  const managedSkills = await syncManagedSkillFiles(paths, { force: Boolean(args.force) });
  const vvocConfig = await syncVvocConfig(paths);

  console.log(`${opencode.changed ? "Updated" : "Kept"} ${opencode.path}`);
  console.log(`${cliPin.changed ? "Updated" : "Kept"} ${cliPin.path} (TUI client pin)`);
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
