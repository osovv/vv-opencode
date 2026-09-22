// FILE: src/lib/spec-lint/delegated-extraction.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Strict typed extraction of delegated obligations from plan content.
//   SCOPE: extractDelegatedPlanDefinition validating through the same parse, delegated facts, and execution-section rules as lint so runtime registration and the linter share one interpretation of the declared vocabulary.
//   DEPENDS: [src/lib/workflow-contract.ts, src/lib/spec-lint/parser.ts, src/lib/spec-lint/plan-rules.ts]
//   LINKS: [M-SPEC-LINT, M-WORKFLOW-CONTRACT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   extractDelegatedPlanDefinition - Strictly extract and validate typed delegated obligations from plan content.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SPEC-LINT-RULES-SPLIT-R1 - Extracted delegated obligation extraction from the former src/lib/spec-lint.ts monolith into this zone module.]
// END_CHANGE_SUMMARY

import {
  normalizeDeclaredScopePath,
  type DelegatedCheckpointDefinition,
  type DelegatedPlanExtractionResult,
} from "../workflow-contract.js";
import {
  child,
  children,
  IDENTITY_PATTERNS,
  parseSpecXml,
  SpecLintFinding,
  textOf,
} from "./parser.js";
import { collectDelegatedTaskFacts, lintExecutionSection } from "./plan-rules.js";

// START_BLOCK_DELEGATED_EXTRACTION
/**
 * Strictly extract typed delegated obligations from plan content. Returns
 * ok:false with every validation message when the plan does not declare a
 * structurally complete and valid delegated execution section, so runtime
 * registration and lint share one contract instead of two interpretations.
 */
export function extractDelegatedPlanDefinition(
  planContent: string,
  file = "plan.xml",
): DelegatedPlanExtractionResult {
  const parsed = parseSpecXml(planContent, file);
  const parseErrors = parsed.findings
    .filter((f) => f.severity === "error")
    .map((f) => `${file}: ${f.message}`);
  if (!parsed.root || parseErrors.length > 0) {
    return {
      ok: false,
      errors: parseErrors.length > 0 ? parseErrors : [`${file}: document has no root element`],
    };
  }
  if (parsed.root.name !== "plan") {
    return { ok: false, errors: [`${file}: root element <${parsed.root.name}> is not a plan`] };
  }

  const facts = collectDelegatedTaskFacts(parsed.root);
  if (facts.duplicateTaskElements.length > 0) {
    return {
      ok: false,
      errors: facts.duplicateTaskElements.map(
        (name) => `${file}: task ${name} is declared more than once`,
      ),
    };
  }

  const findings: SpecLintFinding[] = [];
  lintExecutionSection(parsed.root, file, facts, true, findings);
  const errors = findings.filter((f) => f.severity === "error").map((f) => `${file}: ${f.message}`);
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const executionNode = child(parsed.root, "execution");
  if (!executionNode || textOf(child(executionNode, "mode")) !== "delegated") {
    return { ok: false, errors: [`${file}: plan does not declare execution mode delegated`] };
  }

  const reviewCheckpointsNode = child(executionNode, "review_checkpoints");
  if (!reviewCheckpointsNode) {
    return { ok: false, errors: [`${file}: delegated execution declares no review_checkpoints`] };
  }

  const checkpoints: DelegatedCheckpointDefinition[] = [];
  for (const checkpoint of reviewCheckpointsNode.children) {
    if (!IDENTITY_PATTERNS.checkpoint.test(checkpoint.name)) continue;
    const fileTexts = (container: string): string[] => {
      const node = child(checkpoint, container);
      return node ? children(node, "file").map((entry) => textOf(entry)) : [];
    };
    const childTexts = (container: string, entry: string): string[] => {
      const node = child(checkpoint, container);
      return node ? children(node, entry).map((item) => textOf(item)) : [];
    };
    checkpoints.push({
      checkpointId: checkpoint.name,
      kind: textOf(child(checkpoint, "kind")) === "final" ? "final" : "milestone",
      afterWave: textOf(child(checkpoint, "after_wave")),
      covers: childTexts("covers", "task_id"),
      scope: fileTexts("scope").map((raw) => {
        const normalized = normalizeDeclaredScopePath(raw);
        return normalized.ok ? normalized.path : raw;
      }),
      reviewers: childTexts("reviewers", "reviewer").map((value) => {
        return value === "spec" ? ("spec" as const) : ("code" as const);
      }),
      acceptance: childTexts("acceptance", "criterion"),
      verification: childTexts("verification", "command"),
    });
  }

  return {
    ok: true,
    definition: {
      mode: "delegated",
      waves: facts.waveOrder,
      tasks: facts.tasks.map((task) => ({
        taskId: task.taskId,
        taskElement: task.taskElement,
        wave: task.wave,
        writeScope: [...task.writeScope],
        ...(task.title ? { title: task.title } : {}),
        ...(task.acceptance.length > 0 ? { acceptance: [...task.acceptance] } : {}),
        ...(task.verification.length > 0 ? { verification: [...task.verification] } : {}),
        ...(task.dependsOn.length > 0 ? { dependsOn: [...task.dependsOn] } : {}),
      })),
      checkpoints,
    },
  };
}
// END_BLOCK_DELEGATED_EXTRACTION
