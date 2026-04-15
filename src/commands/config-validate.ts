// FILE: src/commands/config-validate.ts
// VERSION: 0.6.0
// START_MODULE_CONTRACT
//   PURPOSE: Validate the canonical vvoc.json configuration file with human-readable error reporting.
//   SCOPE: Canonical vvoc config file discovery, strict JSON parse error reporting, JSON Schema validation, and pass/fail terminal output.
//   DEPENDS: [citty, jsonc-parser, src/lib/opencode.js, src/lib/vvoc-config.ts]
//   LINKS: [M-CLI-CONFIG-VALIDATE, M-CLI-CONFIG]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - ConfigValidate command definition for vvoc.
//   validateVvocConfig - Validate the canonical vvoc.json file for the selected config root.
//   validateVvocConfigContent - Validate vvoc.json content and report schema violations.
//   validateVvocConfigFile - Validate a vvoc.json file path and report schema violations.
//   ConfigValidateResult - Outcome of a canonical vvoc config validation run.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.6.0 - Added explicit unsupported-version reporting and path-aware semantic role assignment validation for roles/presets.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { parse, type ParseError } from "jsonc-parser";
import { readFileSync } from "node:fs";
import { resolvePaths } from "../lib/opencode.js";
import { parseModelSelection } from "../lib/model-roles.js";
import { VVOC_CONFIG_VERSION, validateVvocConfigDocument } from "../lib/vvoc-config.js";

type ConfigValidateResult = {
  path: string;
  valid: boolean;
  errors: string[];
};

export type { ConfigValidateResult };

export default defineCommand({
  meta: {
    name: "validate",
    description: "Validate the canonical vvoc.json configuration file.",
  },
  args: {
    "config-dir": {
      type: "string",
      description: "Override the global config home used for vvoc/.",
    },
  },
  async run({ args }) {
    // START_BLOCK_RUN_VALIDATE
    const configDir = typeof args["config-dir"] === "string" ? args["config-dir"] : undefined;
    const result = await validateVvocConfig(process.cwd(), configDir);

    printResult(result);
    process.exitCode = result.valid ? 0 : 1;
    // END_BLOCK_RUN_VALIDATE
  },
});

export async function validateVvocConfig(
  cwd: string,
  configDir?: string,
): Promise<ConfigValidateResult> {
  const paths = await resolvePaths({ scope: "global", cwd, configDir });
  return validateVvocConfigFile(paths.vvocConfigPath);
}

export function validateVvocConfigContent(content: string, filePath: string): ConfigValidateResult {
  const errors: string[] = [];
  const parseErrors: ParseError[] = [];
  const parsed = parse(content, parseErrors, {
    allowEmptyContent: false,
    allowTrailingComma: false,
    disallowComments: true,
  });

  if (parseErrors.length > 0) {
    for (const err of parseErrors) {
      const lineCol = offsetToLineCol(content, err.offset);
      errors.push(`${filePath}:${lineCol.line}:${lineCol.col} - invalid JSON (${err.error})`);
    }
    return { path: filePath, valid: false, errors };
  }

  const schemaErrors = validateVvocConfigDocument(parsed).map(
    (message) => `${filePath} - ${message}`,
  );
  const unsupportedVersionErrors = collectUnsupportedVersionErrors(parsed).map(
    (message) => `${filePath} - ${message}`,
  );
  const roleAssignmentErrors = collectRoleAssignmentErrors(parsed).map(
    (message) => `${filePath} - ${message}`,
  );
  const allErrors = [...schemaErrors, ...unsupportedVersionErrors, ...roleAssignmentErrors];

  return {
    path: filePath,
    valid: allErrors.length === 0,
    errors: [...new Set(allErrors)],
  };
}

export function validateVvocConfigFile(filePath: string): ConfigValidateResult {
  return validateVvocConfigContent(readFileOrEmpty(filePath), filePath);
}

function printResult(result: ConfigValidateResult): void {
  if (result.valid) {
    console.log(`OK ${result.path}`);
    return;
  }

  console.error(`INVALID ${result.path}`);
  for (const error of result.errors) {
    console.error(`- ${error}`);
  }
}

function offsetToLineCol(text: string, offset: number): { line: number; col: number } {
  let line = 1;
  let col = 1;

  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      col = 1;
      continue;
    }
    col += 1;
  }

  return { line, col };
}

function readFileOrEmpty(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function collectUnsupportedVersionErrors(document: unknown): string[] {
  if (!isObjectRecord(document) || !Object.hasOwn(document, "version")) {
    return [];
  }

  const version = document.version;
  if (version === VVOC_CONFIG_VERSION) {
    return [];
  }

  const formattedVersion = typeof version === "number" ? String(version) : JSON.stringify(version);
  return [
    `/version unsupported-version: expected ${VVOC_CONFIG_VERSION} but received ${formattedVersion}`,
  ];
}

function collectRoleAssignmentErrors(document: unknown): string[] {
  if (!isObjectRecord(document)) {
    return [];
  }

  const errors: string[] = [];
  collectRoleAssignmentMapErrors(document.roles, "/roles", errors);

  if (!isObjectRecord(document.presets)) {
    return errors;
  }

  for (const [presetName, presetValue] of Object.entries(document.presets)) {
    if (!isObjectRecord(presetValue)) {
      continue;
    }
    collectRoleAssignmentMapErrors(presetValue.agents, `/presets/${presetName}/agents`, errors);
  }

  return errors;
}

function collectRoleAssignmentMapErrors(value: unknown, basePath: string, errors: string[]): void {
  if (!isObjectRecord(value)) {
    return;
  }

  for (const [roleId, modelSelection] of Object.entries(value)) {
    if (typeof modelSelection !== "string") {
      continue;
    }

    try {
      parseModelSelection(modelSelection);
    } catch (error) {
      errors.push(
        `${basePath}/${roleId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
