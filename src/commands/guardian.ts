import { defineCommand } from "citty";
import {
  describeWriteResult,
  renderGuardianConfig,
  resolvePaths,
  writeGuardianConfig,
  type GuardianConfigOverrides,
  type Scope,
} from "../lib/opencode.js";

const config = defineCommand({
  meta: {
    name: "config",
    description: "Write or print guardian.jsonc.",
  },
  args: {
    scope: {
      type: "enum",
      options: ["global", "project"],
      default: "global",
      description: "Write global or project Guardian config.",
    },
    "config-dir": {
      type: "string",
      description: "Override the global OpenCode config directory.",
    },
    force: {
      type: "boolean",
      description: "Allow overwriting an unmanaged guardian config.",
    },
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
    const overrides = readGuardianOverridesFromArgs(args);
    if (args.print) {
      process.stdout.write(renderGuardianConfig(overrides));
      return;
    }

    const scope = args.scope === "project" ? "project" : "global";
    const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
    const paths = await resolvePaths({
      scope: scope as Scope,
      cwd: process.cwd(),
      configDir,
    });
    const result = await writeGuardianConfig(paths, overrides, { force: Boolean(args.force) });

    console.log(describeWriteResult(result));
    if (result.action === "skipped") {
      process.exitCode = 1;
    }
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
