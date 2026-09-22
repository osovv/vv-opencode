// FILE: src/lib/spec-lint.ts
// VERSION: 1.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Public re-export barrel for the strict .vvoc spec-package XML linter.
//   SCOPE: Re-export the complete previous public API over the zone modules in src/lib/spec-lint/ (parser, spec-rules, plan-rules, cross-file-rules, delegated-extraction, lint) plus the workflow-contract delegated vocabulary re-exports, so every ../lib/spec-lint.js and ./spec-lint.js import keeps resolving unchanged under moduleResolution NodeNext.
//   DEPENDS: [src/lib/workflow-contract.ts, src/lib/spec-lint/parser.ts, src/lib/spec-lint/spec-rules.ts, src/lib/spec-lint/plan-rules.ts, src/lib/spec-lint/cross-file-rules.ts, src/lib/spec-lint/delegated-extraction.ts, src/lib/spec-lint/lint.ts]
//   LINKS: [M-SPEC-LINT, M-WORKFLOW-CONTRACT, M-PLUGIN-SPEC-GUARD, M-CLI-COMMANDS, M-WORKFLOW-CHECKPOINTS]
//   ROLE: BARREL
//   MAP_MODE: SUMMARY
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   LINT_VERSION, SpecLintArtifactKind, SpecLintSeverity, SpecLintFinding, SpecLintVerdict, SpecLintArtifactInput, SpecLintOptions, parseSpecXml, extractDelegatedPlanDefinition, isSpecArchivePath, detectSpecArtifactKind, lintSpecArtifacts - Public linter API owned by the zone modules.
//   DelegatedReviewer, DelegatedTaskDefinition, DelegatedCheckpointDefinition, DelegatedPlanDefinition, DelegatedPlanExtractionResult, DeclaredScopePathResult, normalizeDeclaredScopePath - Workflow-contract vocabulary re-exports for existing linter consumers.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SPEC-LINT-RULES-SPLIT-R1 - Replaced the 1766-line monolith body with a re-export-only barrel over zone modules; the public API and every consumer import are unchanged and LINT_VERSION stays 2.]
// END_CHANGE_SUMMARY

import {
  normalizeDeclaredScopePath,
  type DeclaredScopePathResult,
  type DelegatedCheckpointDefinition,
  type DelegatedPlanDefinition,
  type DelegatedPlanExtractionResult,
  type DelegatedReviewer,
  type DelegatedTaskDefinition,
} from "./workflow-contract.js";

// START_BLOCK_DELEGATED_TYPES
// The delegated obligation vocabulary and the pure declared-path normalizer
// live in the dependency-free common contract so the native linter and the
// common runtime share one representation. These names remain re-exported here
// for existing linter consumers.
export {
  normalizeDeclaredScopePath,
  type DeclaredScopePathResult,
  type DelegatedCheckpointDefinition,
  type DelegatedPlanDefinition,
  type DelegatedPlanExtractionResult,
  type DelegatedReviewer,
  type DelegatedTaskDefinition,
};
// END_BLOCK_DELEGATED_TYPES

export {
  LINT_VERSION,
  parseSpecXml,
  isSpecArchivePath,
  detectSpecArtifactKind,
} from "./spec-lint/parser.js";
export type {
  SpecLintArtifactKind,
  SpecLintSeverity,
  SpecLintFinding,
  SpecLintVerdict,
  SpecLintArtifactInput,
  SpecLintOptions,
} from "./spec-lint/parser.js";

export { extractDelegatedPlanDefinition } from "./spec-lint/delegated-extraction.js";
export { lintSpecArtifacts } from "./spec-lint/lint.js";
