// FILE: src/commands/doctor.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Diagnose vv-opencode installation problems and surface actionable failures.
//   SCOPE: Read-scope parsing, layered source-aware installation inspection, OpenCode host compatibility, warning/problem reporting, and non-zero exit signaling for OpenCode runtime/TUI plus vvoc config.
//   DEPENDS: [citty, src/lib/config-layers.ts, src/lib/opencode.ts]
//   LINKS: [M-CLI-COMMANDS, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Doctor command definition for vvoc installation diagnostics.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-007 - Diagnosed the exact supported OpenCode host window instead of a V1 TUI minimum.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import type { ConfigReadScope } from "../lib/config-layers.js";
import { inspectInstallationForScope } from "../lib/opencode.js";

export default defineCommand({
  meta: {
    name: "doctor",
    description: "Diagnose vv-opencode installation issues.",
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
    // START_BLOCK_PRINT_DIAGNOSTIC_REPORT
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
    console.log(`OpenCode version: ${inspection.runtime.version ?? "unavailable"}`);
    console.log(`OpenCode supported range: ${inspection.runtime.supportedRange}`);
    console.log(
      `OpenCode supported: ${inspection.runtime.versionSupported === undefined ? "unknown" : inspection.runtime.versionSupported ? "yes" : "no"}`,
    );
    console.log(`OpenCode config: ${inspection.opencode.path}`);
    console.log(
      `OpenCode config parse: ${inspection.opencode.parseError ? inspection.opencode.parseError : "ok"}`,
    );
    console.log(
      `Configured plugins: ${inspection.opencode.plugins.length > 0 ? inspection.opencode.plugins.map((entry) => (typeof entry === "string" ? entry : entry.package)).join(", ") : "<none>"}`,
    );
    console.log(`TUI package registered: ${inspection.tui.registered ? "yes" : "no"}`);
    console.log(`TUI capability note: ${inspection.tui.note}`);
    console.log(`vvoc config: ${inspection.vvoc.path}`);
    console.log(
      `vvoc config parse: ${inspection.vvoc.parseError ? inspection.vvoc.parseError : inspection.vvoc.exists ? "ok" : "missing"}`,
    );
    console.log(`vvoc schema: ${inspection.vvoc.schema ?? "missing"}`);
    console.log(`vvoc version: ${inspection.vvoc.version ?? "missing"}`);
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

    if (inspection.warnings.length > 0) {
      console.log("Warnings:");
      for (const warning of inspection.warnings) {
        console.log(`- ${warning}`);
      }
    }

    if (inspection.problems.length > 0) {
      console.error("Problems:");
      for (const problem of inspection.problems) {
        console.error(`- ${problem}`);
      }
      process.exitCode = 1;
      return;
    }

    console.log("Doctor: ok");
    // END_BLOCK_PRINT_DIAGNOSTIC_REPORT
  },
});

function resolveReadScope(value: unknown): ConfigReadScope {
  return value === "global" || value === "project" ? value : "effective";
}
