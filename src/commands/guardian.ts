// FILE: src/commands/guardian.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Expose Guardian-specific vvoc CLI helpers backed by the canonical vvoc.json config file.
//   SCOPE: Guardian config command wiring plus CLI argument normalization for canonical global guardian section values.
//   DEPENDS: [citty, src/lib/opencode.ts]
//   LINKS: [M-CLI-COMMANDS, M-CLI-CONFIG, M-PLUGIN-GUARDIAN]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Guardian command group.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.4.0 - Removed scope/config-dir options from Guardian config writes.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import {
  describeWriteResult,
  renderGuardianConfig,
  resolvePaths,
  writeGuardianConfig,
  type GuardianConfigOverrides,
} from "../lib/opencode.js";

const config = defineCommand({
  meta: {
    name: "config",
    description: "Write or print the guardian section of vvoc.json.",
  },
  args: {
    print: {
      type: "boolean",
      description: "Print the config instead of writing it.",
    },
    model: {
      type: "string",
      description: "Override the Guardian model.",
    },
    variant: {
      type: "string",
      description: "Override the Guardian variant.",
    },
    "timeout-ms": {
      type: "string",
      description: "Timeout in milliseconds.",
    },
    "approval-risk-threshold": {
      type: "string",
      description: "Approval threshold from 0 to 100.",
    },
    "review-toast-duration-ms": {
      type: "string",
      description: "Toast duration in milliseconds.",
    },
  },
  async run({ args }) {
    // START_BLOCK_APPLY_GUARDIAN_CONFIG_COMMAND
    const overrides = readGuardianOverridesFromArgs(args);
    if (args.print) {
      process.stdout.write(renderGuardianConfig(overrides));
      return;
    }

    const paths = await resolvePaths();
    const result = await writeGuardianConfig(paths, overrides);

    console.log(describeWriteResult(result));
    // END_BLOCK_APPLY_GUARDIAN_CONFIG_COMMAND
  },
});

export default defineCommand({
  meta: {
    name: "guardian",
    description: "Guardian-specific helpers.",
  },
  subCommands: {
    config,
  },
});

function readGuardianOverridesFromArgs(args: Record<string, unknown>): GuardianConfigOverrides {
  // START_BLOCK_NORMALIZE_GUARDIAN_ARG_OVERRIDES
  const overrides: GuardianConfigOverrides = {};

  if (typeof args.model === "string" && args.model.trim()) {
    overrides.model = args.model.trim();
  }
  if (typeof args.variant === "string" && args.variant.trim()) {
    overrides.variant = args.variant.trim();
  }

  const timeoutMs = parsePositiveIntegerArg(args["timeout-ms"], "timeout-ms");
  if (timeoutMs !== undefined) {
    overrides.timeoutMs = timeoutMs;
  }

  const approvalRiskThreshold = parseThresholdArg(
    args["approval-risk-threshold"],
    "approval-risk-threshold",
  );
  if (approvalRiskThreshold !== undefined) {
    overrides.approvalRiskThreshold = approvalRiskThreshold;
  }

  const reviewToastDurationMs = parsePositiveIntegerArg(
    args["review-toast-duration-ms"],
    "review-toast-duration-ms",
  );
  if (reviewToastDurationMs !== undefined) {
    overrides.reviewToastDurationMs = reviewToastDurationMs;
  }

  // END_BLOCK_NORMALIZE_GUARDIAN_ARG_OVERRIDES
  return overrides;
}

function parsePositiveIntegerArg(value: unknown, label: string): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Math.round(parsed);
}

function parseThresholdArg(value: unknown, label: string): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a number`);
  }
  return Math.max(0, Math.min(100, Math.round(parsed)));
}
