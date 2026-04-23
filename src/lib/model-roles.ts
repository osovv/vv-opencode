// FILE: src/lib/model-roles.ts
// VERSION: 0.1.2
// START_MODULE_CONTRACT
//   PURPOSE: Define built-in role IDs, role-reference parsing, concrete model-selection parsing, and deterministic built-in role bindings.
//   SCOPE: Role ID validation, vv-role reference detection/resolution, provider/model parsing, and hard-coded built-in role binding lookup.
//   INPUTS: roleId | roleRef | modelSelection strings and a canonical role map.
//   OUTPUTS: Normalized role IDs plus parsed and resolved model-selection objects.
//   DEPENDS: [none]
//   LINKS: [M-MODEL-ROLES]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   BUILTIN_ROLE_NAMES - Built-in role IDs in deterministic order.
//   ROLE_REFERENCE_PREFIX - Stable role-reference prefix.
//   isRoleReference - Checks whether a value is a vv-role reference.
//   parseModelSelection - Parses provider/model into normalized parts.
//   resolveRoleReference - Resolves vv-role references through a canonical role map.
//   getBuiltInRoleBindings - Returns hard-coded role bindings for OpenCode defaults and bundled agents.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.3 - Removed variant splitting from model selection parsing so provider/model:free passes through unchanged.]
//   LAST_CHANGE: [v0.1.2 - Renamed tracked managed-agent role binding keys to vv-* names for implementer/spec/code reviewer roles.]
//   LAST_CHANGE: [v0.1.1 - Distinguished unknown-role from blank configured role bindings and aligned role-reference whitespace handling between checker and resolver.]
//   LAST_CHANGE: [v0.1.0 - Added role ID validation, role reference resolution helpers, model selection parsing, and deterministic built-in role bindings.]
// END_CHANGE_SUMMARY

export const BUILTIN_ROLE_NAMES = ["default", "smart", "fast", "vision"] as const;
export type BuiltInRoleName = (typeof BUILTIN_ROLE_NAMES)[number];

export const ROLE_REFERENCE_PREFIX = "vv-role:";

export type ModelRolesErrorCode =
  | "INVALID_ROLE_ID"
  | "INVALID_ROLE_REFERENCE"
  | "INVALID_MODEL_SELECTION"
  | "UNKNOWN_ROLE";

export type ModelRolesError = Error & {
  code: ModelRolesErrorCode;
  field: "roleId" | "roleRef" | "modelSelection";
  value: string;
};

export type ParsedModelSelection = {
  provider: string;
  model: string;
  normalized: string;
};

export type ResolvedRoleSelection = ParsedModelSelection & {
  roleId: string;
  roleRef: string;
};

export type BuiltInRoleBindings = {
  opencodeDefaults: {
    model: BuiltInRoleName;
    smallModel: BuiltInRoleName;
  };
  opencodeAgents: {
    build: BuiltInRoleName;
    plan: BuiltInRoleName;
    general: BuiltInRoleName;
    explore: BuiltInRoleName;
  };
  managedAgents: {
    guardian: BuiltInRoleName;
    "memory-reviewer": BuiltInRoleName;
    enhancer: BuiltInRoleName;
    "vv-implementer": BuiltInRoleName;
    "vv-spec-reviewer": BuiltInRoleName;
    "vv-code-reviewer": BuiltInRoleName;
    investitagor: BuiltInRoleName;
  };
};

const ROLE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const MODEL_SELECTION_PATTERN = /^([^\s/]+)\/([^\s]+)$/;

const BUILTIN_ROLE_BINDINGS: BuiltInRoleBindings = {
  opencodeDefaults: {
    model: "default",
    smallModel: "fast",
  },
  opencodeAgents: {
    build: "smart",
    plan: "smart",
    general: "default",
    explore: "fast",
  },
  managedAgents: {
    guardian: "fast",
    "memory-reviewer": "fast",
    enhancer: "smart",
    "vv-implementer": "default",
    "vv-spec-reviewer": "smart",
    "vv-code-reviewer": "smart",
    investitagor: "smart",
  },
};

// START_CONTRACT: isRoleReference
//   PURPOSE: Check whether a model-like value is a vv-role:* reference.
//   INPUTS: { value: string - Candidate model-like string. }
//   OUTPUTS: { boolean - True only when the value starts with the vv-role prefix and has a non-empty suffix. }
//   SIDE_EFFECTS: none
//   LINKS: [fn-isRoleReference, fn-resolveRoleReference]
// END_CONTRACT: isRoleReference
export function isRoleReference(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith(ROLE_REFERENCE_PREFIX) && trimmed.length > ROLE_REFERENCE_PREFIX.length;
}

// START_CONTRACT: parseModelSelection
//   PURPOSE: Parse provider/model syntax into normalized model-selection parts.
//   INPUTS: { modelSelection: string - Concrete model-selection input. }
//   OUTPUTS: { ParsedModelSelection - Normalized provider/model values. }
//   SIDE_EFFECTS: none
//   LINKS: [fn-parseModelSelection]
// END_CONTRACT: parseModelSelection
export function parseModelSelection(modelSelection: string): ParsedModelSelection {
  const trimmed = modelSelection.trim();
  const match = MODEL_SELECTION_PATTERN.exec(trimmed);

  if (!match) {
    throw createModelRolesError(
      "INVALID_MODEL_SELECTION",
      "modelSelection",
      modelSelection,
      "expected provider/model",
    );
  }

  const [, provider, model] = match;
  const normalized = `${provider}/${model}`;
  return { provider, model, normalized };
}

// START_CONTRACT: resolveRoleReference
//   PURPOSE: Resolve a vv-role:* reference to a concrete provider/model selection.
//   INPUTS: { roleRef: string - vv-role reference, roleMap: Record<string, string> - canonical role assignments. }
//   OUTPUTS: { ResolvedRoleSelection - Parsed concrete model selection plus normalized role information. }
//   SIDE_EFFECTS: none
//   LINKS: [fn-resolveRoleReference, fn-parseModelSelection]
// END_CONTRACT: resolveRoleReference
//   SIDE_EFFECTS: none
//   LINKS: [fn-resolveRoleReference, fn-parseModelSelection]
// END_CONTRACT: resolveRoleReference
export function resolveRoleReference(
  roleRef: string,
  roleMap: Record<string, string>,
): ResolvedRoleSelection {
  // START_BLOCK_RESOLVE_ROLE_REFERENCE
  const roleId = parseRoleReference(roleRef);
  if (!Object.hasOwn(roleMap, roleId)) {
    throw createModelRolesError("UNKNOWN_ROLE", "roleRef", roleRef, `unknown role: ${roleId}`);
  }

  const rawModelSelection = roleMap[roleId];

  if (typeof rawModelSelection !== "string" || !rawModelSelection.trim()) {
    throw createModelRolesError(
      "INVALID_MODEL_SELECTION",
      "modelSelection",
      typeof rawModelSelection === "string" ? rawModelSelection : String(rawModelSelection),
      `configured role binding is blank or invalid for role: ${roleId}`,
    );
  }

  if (isRoleReference(rawModelSelection.trim())) {
    throw createModelRolesError(
      "INVALID_MODEL_SELECTION",
      "modelSelection",
      rawModelSelection,
      "role-to-role chaining is not allowed",
    );
  }

  const parsed = parseModelSelection(rawModelSelection);
  return {
    roleId,
    roleRef: `${ROLE_REFERENCE_PREFIX}${roleId}`,
    ...parsed,
  };
  // END_BLOCK_RESOLVE_ROLE_REFERENCE
}

// START_CONTRACT: getBuiltInRoleBindings
//   PURPOSE: Return deterministic built-in role bindings used by OpenCode defaults and bundled agents.
//   INPUTS: {}
//   OUTPUTS: { BuiltInRoleBindings - Immutable hard-coded role bindings. }
//   SIDE_EFFECTS: none
//   LINKS: [fn-getBuiltInRoleBindings, const-BUILTIN_ROLE_NAMES]
// END_CONTRACT: getBuiltInRoleBindings
export function getBuiltInRoleBindings(): BuiltInRoleBindings {
  return {
    opencodeDefaults: { ...BUILTIN_ROLE_BINDINGS.opencodeDefaults },
    opencodeAgents: { ...BUILTIN_ROLE_BINDINGS.opencodeAgents },
    managedAgents: { ...BUILTIN_ROLE_BINDINGS.managedAgents },
  };
}

function parseRoleReference(roleRef: string): string {
  const trimmed = roleRef.trim();

  if (!isRoleReference(trimmed)) {
    throw createModelRolesError(
      "INVALID_ROLE_REFERENCE",
      "roleRef",
      roleRef,
      `expected ${ROLE_REFERENCE_PREFIX}<role-id>`,
    );
  }

  const roleId = trimmed.slice(ROLE_REFERENCE_PREFIX.length);
  return normalizeRoleId(roleId);
}

function normalizeRoleId(roleId: string): string {
  const normalized = roleId.trim();
  if (!ROLE_ID_PATTERN.test(normalized)) {
    throw createModelRolesError(
      "INVALID_ROLE_ID",
      "roleId",
      roleId,
      "expected lowercase letters, digits, and hyphens",
    );
  }
  return normalized;
}

function createModelRolesError(
  code: ModelRolesErrorCode,
  field: "roleId" | "roleRef" | "modelSelection",
  value: string,
  detail: string,
): ModelRolesError {
  const error = new Error(`${code}: ${field} ${detail} (received: ${value})`) as ModelRolesError;
  error.code = code;
  error.field = field;
  error.value = value;
  return error;
}
