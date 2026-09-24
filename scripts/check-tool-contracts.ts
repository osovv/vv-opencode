#!/usr/bin/env bun
// FILE: scripts/check-tool-contracts.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Read-only completeness gate for the nine-tool agent-tool catalog: an independent AST census of owned tool registrations across src/plugins and public plugin entry points, comparison of catalog vocabularies against the actual registered schemas and dispatcher branch literals, execution of every catalog fixture through the real validators/result schemas, default and negative-coverage checks, closed-input checks, and generated-reference currency. Also generates the reference (--generate) and verifies the built package assets (--packed).
//   SCOPE: Pure checker logic over injectable source maps, catalog entries, and reference text, plus a disk-backed runner. No plugin factory import, no store/network/filesystem mutation beyond writing the generated reference in --generate mode. It never treats the catalog as the source of truth for the actual schema vocabularies or dispatch branches and never silently excludes an unclassified dynamic owned registration.
//   DEPENDS: [typescript, node:fs, node:path, src/lib/agent-tool-catalog.ts, src/lib/agent-tool-contract.ts, src/plugins/workflow/input-validation.ts, src/plugins/workflow/schemas.ts, src/plugins/hashline-edit/schemas.ts, src/plugins/web-tools/schemas.ts, src/lib/workflow-contract.ts]
//   LINKS: [M-AGENT-TOOL-CONTRACT, V-M-AGENT-TOOL-CONTRACT]
//   ROLE: SCRIPT
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SourceFile - Repo-relative source path plus its text.
//   RegistrationCensus - Owned-tool registration census with dynamic-registration diagnostics.
//   DispatchBranchProbe - Declared dispatcher branch source for one discriminated field.
//   VocabularyReader - Independent reader of actual registered-schema vocabulary values.
//   ToolContractCheckResult - Check outcome with bounded failure rows and a summary.
//   DISPATCH_BRANCH_PROBES - Dispatcher sources compared against declared vocabularies.
//   staticPropertyName - Static property name of an AST property name node, if any.
//   isToolProperty - Whether a property assignment names the `tool` registration member.
//   collectToolMapKeys - Collect literal keys of one `tool` registration map; flag dynamic entries.
//   isFactoryCandidate - Whether a node could be a plugin factory body.
//   skipParentheses - Unwrap a parenthesized expression.
//   collectReturnedObjects - Object literals returned by a factory, excluding nested functions.
//   isPluginFactoryDeclaration - Whether a declaration names the host Plugin factory contract.
//   findLocalFactory - Resolve a local factory declaration referenced by a default export alias.
//   extractToolRegistrations - Independent census of `tool` registration maps in source.
//   compareRegistrationCensus - Census/dynamic/catalog agreement failures.
//   compareDescriptorCoverage - Catalog/descriptor contract agreement failures.
//   vocabularyValues - Declared vocabulary values for one `toolId.field` vocabulary key.
//   compareCatalogVocabularies - Declared vs actual vocabulary agreement failures.
//   collectMemberLiterals - String literals dispatched on one member name.
//   checkDispatchBranches - Undeclared dispatch-branch failures.
//   validateCatalogOperations - Positive/negative fixture agreement failures.
//   collectParsedValues - String values a fixture actually carries at a vocabulary path.
//   normalizeCoveragePath - Normalize a bracketed issue path so `edits[0].op` matches `edits[].op`.
//   checkNegativeCoverage - Missing field-targeted negative-scenario failures.
//   checkVocabularyDeclarations - Registered vocabularies missing from the catalog.
//   STRUCTURAL_DISCRIMINATOR_PATHS - Non-vocabulary operation-family discriminator paths.
//   resolveJsonPath - Resolve a dotted/bracketed fixture path to candidate values.
//   discriminatorToken - Normalized token for one discriminator value.
//   discriminatorTokens - Sorted unique tokens for a discriminator path.
//   branchKeyFor - Stable branch key for a parsed fixture from its discriminators.
//   checkBranchNegatives - Missing per-operation/branch validated negative fixtures.
//   validateCatalogResults - Result fixture/nested-branch coverage failures.
//   checkCatalogDefaults - Declared-default application failures.
//   checkClosedInputs - Open/empty/unresolved known-object failures.
//   referenceCurrencyFailure - Generated-reference drift failure.
//   checkOperationCoverage - Vocabulary values covered by validated positive fixtures.
//   unwrapZod - Unwrap a Zod wrapper chain to its object shape.
//   enumOptions - Literal enum options of a Zod schema.
//   registeredSourceKinds - Execution source kinds registered in the workflow schemas.
//   RUNTIME_VOCABULARY_READERS - Independent readers of registered-schema vocabulary values.
//   registeredVocabularyKeys - Registered-schema vocabulary keys.
//   buildRuntimeVocabularyReader - Independent reader of registered-schema vocabularies.
//   descriptorToolIds - Actual owned tool ids reported by the descriptor contract modules.
//   toPosix - Normalize path separators to POSIX.
//   exportTarget - Import/default/require/types target string from a package export value.
//   distTargetToSource - Map a built dist target path to its TypeScript source path.
//   resolvePluginEntryPoints - Map package export values to actual source entry files.
//   loadPluginSources - Discover plugin sources via the tree, barrels, and package exports.
//   runToolContractCheck - Full read-only check over injectable inputs.
//   generateReference - Write the generated reference document.
//   runPackedChecks - Verify built package assets and identity.
//   printResult - Print the bounded check summary and failures.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-008 correction r2 - Added checkBranchNegatives: every validated positive operation family (vocabulary values plus structural delete/rename/open/includeClosed paths) must carry a reject fixture that retains its real discriminator and fails another condition; branch association is derived from parsed positives and raw rejected inputs, not catalog labels. Also descends array-element result unions with boolean/number literal discriminators. Prior: independent registration census, vocabulary/dispatch/default/result gate, generated-reference currency, --generate/--packed.]
// END_CHANGE_SUMMARY

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import {
  CONTRACT_REFERENCE_PACKAGE_PATH,
  agentToolCatalog,
  findOpaqueInputObjects,
  renderToolContractsReference,
  resultBranchGaps,
  type AgentToolCatalogEntry,
} from "../src/lib/agent-tool-catalog.ts";
import {
  AGENT_TOOL_CONTRACT_REVISION,
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from "../src/lib/agent-tool-contract.ts";
import { WORK_ITEM_MODES } from "../src/lib/workflow-contract.ts";
import { workflowToolContracts } from "../src/plugins/workflow/input-validation.ts";
import {
  workCheckpointArgs,
  workItemDecideArgs,
  workItemOpenArgs,
} from "../src/plugins/workflow/schemas.ts";
import {
  HASHLINE_EDIT_OPS,
  STR_REPLACE_EDITOR_COMMANDS,
  editToolContracts,
} from "../src/plugins/hashline-edit/schemas.ts";
import {
  FETCH_FORMATS,
  SEARCH_FRESHNESS_WINDOWS,
  webToolContracts,
} from "../src/plugins/web-tools/schemas.ts";

// START_BLOCK_TYPES
/** Repo-relative source path plus its text. */
export interface SourceFile {
  readonly path: string;
  readonly content: string;
}

/** Owned-tool registration census with dynamic-registration diagnostics. */
export interface RegistrationCensus {
  readonly toolIds: readonly string[];
  readonly byFile: Readonly<Record<string, readonly string[]>>;
  readonly dynamic: readonly string[];
}

/** Declared dispatcher branch source for one discriminated field. */
export interface DispatchBranchProbe {
  readonly vocabularyKey: string;
  readonly file: string;
  readonly member: string;
}

/** Independent reader of actual registered-schema vocabulary values. */
export type VocabularyReader = (vocabularyKey: string) => readonly string[] | undefined;

/** Check outcome with bounded failure rows and a summary. */
export interface ToolContractCheckResult {
  readonly ok: boolean;
  readonly failures: readonly string[];
  readonly summary: {
    readonly tools: number;
    /** Number of checked operation fixtures (not distinct public operations). */
    readonly fixtures: number;
    readonly resultVariants: number;
    readonly vocabularies: number;
    readonly registeredToolIds: number;
    readonly dispatchLiterals: number;
  };
}

// END_BLOCK_TYPES

// START_BLOCK_BRANCH_PROBES
/** Dispatcher sources compared against declared vocabularies. */
export const DISPATCH_BRANCH_PROBES: readonly DispatchBranchProbe[] = [
  {
    vocabularyKey: "work_item_decide.decision",
    file: "src/plugins/workflow/tooling.ts",
    member: "decision",
  },
  {
    vocabularyKey: "work_checkpoint.action",
    file: "src/plugins/workflow/tooling.ts",
    member: "action",
  },
  {
    vocabularyKey: "hashline_edit.edits[].op",
    file: "src/plugins/hashline-edit/normalize-edits.ts",
    member: "op",
  },
  {
    vocabularyKey: "str_replace_editor.command",
    file: "src/plugins/hashline-edit/str-replace-editor.ts",
    member: "command",
  },
];
// END_BLOCK_BRANCH_PROBES

// START_BLOCK_AST_CENSUS
/** Static property name of an AST property name node, if any. */
export function staticPropertyName(name: ts.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    const expression = name.expression;
    if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
      return expression.text;
    }
  }
  return undefined;
}

/** A property that statically names the `tool` registration member. */
function isToolProperty(node: ts.Node): node is ts.PropertyAssignment {
  return ts.isPropertyAssignment(node) && staticPropertyName(node.name) === "tool";
}

function collectToolMapKeys(
  map: ts.ObjectLiteralExpression,
  file: SourceFile,
  ids: string[],
  dynamic: string[],
): void {
  for (const property of map.properties) {
    if (ts.isSpreadAssignment(property)) {
      dynamic.push(`${file.path}: spread registration entry in the tool map`);
      continue;
    }
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
      const name = ts.isShorthandPropertyAssignment(property)
        ? property.name.text
        : staticPropertyName(property.name);
      if (name === undefined) {
        dynamic.push(`${file.path}: computed dynamic tool registration key`);
      } else {
        ids.push(name);
      }
      continue;
    }
    dynamic.push(`${file.path}: unsupported entry in the tool registration map`);
  }
}

function isFactoryCandidate(node: ts.Node): boolean {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** Returned object literals of one factory, excluding nested functions. */
function skipParentheses(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? skipParentheses(node.expression) : node;
}

function collectReturnedObjects(factory: ts.Node): ts.ObjectLiteralExpression[] {
  const returned: ts.ObjectLiteralExpression[] = [];
  if (ts.isArrowFunction(factory) && !ts.isBlock(factory.body)) {
    const body = skipParentheses(factory.body);
    if (ts.isObjectLiteralExpression(body)) returned.push(body);
  }
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression) {
      const expression = skipParentheses(node.expression);
      if (ts.isObjectLiteralExpression(expression)) returned.push(expression);
    }
    if (node !== factory && ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(factory);
  return returned;
}

/**
 * A declaration is a real plugin factory when its name ends in `Plugin`
 * (including `createXPlugin` helpers) or its declared type names the host
 * `Plugin` contract. Plain result/envelope builders are not factories.
 */
function isPluginFactoryDeclaration(
  name: string | undefined,
  type: ts.TypeNode | undefined,
  source: ts.SourceFile,
): boolean {
  if (name && /plugin$/i.test(name)) return true;
  return type?.getText(source).includes("Plugin") === true;
}

/** Resolve a local factory declaration referenced by a default export alias. */
function findLocalFactory(source: ts.SourceFile, name: string): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = node;
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      if (node.initializer && isFactoryCandidate(node.initializer)) found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Independent census of `tool` registration maps in source.
 * A `tool` object literal anywhere is a registration map (its keys are the owned
 * tool ids), including static computed keys (`{["tool"]: ...}`). Every function
 * that returns an object carrying a `tool` member is treated as a plugin factory
 * regardless of name, default-export status, or declared type; a `tool` member
 * whose value is not an object literal is an unclassified dynamic registration and
 * fails closed. Unrelated object fields named `tool` (e.g. `tool: event.tool`) are
 * not maps.
 */
export function extractToolRegistrations(files: readonly SourceFile[]): RegistrationCensus {
  const byFile: Record<string, string[]> = {};
  const dynamic: string[] = [];
  const all = new Set<string>();

  for (const file of files) {
    const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
    const ids: string[] = [];
    const visit = (node: ts.Node): void => {
      if (isToolProperty(node) && ts.isObjectLiteralExpression(node.initializer)) {
        collectToolMapKeys(node.initializer, file, ids, dynamic);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    const factories: ts.Node[] = [];
    const factoryVisit = (node: ts.Node): void => {
      if (ts.isExportAssignment(node) && !node.isExportEquals) {
        const expression = skipParentheses(node.expression);
        if (isFactoryCandidate(expression)) factories.push(expression);
        else if (ts.isIdentifier(expression)) {
          const local = findLocalFactory(source, expression.text);
          if (local) factories.push(local);
        }
      } else if (ts.isFunctionDeclaration(node)) {
        if (isPluginFactoryDeclaration(node.name?.text, node.type, source)) factories.push(node);
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        if (
          node.initializer &&
          isFactoryCandidate(node.initializer) &&
          isPluginFactoryDeclaration(node.name.text, node.type, source)
        ) {
          factories.push(node.initializer);
        }
      }
      ts.forEachChild(node, factoryVisit);
    };
    factoryVisit(source);

    for (const factory of factories) {
      for (const returned of collectReturnedObjects(factory)) {
        for (const property of returned.properties) {
          if (!isToolProperty(property)) continue;
          const initializer = skipParentheses(property.initializer);
          if (ts.isObjectLiteralExpression(initializer)) {
            collectToolMapKeys(initializer, file, ids, dynamic);
          } else {
            dynamic.push(
              `${file.path}: dynamic tool registration in a factory return object: ${initializer.getText()}`,
            );
          }
        }
      }
    }

    if (ids.length > 0) {
      for (const id of ids) all.add(id);
      byFile[file.path] = [...new Set(ids)];
    }
  }

  return { toolIds: [...all].sort(), byFile, dynamic };
}

/** Census/dynamic/catalog agreement failures. */
export function compareRegistrationCensus(
  census: RegistrationCensus,
  catalogToolIds: readonly string[],
): string[] {
  const failures: string[] = [];
  for (const diagnostic of census.dynamic) {
    failures.push(`unclassified dynamic owned registration: ${diagnostic}`);
  }
  const catalog = [...catalogToolIds].sort();
  const actual = [...census.toolIds].sort();
  for (const toolId of actual) {
    if (!catalog.includes(toolId)) {
      failures.push(`registered owned tool "${toolId}" is not present in the catalog`);
    }
  }
  for (const toolId of catalog) {
    if (!actual.includes(toolId)) {
      failures.push(`catalog tool "${toolId}" has no registered plugin tool map`);
    }
  }
  return failures;
}

/** Catalog/descriptor contract agreement failures. */
export function compareDescriptorCoverage(
  catalogToolIds: readonly string[],
  descriptorToolIds: readonly string[],
): string[] {
  const failures: string[] = [];
  const catalog = [...catalogToolIds].sort();
  const descriptor = [...descriptorToolIds].sort();
  for (const toolId of descriptor) {
    if (!catalog.includes(toolId))
      failures.push(`descriptor contract "${toolId}" is absent from the catalog`);
  }
  for (const toolId of catalog) {
    if (!descriptor.includes(toolId))
      failures.push(`catalog tool "${toolId}" has no descriptor contract`);
  }
  return failures;
}
// END_BLOCK_AST_CENSUS

// START_BLOCK_VOCABULARY
function vocabularyValues(
  entries: readonly AgentToolCatalogEntry[],
  vocabularyKey: string,
): readonly string[] | undefined {
  const separator = vocabularyKey.indexOf(".");
  if (separator < 0) return undefined;
  const toolId = vocabularyKey.slice(0, separator);
  const field = vocabularyKey.slice(separator + 1);
  const entry = entries.find((candidate) => candidate.toolId === toolId);
  return entry?.vocabularies.find((vocabulary) => vocabulary.field === field)?.values;
}

/** Declared vs actual vocabulary agreement failures. */
export function compareCatalogVocabularies(
  entries: readonly AgentToolCatalogEntry[],
  reader: VocabularyReader,
): string[] {
  const failures: string[] = [];
  for (const entry of entries) {
    for (const vocabulary of entry.vocabularies) {
      const key = `${entry.toolId}.${vocabulary.field}`;
      const actual = reader(key);
      if (actual === undefined) {
        failures.push(`${key}: no independent registered-schema vocabulary reader`);
        continue;
      }
      const declared = [...vocabulary.values].sort();
      const registered = [...actual].sort();
      if (JSON.stringify(declared) !== JSON.stringify(registered)) {
        failures.push(
          `${key}: catalog [${declared.join(", ")}] != registered [${registered.join(", ")}]`,
        );
      }
    }
  }
  return failures;
}

/** String literals dispatched on one member name. */
export function collectMemberLiterals(source: SourceFile, member: string): string[] {
  const ast = ts.createSourceFile(source.path, source.content, ts.ScriptTarget.Latest, true);
  const found = new Set<string>();
  const matches = (node: ts.Expression): boolean => {
    if (ts.isPropertyAccessExpression(node)) return node.name.text === member;
    if (ts.isIdentifier(node)) return node.text === member;
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isSwitchStatement(node) && matches(node.expression)) {
      for (const clause of node.caseBlock.clauses) {
        if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) {
          found.add(clause.expression.text);
        }
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      if (ts.isStringLiteral(node.right) && matches(node.left)) found.add(node.right.text);
      else if (ts.isStringLiteral(node.left) && matches(node.right)) found.add(node.left.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return [...found].sort();
}

/** Undeclared dispatch-branch failures. */
export function checkDispatchBranches(
  entries: readonly AgentToolCatalogEntry[],
  files: readonly SourceFile[],
  probes: readonly DispatchBranchProbe[] = DISPATCH_BRANCH_PROBES,
): { failures: string[]; literals: string[] } {
  const failures: string[] = [];
  const literals: string[] = [];
  for (const probe of probes) {
    const declared = vocabularyValues(entries, probe.vocabularyKey);
    if (declared === undefined) {
      failures.push(`${probe.vocabularyKey}: dispatcher probe has no declared catalog vocabulary`);
      continue;
    }
    const file = files.find((candidate) => candidate.path === probe.file);
    if (!file) {
      failures.push(`${probe.vocabularyKey}: dispatcher source ${probe.file} was not found`);
      continue;
    }
    for (const literal of collectMemberLiterals(file, probe.member)) {
      literals.push(`${probe.vocabularyKey}:${literal}`);
      if (!declared.includes(literal)) {
        failures.push(
          `${probe.vocabularyKey}: undeclared dispatcher branch "${literal}" in ${probe.file}`,
        );
      }
    }
  }
  return { failures, literals };
}
// END_BLOCK_VOCABULARY

// START_BLOCK_FIXTURES
/** Positive/negative fixture agreement failures against the actual validators. */
export function validateCatalogOperations(entries: readonly AgentToolCatalogEntry[]): string[] {
  const failures: string[] = [];
  for (const entry of entries) {
    for (const operation of entry.operations) {
      const result = entry.validate(operation.input);
      const expected = operation.expect === "accept";
      if (result.ok !== expected) {
        const path = result.issues?.[0]?.path ?? "(root)";
        failures.push(
          `${operation.id}: expected ${operation.expect}, got ${result.ok ? "accept" : "reject"} at ${path}`,
        );
      }
    }
  }
  return failures;
}

/** Extract the string value(s) a fixture actually carries at a vocabulary path. */
function collectParsedValues(data: unknown, fieldPath: string): string[] {
  const segments = fieldPath.split(".");
  let current: unknown[] = [data];
  for (const segment of segments) {
    const isArray = segment.endsWith("[]");
    const name = isArray ? segment.slice(0, -2) : segment;
    const next: unknown[] = [];
    for (const item of current) {
      if (item === null || typeof item !== "object") continue;
      const value = (item as Record<string, unknown>)[name];
      if (value === undefined) continue;
      if (isArray) {
        if (Array.isArray(value)) next.push(...value);
      } else {
        next.push(value);
      }
    }
    current = next;
  }
  return current.filter((value): value is string => typeof value === "string");
}

/** Normalize a bracketed issue/vocabulary path so `edits[0].op` matches `edits[].op`. */
function normalizeCoveragePath(path: string): string {
  return path.replace(/\[\d+\]/g, "").replace(/\[\]/g, "");
}

/** Missing required negative-scenario failures, keyed to each declared vocabulary. */
export function checkNegativeCoverage(entries: readonly AgentToolCatalogEntry[]): string[] {
  const failures: string[] = [];
  for (const entry of entries) {
    const positives = entry.operations.filter((operation) => operation.expect === "accept");
    const negatives = entry.operations.filter((operation) => operation.expect === "reject");
    if (positives.length === 0) failures.push(`${entry.toolId}: no positive fixture`);
    if (negatives.length === 0) failures.push(`${entry.toolId}: no negative fixture`);
    for (const vocabulary of entry.vocabularies) {
      const field = normalizeCoveragePath(vocabulary.field);
      const targeted = negatives.some((operation) =>
        (entry.validate(operation.input).issues ?? []).some((issue) => {
          const issuePath = normalizeCoveragePath(issue.path);
          return issuePath === field || issuePath.startsWith(`${field}.`);
        }),
      );
      if (!targeted) {
        failures.push(
          `${entry.toolId}: no negative fixture rejects an invalid value for ${vocabulary.field}`,
        );
      }
    }
  }
  return failures;
}

/** Registered-schema vocabularies that are missing from the catalog declarations. */
export function checkVocabularyDeclarations(
  entries: readonly AgentToolCatalogEntry[],
  registeredKeys: readonly string[] = registeredVocabularyKeys(),
): string[] {
  const declared = new Set(
    entries.flatMap((entry) => entry.vocabularies.map((vocab) => `${entry.toolId}.${vocab.field}`)),
  );
  return registeredKeys
    .filter((key) => !declared.has(key))
    .map((key) => `${key}: registered-schema vocabulary is not declared in the catalog`);
}

/**
 * Non-vocabulary discriminator paths whose presence/value defines an operation
 * family: edit delete/rename modes, the open standalone/generic source shape, and
 * the list includeClosed variant.
 */
export const STRUCTURAL_DISCRIMINATOR_PATHS: Record<string, readonly string[]> = {
  hashline_edit: ["delete", "rename"],
  work_item_open: ["execution", "runId"],
  work_item_list: ["includeClosed"],
};

function resolveJsonPath(value: unknown, path: readonly string[]): unknown[] {
  if (path.length === 0) return [value];
  const [head, ...rest] = path;
  const isArray = head.endsWith("[]");
  const key = isArray ? head.slice(0, -2) : head;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [undefined];
  const next = (value as Record<string, unknown>)[key];
  if (isArray) {
    if (!Array.isArray(next)) return [undefined];
    return next.flatMap((item) => resolveJsonPath(item, rest));
  }
  return resolveJsonPath(next, rest);
}

function discriminatorToken(value: unknown, structural: boolean): string {
  if (value === undefined) return "absent";
  if (structural) return typeof value === "boolean" ? `boolean:${value}` : "present";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return `${typeof value}:${String(value)}`;
  }
  return "present";
}

function discriminatorTokens(
  data: unknown,
  path: string,
  structural: boolean,
): string[] {
  const tokens = resolveJsonPath(data, path.split(".")).map((value) =>
    discriminatorToken(value, structural),
  );
  return tokens.length > 0 ? [...new Set(tokens)].sort() : ["absent"];
}

function branchKeyFor(entry: AgentToolCatalogEntry, data: unknown): string {
  const structural = STRUCTURAL_DISCRIMINATOR_PATHS[entry.toolId] ?? [];
  const parts = [
    ...entry.vocabularies.map(
      (vocab) => `${vocab.field}=${discriminatorTokens(data, vocab.field, false).join(",")}`,
    ),
    ...structural.map(
      (path) => `${path}=${discriminatorTokens(data, path, true).join(",")}`,
    ),
  ];
  return parts.join("|");
}

/**
 * Every supported operation/branch/source variant must carry at least one reject
 * fixture that retains that branch's actual discriminator values and fails a
 * different owned condition. Branch association is derived from real validated
 * positive fixtures (parsed values) and matched against raw rejected inputs, so a
 * copied label or an unsupported-value negative cannot fund another branch.
 */
export function checkBranchNegatives(entries: readonly AgentToolCatalogEntry[]): string[] {
  const failures: string[] = [];
  for (const entry of entries) {
    const positives = entry.operations.filter((operation) => operation.expect === "accept");
    const negatives = entry.operations.filter((operation) => operation.expect === "reject");
    const branchPositives = new Map<string, string[]>();
    for (const operation of positives) {
      const result = entry.validate(operation.input);
      if (!result.ok) continue;
      const key = branchKeyFor(entry, result.data);
      if (!branchPositives.has(key)) branchPositives.set(key, []);
      branchPositives.get(key)!.push(operation.id);
    }
    const structural = STRUCTURAL_DISCRIMINATOR_PATHS[entry.toolId] ?? [];
    const discriminatorFields = [
      ...entry.vocabularies.map((vocab) => vocab.field),
      ...structural,
    ].map((path) => normalizeCoveragePath(path));
    const keyedNegatives = negatives.map((operation) => ({
      operation,
      key: branchKeyFor(entry, operation.input),
    }));
    for (const [key, positiveIds] of branchPositives) {
      const candidates = keyedNegatives.filter((candidate) => candidate.key === key);
      const hasValidNegative = candidates.some(({ operation }) => {
        const result = entry.validate(operation.input);
        if (result.ok) return false;
        return (result.issues ?? []).some(
          (issue) => !discriminatorFields.includes(normalizeCoveragePath(issue.path)),
        );
      });
      if (!hasValidNegative) {
        failures.push(
          `${entry.toolId}: branch [${key}] (positives: ${positiveIds.join(", ")}) has no negative fixture that retains its discriminator and fails another condition`,
        );
      }
    }
  }
  return failures;
}

/** Result fixture schema agreement, including nested provider/action branch coverage. */
export function validateCatalogResults(entries: readonly AgentToolCatalogEntry[]): string[] {
  const failures: string[] = [];
  for (const entry of entries) {
    if (entry.results.length === 0) {
      failures.push(`${entry.toolId}: no result fixtures`);
      continue;
    }
    const schema = entry.resultSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };
    for (const variant of entry.results) {
      if (!schema.safeParse(variant.fixture).success) {
        failures.push(`${entry.toolId}/${variant.id}: fixture does not match the result schema`);
      }
    }
    failures.push(...resultBranchGaps(entry));
  }
  return failures;
}

/** Declared-default application failures against the actual validators. */
export function checkCatalogDefaults(entries: readonly AgentToolCatalogEntry[]): string[] {
  const failures: string[] = [];
  for (const entry of entries) {
    if (entry.defaults.length === 0) continue;
    const positive = entry.operations.find((operation) => operation.expect === "accept");
    if (!positive) {
      failures.push(`${entry.toolId}: no positive fixture to exercise declared defaults`);
      continue;
    }
    const result = entry.validate(positive.input);
    if (!result.ok) {
      failures.push(
        `${entry.toolId}: default probe fixture was rejected at ${result.issues?.[0]?.path ?? "(root)"}`,
      );
      continue;
    }
    const data = (result.data ?? {}) as Record<string, unknown>;
    for (const entryDefault of entry.defaults) {
      if (data[entryDefault.field] !== entryDefault.value) {
        failures.push(
          `${entry.toolId}.${entryDefault.field}: declared default ${JSON.stringify(entryDefault.value)} != applied ${JSON.stringify(data[entryDefault.field])}`,
        );
      }
    }
  }
  return failures;
}

/** Open known-object failures in published input schemas. */
export function checkClosedInputs(entries: readonly AgentToolCatalogEntry[]): string[] {
  const failures: string[] = [];
  for (const entry of entries) {
    for (const path of findOpaqueInputObjects(entry.contract.inputJsonSchema)) {
      failures.push(`${entry.toolId}: ${path}`);
    }
  }
  return failures;
}

/** Generated-reference drift failure. */
export function referenceCurrencyFailure(expected: string, actual: string | undefined): string[] {
  if (actual === undefined) {
    return [
      `generated reference ${CONTRACT_REFERENCE_PACKAGE_PATH} is missing; run bun run contracts:generate`,
    ];
  }
  if (expected !== actual) {
    return [
      `generated reference ${CONTRACT_REFERENCE_PACKAGE_PATH} is stale; run bun run contracts:generate`,
    ];
  }
  return [];
}
/**
 * Every declared vocabulary value covered by a positive operation fixture, with the
 * `covers` claim validated against the value the real validator actually parses from
 * that fixture. A relabeled or drifted example fails even if the `covers` key survives.
 */
export function checkOperationCoverage(entries: readonly AgentToolCatalogEntry[]): string[] {
  const failures: string[] = [];
  for (const entry of entries) {
    for (const vocabulary of entry.vocabularies) {
      for (const value of vocabulary.values) {
        const claim = entry.operations.find(
          (operation) =>
            operation.expect === "accept" && operation.covers?.[vocabulary.field] === value,
        );
        if (!claim) {
          failures.push(`${entry.toolId}: ${vocabulary.field}=${value} has no positive fixture`);
          continue;
        }
        const result = entry.validate(claim.input);
        if (!result.ok) {
          failures.push(
            `${entry.toolId}: ${claim.id} claims ${vocabulary.field}=${value} but the fixture is rejected`,
          );
          continue;
        }
        if (!collectParsedValues(result.data, vocabulary.field).includes(value)) {
          failures.push(
            `${entry.toolId}: ${claim.id} claims ${vocabulary.field}=${value} but the parsed fixture carries ${JSON.stringify(collectParsedValues(result.data, vocabulary.field))}`,
          );
        }
      }
    }
  }
  return failures;
}
// END_BLOCK_FIXTURES

// START_BLOCK_RUNTIME_READER
function unwrapZod(schema: unknown): Record<string, unknown> {
  const candidate = schema as { unwrap?: () => unknown };
  return typeof candidate?.unwrap === "function"
    ? unwrapZod(candidate.unwrap())
    : (schema as Record<string, unknown>);
}

function enumOptions(schema: unknown): readonly string[] {
  const options = unwrapZod(schema).options;
  return Array.isArray(options) ? (options as string[]) : [];
}

function registeredSourceKinds(): readonly string[] {
  const execution = unwrapZod(workItemOpenArgs.execution);
  const executionShape = execution.shape as Record<string, unknown>;
  const sourceUnion = unwrapZod(executionShape.source);
  const options = (sourceUnion as { options?: readonly unknown[] }).options ?? [];
  return options
    .map((branch) => {
      const branchShape = unwrapZod(branch).shape as Record<string, unknown>;
      const kind = unwrapZod(branchShape.kind) as { value?: unknown };
      return kind.value;
    })
    .filter((value): value is string => typeof value === "string");
}

/**
 * Independent readers of the actual registered-schema vocabulary values.
 * Values come from the canonical enum owners and the registered argument maps,
 * never from the catalog.
 */
const RUNTIME_VOCABULARY_READERS: Record<string, () => readonly string[]> = {
  "work_item_open.items[].mode": () => WORK_ITEM_MODES,
  "work_item_open.execution.source.kind": registeredSourceKinds,
  "work_item_decide.decision": () => enumOptions(workItemDecideArgs.decision),
  "work_checkpoint.action": () => enumOptions(workCheckpointArgs.action),
  "hashline_edit.edits[].op": () => HASHLINE_EDIT_OPS,
  "str_replace_editor.command": () => STR_REPLACE_EDITOR_COMMANDS,
  "web_search.freshness": () => SEARCH_FRESHNESS_WINDOWS,
  "web_fetch.format": () => FETCH_FORMATS,
};

/** Search freshness/format vocabularies plus every other registered enum key. */
export function registeredVocabularyKeys(): string[] {
  return Object.keys(RUNTIME_VOCABULARY_READERS).sort();
}

/** Independent reader of the actual registered-schema vocabulary values. */
export function buildRuntimeVocabularyReader(): VocabularyReader {
  return (key) => RUNTIME_VOCABULARY_READERS[key]?.();
}

/** Actual descriptor contract tool ids (independent of the catalog). */
export function descriptorToolIds(): string[] {
  return [
    ...workflowToolContracts.map((contract) => contract.toolId),
    ...editToolContracts.map((contract) => contract.toolId),
    ...webToolContracts.map((contract) => contract.toolId),
  ]
    .filter((toolId, index, all) => all.indexOf(toolId) === index)
    .sort();
}
// END_BLOCK_RUNTIME_READER

// START_BLOCK_LOADERS
function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** Pick the import/default/types target string from a package export value. */
function exportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of ["import", "default", "require", "types"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
    for (const nested of Object.values(record)) {
      const target = exportTarget(nested);
      if (target) return target;
    }
  }
  return undefined;
}

/** Map a built dist target path to its TypeScript source path. */
function distTargetToSource(target: string): string {
  let normalized = target.replace(/^\.\//, "");
  normalized = normalized.replace(/\.d\.ts$/, ".ts").replace(/\.(mjs|cjs|js)$/, ".ts");
  if (normalized.startsWith("dist/")) return `src/${normalized.slice("dist/".length)}`;
  return normalized;
}

/** Map package export subpaths to their actual source entry files. */
export function resolvePluginEntryPoints(
  repoRoot: string,
): { subpath: string; sourcePath: string }[] {
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    exports?: Record<string, unknown>;
  };
  const entries: { subpath: string; sourcePath: string }[] = [];
  for (const [subpath, value] of Object.entries(packageJson.exports ?? {})) {
    if (!subpath.startsWith("./plugins/")) continue;
    const target = exportTarget(value);
    if (!target) continue;
    entries.push({ subpath, sourcePath: distTargetToSource(target) });
  }
  return entries.sort((left, right) => left.subpath.localeCompare(right.subpath));
}

/**
 * Discover non-test plugin sources: the recursive `src/plugins` tree, the root
 * barrel, every package-exported plugin entry resolved to its actual source, and
 * that entry's local relative re-export/import graph. This means a plugin entry
 * outside `src/plugins` (or behind a re-export barrel) cannot escape the census.
 */
export function loadPluginSources(repoRoot: string): SourceFile[] {
  const files = new Map<string, SourceFile>();
  const addFile = (absolute: string): SourceFile | undefined => {
    if (!existsSync(absolute)) return undefined;
    const path = toPosix(relative(repoRoot, absolute));
    const existing = files.get(path);
    if (existing) return existing;
    const file: SourceFile = { path, content: readFileSync(absolute, "utf8") };
    files.set(path, file);
    return file;
  };

  const visitDirectory = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        visitDirectory(absolute);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        addFile(absolute);
      }
    }
  };
  const pluginsRoot = join(repoRoot, "src", "plugins");
  if (existsSync(pluginsRoot)) visitDirectory(pluginsRoot);
  addFile(join(repoRoot, "src", "index.ts"));

  // Follow the local import graph of each package-exported plugin entry so a new
  // owned entry outside src/plugins is still inspected.
  const resolveLocal = (fromAbsolute: string, specifier: string): string | undefined => {
    if (!specifier.startsWith(".")) return undefined;
    const base = resolve(join(fromAbsolute, ".."), specifier);
    const candidates = [
      base.replace(/\.(mjs|cjs|js)$/, ".ts"),
      `${base}.ts`,
      join(base, "index.ts"),
    ];
    return candidates.find((candidate) => existsSync(candidate) && candidate.endsWith(".ts"));
  };
  const follow = (absolute: string, seen: Set<string>): void => {
    const file = addFile(absolute);
    if (!file || seen.has(file.path)) return;
    seen.add(file.path);
    const ast = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        const target = resolveLocal(absolute, node.moduleSpecifier.text);
        if (target) follow(target, seen);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  };
  for (const entry of resolvePluginEntryPoints(repoRoot)) {
    const absolute = join(repoRoot, entry.sourcePath);
    if (existsSync(absolute) && absolute.endsWith(".ts")) follow(absolute, new Set());
  }

  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}
// END_BLOCK_LOADERS

// START_BLOCK_RUNNER
/** Full read-only check over injectable inputs. */
export async function runToolContractCheck(input?: {
  readonly entries?: readonly AgentToolCatalogEntry[];
  readonly files?: readonly SourceFile[];
  readonly vocabularyReader?: VocabularyReader;
  readonly branchProbes?: readonly DispatchBranchProbe[];
  readonly referenceMarkdown?: string;
  readonly repoRoot?: string;
}): Promise<ToolContractCheckResult> {
  const repoRoot = input?.repoRoot ?? resolve(new URL("..", import.meta.url).pathname);
  const entries = input?.entries ?? agentToolCatalog;
  const files = input?.files ?? loadPluginSources(repoRoot);
  const reader = input?.vocabularyReader ?? buildRuntimeVocabularyReader();
  const probes = input?.branchProbes ?? DISPATCH_BRANCH_PROBES;
  const referenceMarkdown =
    input?.referenceMarkdown ??
    (existsSync(join(repoRoot, CONTRACT_REFERENCE_PACKAGE_PATH))
      ? readFileSync(join(repoRoot, CONTRACT_REFERENCE_PACKAGE_PATH), "utf8")
      : undefined);

  const dispatch = checkDispatchBranches(entries, files, probes);
  const failures = [
    ...compareRegistrationCensus(
      extractToolRegistrations(files),
      entries.map((entry) => entry.toolId),
    ),
    ...compareDescriptorCoverage(
      entries.map((entry) => entry.toolId),
      descriptorToolIds(),
    ),
    ...compareCatalogVocabularies(entries, reader),
    ...checkVocabularyDeclarations(entries),
    ...dispatch.failures,
    ...validateCatalogOperations(entries),
    ...checkOperationCoverage(entries),
    ...checkNegativeCoverage(entries),
    ...checkBranchNegatives(entries),
    ...validateCatalogResults(entries),
    ...checkCatalogDefaults(entries),
    ...checkClosedInputs(entries),
    ...referenceCurrencyFailure(renderToolContractsReference(entries), referenceMarkdown),
  ];

  return {
    ok: failures.length === 0,
    failures,
    summary: {
      tools: entries.length,
      fixtures: entries.reduce((total, entry) => total + entry.operations.length, 0),
      resultVariants: entries.reduce((total, entry) => total + entry.results.length, 0),
      vocabularies: entries.reduce((total, entry) => total + entry.vocabularies.length, 0),
      registeredToolIds: extractToolRegistrations(files).toolIds.length,
      dispatchLiterals: dispatch.literals.length,
    },
  };
}

/** Write the generated reference document. */
export function generateReference(repoRoot: string): string {
  const target = join(repoRoot, CONTRACT_REFERENCE_PACKAGE_PATH);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, renderToolContractsReference(), "utf8");
  return target;
}
// END_BLOCK_RUNNER

// START_BLOCK_PACKED
/** Verify built package assets: generated reference currency and loaded identity. */
export async function runPackedChecks(repoRoot: string): Promise<number> {
  const { pathToFileURL } = await import("node:url");
  const failures: string[] = [];
  try {
    const distCatalog = (await import(
      pathToFileURL(join(repoRoot, "dist/lib/agent-tool-catalog.js")).href
    )) as {
      renderToolContractsReference: () => string;
      validateAgentToolCatalog: () => { ok: boolean; failures: string[] };
    };
    const distContract = (await import(
      pathToFileURL(join(repoRoot, "dist/lib/agent-tool-contract.js")).href
    )) as {
      PACKAGE_NAME: string;
      PACKAGE_VERSION: string;
      AGENT_TOOL_CONTRACT_REVISION: string;
    };

    if (distContract.PACKAGE_NAME !== PACKAGE_NAME) {
      failures.push(`built PACKAGE_NAME ${distContract.PACKAGE_NAME} != ${PACKAGE_NAME}`);
    }
    if (distContract.PACKAGE_VERSION !== PACKAGE_VERSION) {
      failures.push(`built PACKAGE_VERSION ${distContract.PACKAGE_VERSION} != ${PACKAGE_VERSION}`);
    }
    if (distContract.AGENT_TOOL_CONTRACT_REVISION !== AGENT_TOOL_CONTRACT_REVISION) {
      failures.push(
        `built contract revision ${distContract.AGENT_TOOL_CONTRACT_REVISION} != ${AGENT_TOOL_CONTRACT_REVISION}`,
      );
    }

    const referencePath = join(repoRoot, CONTRACT_REFERENCE_PACKAGE_PATH);
    const referenceMarkdown = existsSync(referencePath)
      ? readFileSync(referencePath, "utf8")
      : undefined;
    failures.push(
      ...referenceCurrencyFailure(distCatalog.renderToolContractsReference(), referenceMarkdown),
    );

    const fixtureOutcome = distCatalog.validateAgentToolCatalog();
    if (!fixtureOutcome.ok) {
      failures.push(...fixtureOutcome.failures.map((failure) => `built fixture: ${failure}`));
    }

    const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      files?: readonly string[];
    };
    if (!(packageJson.files ?? []).includes("templates")) {
      failures.push("package.json files does not include the templates asset directory");
    }
    for (const entry of resolvePluginEntryPoints(repoRoot)) {
      if (!existsSync(join(repoRoot, entry.sourcePath))) {
        failures.push(`package export ${entry.subpath} has no source entry ${entry.sourcePath}`);
      }
    }

    // Observed pack assertion: the actual npm dry-run manifest must bundle the
    // generated reference and the built entry points, not merely declare them.
    const { execFileSync } = await import("node:child_process");
    const packOutput = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    // `prepare` lifecycle output can precede the JSON on stdout, so start at the
    // first top-level array line rather than assuming the whole output is JSON.
    const packLines = packOutput.split("\n");
    const manifestStart = packLines.findIndex((line) => line.trim() === "[");
    const manifest = JSON.parse(
      manifestStart >= 0 ? packLines.slice(manifestStart).join("\n") : packOutput,
    ) as Array<{ files?: Array<{ path?: string }> }>;
    const packedPaths = (manifest[0]?.files ?? [])
      .map((file) => file.path)
      .filter((path): path is string => typeof path === "string");
    const requiredAssets = [
      CONTRACT_REFERENCE_PACKAGE_PATH,
      "dist/index.js",
      "dist/cli.js",
      "templates/skills/vv-execute/SKILL.md",
    ];
    for (const asset of requiredAssets) {
      if (!packedPaths.some((packed) => packed === asset || packed.endsWith(`/${asset}`))) {
        failures.push(`npm pack dry-run manifest is missing bundled asset ${asset}`);
      }
    }
  } catch (error) {
    failures.push(
      `built package check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  for (const failure of failures) console.error(`  FAIL ${failure}`);
  return failures.length === 0 ? 0 : 1;
}
// END_BLOCK_PACKED

// START_BLOCK_CLI
function printResult(result: ToolContractCheckResult): void {
  const { summary } = result;
  console.log(
    `tool-contracts: tools=${summary.tools} fixtures=${summary.fixtures} results=${summary.resultVariants} vocabularies=${summary.vocabularies} registered=${summary.registeredToolIds} dispatchLiterals=${summary.dispatchLiterals}`,
  );
  if (result.ok) {
    console.log("✓ tool-contract catalog and generated reference are current.");
    return;
  }
  console.error(`✗ tool-contract check failed with ${result.failures.length} issue(s):`);
  for (const failure of result.failures) console.error(`  ${failure}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const repoRoot = resolve(new URL("..", import.meta.url).pathname);
  if (args.includes("--generate")) {
    const target = generateReference(repoRoot);
    console.log(`✓ regenerated ${toPosix(relative(repoRoot, target))}.`);
    process.exitCode = 0;
  } else if (args.includes("--packed")) {
    process.exitCode = await runPackedChecks(repoRoot);
  } else {
    const result = await runToolContractCheck({ repoRoot });
    printResult(result);
    process.exitCode = result.ok ? 0 : 1;
  }
}
// END_BLOCK_CLI
