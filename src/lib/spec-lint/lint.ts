// FILE: src/lib/spec-lint/lint.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Orchestrate one lint run over a set of spec-package artifacts.
//   SCOPE: lintSpecArtifacts parses every input up front, collects spec facts for cross-file plan checks, dispatches each artifact to its kind rule zone, and builds unknown-kind verdicts; plans resolve their linked spec among the inputs by path or basename, and a plan without its spec yields a warning, not an error.
//   DEPENDS: [src/lib/spec-lint/parser.ts, src/lib/spec-lint/spec-rules.ts, src/lib/spec-lint/plan-rules.ts]
//   LINKS: [M-SPEC-LINT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   lintSpecArtifacts - Lint a set of artifacts together, applying cross-file rules between plans and specs.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SPEC-LINT-RULES-SPLIT-R1 - Extracted the lint orchestration entry from the former src/lib/spec-lint.ts monolith into this zone module.]
// END_CHANGE_SUMMARY

import {
  detectSpecArtifactKind,
  LINT_VERSION,
  parseSpecXml,
  type SpecLintArtifactInput,
  type SpecLintOptions,
  type SpecLintVerdict,
} from "./parser.js";
import { collectSpecFacts, lintDesignContext, lintSpec, type SpecFacts } from "./spec-rules.js";
import { lintPlan } from "./plan-rules.js";

// START_BLOCK_LINT_ENTRY
/**
 * Lint a set of spec-package artifacts together. Plans resolve their linked
 * spec among the provided inputs by path or basename for cross-file subset
 * checks; a plan without its spec yields a warning, not an error.
 */
export function lintSpecArtifacts(
  inputs: SpecLintArtifactInput[],
  options: SpecLintOptions = {},
): SpecLintVerdict[] {
  // Parse everything first so spec facts exist for plan cross-file rules.
  const parsed = inputs.map((input) => ({ input, ...parseSpecXml(input.content, input.file) }));

  const specByLabel = new Map<string, SpecFacts>();
  for (const p of parsed) {
    if (p.root && detectSpecArtifactKind(p.root.name) === "spec") {
      specByLabel.set(p.input.file.replace(/\\/g, "/"), collectSpecFacts(p.root));
    }
  }

  const verdicts: SpecLintVerdict[] = [];
  for (const p of parsed) {
    if (!p.root) {
      verdicts.push({
        version: LINT_VERSION,
        file: p.input.file,
        kind: "unknown",
        ok: false,
        findings: p.findings.length
          ? p.findings
          : [
              {
                severity: "error",
                rule: "xml.empty",
                message: "document has no root element",
                file: p.input.file,
                line: 1,
              },
            ],
      });
      continue;
    }
    const kind = detectSpecArtifactKind(p.root.name);
    switch (kind) {
      case "spec":
        verdicts.push(lintSpec(p.root, p.input.file, p.findings));
        break;
      case "plan":
        verdicts.push(lintPlan(p.root, p.input.file, p.findings, specByLabel, options));
        break;
      case "design-context":
        verdicts.push(lintDesignContext(p.root, p.input.file, p.findings));
        break;
      default:
        verdicts.push({
          version: LINT_VERSION,
          file: p.input.file,
          kind: "unknown",
          ok: false,
          findings: [
            ...p.findings,
            {
              severity: "error",
              rule: "element.root",
              message: `root element <${p.root.name}> is not one of spec, plan, design-context`,
              file: p.input.file,
              line: p.root.line,
            },
          ],
        });
    }
  }
  return verdicts;
}
// END_BLOCK_LINT_ENTRY
