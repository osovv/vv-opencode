// FILE: src/commands/install.ts
// VERSION: 0.2.6
// START_MODULE_CONTRACT
//   PURPOSE: Install vv-opencode into OpenCode config and bootstrap vvoc-managed config files.
//   SCOPE: Scope parsing, path resolution, pinned plugin registration, managed subagent prompt scaffolding, and initial Guardian/Memory config creation.
//   DEPENDS: [citty, src/lib/opencode.ts]
//   LINKS: [M-CLI-COMMANDS, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Install command definition for plugin registration and vvoc config bootstrap.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.6 - Added managed subagent registration and prompt scaffolding to install.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import {
  describeWriteResult,
  ensurePackageInstalled,
  installGuardianConfig,
  installManagedSubagentPrompts,
  installMemoryConfig,
  installSecretsRedactionConfig,
  resolvePaths,
  syncManagedSubagentRegistrations,
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
      description: "Allow overwriting an existing guardian config when needed.",
    },
    "guardian-config": {
      type: "boolean",
      default: true,
      description: "Create guardian.jsonc when missing.",
    },
    "memory-config": {
      type: "boolean",
      default: true,
      description: "Create memory.jsonc when missing.",
    },
    "secrets-redaction-config": {
      type: "boolean",
      default: true,
      description: "Create secrets-redaction.config.json when missing.",
    },
  },
  async run({ args }) {
    // START_BLOCK_APPLY_INSTALL_COMMAND
    const scope = args.scope === "project" ? "project" : "global";
    const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
    const paths = await resolvePaths({
      scope: scope as Scope,
      cwd: process.cwd(),
      configDir,
    });
    const opencode = await ensurePackageInstalled(paths);
    const managedSubagents = await syncManagedSubagentRegistrations(paths);

    console.log(`${opencode.changed ? "Updated" : "Kept"} ${opencode.path}`);
    console.log(
      `${managedSubagents.changed ? "Updated" : "Kept"} ${managedSubagents.path} (managed subagents)`,
    );

    for (const result of await installManagedSubagentPrompts(paths, {
      force: Boolean(args.force),
    })) {
      console.log(describeWriteResult(result));
    }

    if (args["guardian-config"] === false) {
      console.log(`Skipped ${paths.guardianConfigPath} (guardian config disabled)`);
    } else {
      const guardian = await installGuardianConfig(paths, { force: Boolean(args.force) });
      console.log(describeWriteResult(guardian));
    }

    if (args["memory-config"] === false) {
      console.log(`Skipped ${paths.memoryConfigPath} (memory config disabled)`);
    } else {
      const memory = await installMemoryConfig(paths, { force: Boolean(args.force) });
      console.log(describeWriteResult(memory));
    }

    if (args["secrets-redaction-config"] === false) {
      console.log(
        `Skipped ${paths.secretsRedactionConfigPath} (secrets-redaction config disabled)`,
      );
    } else {
      const secretsRedaction = await installSecretsRedactionConfig(paths, {
        force: Boolean(args.force),
      });
      console.log(describeWriteResult(secretsRedaction));
    }
    // END_BLOCK_APPLY_INSTALL_COMMAND
  },
});
