// FILE: src/commands/status.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Show current vv-opencode installation status including the effective orchestration profile.
//   SCOPE: Read-scope parsing, layered source-aware inspection lookup, and human-readable OpenCode, vvoc, orchestration, role, and plugin diagnostics.
//   DEPENDS: [citty, src/lib/config-layers.ts, src/lib/opencode.ts]
//   LINKS: [M-CLI-COMMANDS, M-CLI-CONFIG, M-ORCHESTRATION-PROFILES]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Status command definition for vvoc installation reporting.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.6.0 - Printed vvoc config parse diagnostics during status without mutating invalid config files.]
//   LAST_CHANGE: [v0.5.0 - Added global/project/effective status scopes with selected source reporting.]
//   LAST_CHANGE: [v0.4.0 - Added canonical role inventory output and unresolved role-reference reporting sourced from installation inspection.]
//   LAST_CHANGE: [C-PRESET-ORCHESTRATION-PROFILES - Printed the profile resolved from the selected vvoc source.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import type { ConfigReadScope } from "../lib/config-layers.js";
import { inspectInstallationForScope } from "../lib/opencode.js";

export default defineCommand({
  meta: {
    name: "status",
    description: "Show vv-opencode installation status.",
  },
  args: {
    scope: {
      type: "enum",
      options: ["global", "project", "effective"],
      default: "effective",
      description: "Inspect global, project-local, or effective layered config.",
    },
    "config-dir": {
      type: "string",
      description: "Override the global config home used for opencode/ and vvoc/.",
    },
  },
  async run({ args }) {
    // START_BLOCK_PRINT_STATUS_REPORT
    const scope = resolveReadScope(args.scope);
    const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
    const inspection = await inspectInstallationForScope({ scope, cwd: process.cwd(), configDir });

    console.log(`Scope: ${inspection.scope}`);
    console.log(
      `OpenCode source: ${inspection.opencodeSource.kind}${inspection.opencodeSource.path ? ` ${inspection.opencodeSource.path}` : ""}`,
    );
    console.log(
      `vvoc source: ${inspection.vvocSource.kind}${inspection.vvocSource.path ? ` ${inspection.vvocSource.path}` : ""}`,
    );
    console.log(`Orchestration profile: ${inspection.orchestration.profile ?? "unknown"}`);
    console.log(`OpenCode config: ${inspection.opencode.path}`);
    console.log(`OpenCode config exists: ${inspection.opencode.exists ? "yes" : "no"}`);
    console.log(`Package configured: ${inspection.opencode.pluginConfigured ? "yes" : "no"}`);
    console.log(`vvoc config: ${inspection.vvoc.path}`);
    console.log(`vvoc config exists: ${inspection.vvoc.exists ? "yes" : "no"}`);
    console.log(
      `vvoc config parse: ${inspection.vvoc.parseError ? inspection.vvoc.parseError : inspection.vvoc.exists ? "ok" : "missing"}`,
    );
    console.log(`vvoc config version: ${inspection.vvoc.version ?? "missing"}`);
    console.log(
      `Guardian model: ${inspection.guardian.config ? (inspection.guardian.config.model ?? "default") : "unknown"}`,
    );
    console.log(
      `Secrets Redaction config: ${inspection.secretsRedaction.config ? "present" : "unknown"}`,
    );
    console.log("Roles:");
    if (inspection.roles.assignments.length === 0) {
      console.log("  <none>");
    } else {
      for (const role of inspection.roles.assignments) {
        console.log(`  ${role.roleId}: ${role.model}`);
      }
    }

    if (inspection.roles.unresolvedReferences.length > 0) {
      console.log("Unresolved role references:");
      for (const unresolved of inspection.roles.unresolvedReferences) {
        console.log(
          `- ${unresolved.fieldPath} -> ${unresolved.roleRef} (missing role: ${unresolved.roleId})`,
        );
      }
    }

    if (inspection.warnings.length > 0) {
      console.log("Warnings:");
      for (const warning of inspection.warnings) {
        console.log(`- ${warning}`);
      }
    }
    if (inspection.problems.length > 0) {
      console.log("Problems:");
      for (const problem of inspection.problems) {
        console.log(`- ${problem}`);
      }
    }
    // END_BLOCK_PRINT_STATUS_REPORT
  },
});

function resolveReadScope(value: unknown): ConfigReadScope {
  return value === "global" || value === "project" ? value : "effective";
}
