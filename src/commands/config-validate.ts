// FILE: src/commands/config-validate.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Validate guardian.jsonc and memory.jsonc configuration files with human-readable error reporting.
//   SCOPE: Scope parsing, file discovery, JSONC parse error reporting, schema field validation, and pass/fail terminal output.
//   DEPENDS: [citty, src/lib/opencode.js, src/lib/vvoc-paths.js]
//   LINKS: [M-CLI-CONFIG-VALIDATE, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - ConfigValidate command definition for vvoc.
//   validateGuardianConfig - Validate guardian.jsonc and report schema violations.
//   validateMemoryConfig - Validate memory.jsonc and report schema violations.
//   ConfigValidateResult - Outcome of a single config file validation.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.4.0 - Initial GRACE implementation for config validation commands.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { parse, type ParseError } from "jsonc-parser";
import { resolvePaths, type Scope } from "../lib/opencode.js";

type ConfigValidateResult = {
  path: string;
  valid: boolean;
  errors: string[];
};

const GUARDIAN_REQUIRED_FIELDS: Record<string, string> = {
  timeoutMs: "number",
  approvalRiskThreshold: "number",
};

const GUARDIAN_OPTIONAL_FIELDS: Record<string, string> = {
  model: "string",
  variant: "string",
  reviewToastDurationMs: "number",
};

const MEMORY_REQUIRED_FIELDS: Record<string, string> = {
  enabled: "boolean",
};

const MEMORY_OPTIONAL_FIELDS: Record<string, string> = {
  defaultSearchLimit: "number",
  reviewerModel: "string",
  reviewerVariant: "string",
};

export type { ConfigValidateResult };

export default defineCommand({
  meta: {
    name: "validate",
    description: "Validate guardian.jsonc and memory.jsonc configuration files.",
  },
  args: {
    scope: {
      type: "enum",
      options: ["global", "project", "all"],
      default: "all",
      description: "Validate global, project, or all config files.",
    },
    "config-dir": {
      type: "string",
      description: "Override the global config home used for vvoc/",
    },
    "guardian-only": {
      type: "boolean",
      default: false,
      description: "Only validate guardian.jsonc.",
    },
    "memory-only": {
      type: "boolean",
      default: false,
      description: "Only validate memory.jsonc.",
    },
  },
  async run({ args }) {
    // START_BLOCK_RUN_VALIDATE
    const scope =
      args.scope === "project" ? "project" : args.scope === "global" ? "global" : undefined;
    const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
    const guardianOnly = args["guardian-only"] === true;
    const memoryOnly = args["memory-only"] === true;
    const cwd = process.cwd();

    let exitCode = 0;

    if (!guardianOnly && !memoryOnly) {
      if (scope !== undefined) {
        const guardianResult = await validateGuardianConfig(scope as Scope, cwd, configDir);
        printResult(guardianResult);
        if (!guardianResult.valid) exitCode = 1;

        const memoryResult = await validateMemoryConfig(scope as Scope, cwd, configDir);
        printResult(memoryResult);
        if (!memoryResult.valid) exitCode = 1;
      } else {
        const globalGuardian = await validateGuardianConfig("global", cwd, configDir);
        printResult(globalGuardian);
        if (!globalGuardian.valid) exitCode = 1;

        const globalMemory = await validateMemoryConfig("global", cwd, configDir);
        printResult(globalMemory);
        if (!globalMemory.valid) exitCode = 1;

        const projectGuardian = await validateGuardianConfig("project", cwd, configDir);
        printResult(projectGuardian);
        if (!projectGuardian.valid) exitCode = 1;

        const projectMemory = await validateMemoryConfig("project", cwd, configDir);
        printResult(projectMemory);
        if (!projectMemory.valid) exitCode = 1;
      }
    } else {
      if (!guardianOnly) {
        if (scope !== undefined) {
          const guardianResult = await validateGuardianConfig(scope as Scope, cwd, configDir);
          printResult(guardianResult);
          if (!guardianResult.valid) exitCode = 1;
        } else {
          const globalGuardian = await validateGuardianConfig("global", cwd, configDir);
          printResult(globalGuardian);
          if (!globalGuardian.valid) exitCode = 1;

          const projectGuardian = await validateGuardianConfig("project", cwd, configDir);
          printResult(projectGuardian);
          if (!projectGuardian.valid) exitCode = 1;
        }
      }

      if (!memoryOnly) {
        if (scope !== undefined) {
          const memoryResult = await validateMemoryConfig(scope as Scope, cwd, configDir);
          printResult(memoryResult);
          if (!memoryResult.valid) exitCode = 1;
        } else {
          const globalMemory = await validateMemoryConfig("global", cwd, configDir);
          printResult(globalMemory);
          if (!globalMemory.valid) exitCode = 1;

          const projectMemory = await validateMemoryConfig("project", cwd, configDir);
          printResult(projectMemory);
          if (!projectMemory.valid) exitCode = 1;
        }
      }
    }

    process.exitCode = exitCode;
    // END_BLOCK_RUN_VALIDATE
  },
});

export async function validateGuardianConfig(
  scope: Scope,
  cwd: string,
  configDir?: string,
): Promise<ConfigValidateResult> {
  const paths = await resolvePaths({ scope, cwd, configDir });
  return validateGuardianConfigFile(paths.guardianConfigPath);
}

export async function validateMemoryConfig(
  scope: Scope,
  cwd: string,
  configDir?: string,
): Promise<ConfigValidateResult> {
  const paths = await resolvePaths({ scope, cwd, configDir });
  return validateMemoryConfigFile(paths.memoryConfigPath);
}

export function validateGuardianConfigContent(
  content: string,
  filePath: string,
): ConfigValidateResult {
  const errors: string[] = [];

  const parseErrors: ParseError[] = [];
  const parsed = parse(content, parseErrors, {
    allowEmptyContent: true,
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (parseErrors.length > 0) {
    for (const err of parseErrors) {
      const lineCol = offsetToLineCol(content, err.offset);
      errors.push(`${filePath}:${lineCol.line}:${lineCol.col} - invalid JSONC (${err.error})`);
    }
    return { path: filePath, valid: false, errors };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    errors.push(`${filePath} - expected a top-level object`);
    return { path: filePath, valid: false, errors };
  }

  for (const [field, expectedType] of Object.entries(GUARDIAN_REQUIRED_FIELDS)) {
    if (!Object.hasOwn(parsed, field)) {
      errors.push(`${filePath} - missing required field "${field}" (expected ${expectedType})`);
    } else {
      const actual = typeof parsed[field];
      if (actual !== expectedType) {
        errors.push(
          `${filePath} - field "${field}" has type "${actual}" but expected "${expectedType}"`,
        );
      }
    }
  }

  for (const [field, expectedType] of Object.entries(GUARDIAN_OPTIONAL_FIELDS)) {
    if (Object.hasOwn(parsed, field)) {
      const actual = typeof parsed[field];
      if (actual !== expectedType) {
        errors.push(
          `${filePath} - optional field "${field}" has type "${actual}" but expected "${expectedType}"`,
        );
      }
    }
  }

  if (Object.hasOwn(parsed, "timeoutMs")) {
    const val = parsed.timeoutMs as number;
    if (typeof val === "number" && (val <= 0 || !Number.isFinite(val))) {
      errors.push(`${filePath} - "timeoutMs" must be a positive number`);
    }
  }

  if (Object.hasOwn(parsed, "approvalRiskThreshold")) {
    const val = parsed.approvalRiskThreshold as number;
    if (typeof val === "number" && (val < 0 || val > 100 || !Number.isFinite(val))) {
      errors.push(`${filePath} - "approvalRiskThreshold" must be a number between 0 and 100`);
    }
  }

  if (Object.hasOwn(parsed, "reviewToastDurationMs")) {
    const val = parsed.reviewToastDurationMs as number;
    if (typeof val === "number" && (val <= 0 || !Number.isFinite(val))) {
      errors.push(`${filePath} - "reviewToastDurationMs" must be a positive number`);
    }
  }

  return { path: filePath, valid: errors.length === 0, errors };
}

export function validateGuardianConfigFile(filePath: string): ConfigValidateResult {
  return validateGuardianConfigContent(readFileOrEmpty(filePath), filePath);
}

export function validateMemoryConfigContent(
  content: string,
  filePath: string,
): ConfigValidateResult {
  const errors: string[] = [];

  const parseErrors: ParseError[] = [];
  const parsed = parse(content, parseErrors, {
    allowEmptyContent: true,
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (parseErrors.length > 0) {
    for (const err of parseErrors) {
      const lineCol = offsetToLineCol(content, err.offset);
      errors.push(`${filePath}:${lineCol.line}:${lineCol.col} - invalid JSONC (${err.error})`);
    }
    return { path: filePath, valid: false, errors };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    errors.push(`${filePath} - expected a top-level object`);
    return { path: filePath, valid: false, errors };
  }

  for (const [field, expectedType] of Object.entries(MEMORY_REQUIRED_FIELDS)) {
    if (!Object.hasOwn(parsed, field)) {
      errors.push(`${filePath} - missing required field "${field}" (expected ${expectedType})`);
    } else {
      const actual = typeof parsed[field];
      if (actual !== expectedType) {
        errors.push(
          `${filePath} - field "${field}" has type "${actual}" but expected "${expectedType}"`,
        );
      }
    }
  }

  for (const [field, expectedType] of Object.entries(MEMORY_OPTIONAL_FIELDS)) {
    if (Object.hasOwn(parsed, field)) {
      const actual = typeof parsed[field];
      if (actual !== expectedType) {
        errors.push(
          `${filePath} - optional field "${field}" has type "${actual}" but expected "${expectedType}"`,
        );
      }
    }
  }

  if (Object.hasOwn(parsed, "defaultSearchLimit")) {
    const val = parsed.defaultSearchLimit as number;
    if (typeof val === "number" && (val <= 0 || !Number.isInteger(val))) {
      errors.push(`${filePath} - "defaultSearchLimit" must be a positive integer`);
    }
  }

  return { path: filePath, valid: errors.length === 0, errors };
}

export function validateMemoryConfigFile(filePath: string): ConfigValidateResult {
  return validateMemoryConfigContent(readFileOrEmpty(filePath), filePath);
}

function printResult(result: ConfigValidateResult): void {
  if (result.valid) {
    console.log(`${result.path}: OK`);
  } else {
    for (const error of result.errors) {
      console.error(error);
    }
  }
}

function readFileOrEmpty(path: string): string {
  try {
    const { readFileSync } = require("node:fs");
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function offsetToLineCol(content: string, offset: number): { line: number; col: number } {
  const lines = content.split("\n");
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineLen = lines[i].length + 1;
    if (pos + lineLen > offset) {
      return { line: i + 1, col: offset - pos + 1 };
    }
    pos += lineLen;
  }
  return { line: lines.length, col: 1 };
}
