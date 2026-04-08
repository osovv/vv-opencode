// FILE: src/commands/status.ts
// VERSION: 0.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Show the current vv-opencode installation status.
//   SCOPE: Scope parsing, inspection lookup, and human-readable status output for OpenCode and the canonical vvoc.json config.
//   DEPENDS: [citty, src/lib/opencode.ts]
//   LINKS: [M-CLI-COMMANDS, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Status command definition for vvoc installation reporting.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.3.0 - Updated status reporting for the canonical vvoc.json config file.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { inspectInstallation, resolvePaths, type Scope } from "../lib/opencode.js";

export default defineCommand({
  meta: {
    name: "status",
    description: "Show vv-opencode installation status.",
  },
  args: {
    scope: {
      type: "enum",
      options: ["global", "project"],
      default: "global",
      description: "Inspect global or project config.",
    },
    "config-dir": {
      type: "string",
      description: "Override the global config home used for opencode/ and vvoc/.",
    },
  },
  async run({ args }) {
    // START_BLOCK_PRINT_STATUS_REPORT
    const scope = args.scope === "project" ? "project" : "global";
    const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
    const paths = await resolvePaths({
      scope: scope as Scope,
      cwd: process.cwd(),
      configDir,
    });
    const inspection = await inspectInstallation(paths);

    console.log(`Scope: ${inspection.scope}`);
    console.log(`OpenCode config: ${inspection.opencode.path}`);
    console.log(`OpenCode config exists: ${inspection.opencode.exists ? "yes" : "no"}`);
    console.log(`Package configured: ${inspection.opencode.pluginConfigured ? "yes" : "no"}`);
    console.log(`vvoc config: ${inspection.vvoc.path}`);
    console.log(`vvoc config exists: ${inspection.vvoc.exists ? "yes" : "no"}`);
    console.log(`vvoc config version: ${inspection.vvoc.version ?? "missing"}`);
    console.log(
      `Guardian model: ${inspection.guardian.config ? (inspection.guardian.config.model ?? "default") : "unknown"}`,
    );
    console.log(
      `Memory enabled: ${inspection.memory.config ? (inspection.memory.config.enabled ? "yes" : "no") : "unknown"}`,
    );
    console.log(
      `Secrets Redaction enabled: ${inspection.secretsRedaction.config ? (inspection.secretsRedaction.config.enabled ? "yes" : "no") : "unknown"}`,
    );

    if (inspection.warnings.length > 0) {
      console.log("Warnings:");
      for (const warning of inspection.warnings) {
        console.log(`- ${warning}`);
      }
    }
    // END_BLOCK_PRINT_STATUS_REPORT
  },
});
