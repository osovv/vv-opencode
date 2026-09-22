// FILE: src/lib/spec-lint/cross-file-rules.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Cross-artifact resolution shared by plan lint and orchestration.
//   SCOPE: resolveSpecFacts matches a plan's linked spec path against the labels of this lint run by exact path or basename so plan-subset-of-spec checks can run; the subset rule itself is emitted by lintPlan using the resolved facts.
//   DEPENDS: [src/lib/spec-lint/spec-rules.ts (SpecFacts type)]
//   LINKS: [M-SPEC-LINT]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   resolveSpecFacts - Resolve one spec path against the labels of this lint run.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SPEC-LINT-RULES-SPLIT-R1 - Extracted cross-file spec resolution from the former src/lib/spec-lint.ts monolith into this zone module.]
// END_CHANGE_SUMMARY

import type { SpecFacts } from "./spec-rules.js";

export function resolveSpecFacts(
  specPath: string,
  specByLabel: Map<string, SpecFacts>,
): SpecFacts | undefined {
  if (!specPath) return undefined;
  const normalized = specPath.replace(/\\/g, "/");
  if (specByLabel.has(normalized)) return specByLabel.get(normalized);
  const base = normalized.split("/").pop() ?? normalized;
  for (const [label, facts] of specByLabel) {
    const labelBase = label.replace(/\\/g, "/").split("/").pop() ?? label;
    if (labelBase === base) return facts;
  }
  return undefined;
}
