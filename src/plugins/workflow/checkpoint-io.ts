// FILE: src/plugins/workflow/checkpoint-io.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Filesystem adapter that loads and fully validates an approved active vvoc delegated plan and its linked approved spec for runtime registration.
//   SCOPE: Trusted-root containment, regular-file and archive rejection, strict parse, lifecycle status checks, full cross-file lint through the shared engine, typed delegated extraction, and content-hash capture. Domain transitions and fingerprint capture live elsewhere.
//   DEPENDS: [node:crypto, node:fs/promises, node:path, src/lib/spec-lint.ts, src/lib/workflow-contract.ts]
//   LINKS: [M-WORKFLOW-CHECKPOINTS, M-SPEC-LINT, M-WORKFLOW-CONTRACT, M-WORKFLOW-DELEGATED, V-M-WORKFLOW-CHECKPOINTS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   LoadedDelegatedPlan - Canonical approved plan/spec inputs with content hashes and typed obligations.
//   LoadApprovedDelegatedPlanErrorCode - Rejection codes for approved-plan loading.
//   LoadApprovedDelegatedPlanResult - Loaded plan or a coded rejection.
//   LoadApprovedDelegatedPlanInput - Workspace root and plan path (absolute or root-relative).
//   loadApprovedDelegatedPlan - Load, validate, lint, and extract one approved delegated plan package.
//   contentSha256 - Deterministic SHA-256 over provided text.
//   nativeExecutionSource - Map a validated native package onto the common immutable source identity.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-WORKFLOW-PLAN-INDEPENDENCE - Added pure native-to-common source adaptation; delegated definition types now come from the shared contract module.]
// END_CHANGE_SUMMARY

import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  extractDelegatedPlanDefinition,
  isSpecArchivePath,
  lintSpecArtifacts,
  parseSpecXml,
} from "../../lib/spec-lint.js";
import type {
  DelegatedPlanDefinition,
  WorkflowExecutionSource,
} from "../../lib/workflow-contract.js";

// START_BLOCK_IO_TYPES
export interface LoadedDelegatedPlan {
  /** Canonical absolute plan.xml path. */
  planPath: string;
  /** Canonical absolute linked spec.xml path. */
  specPath: string;
  /** Canonical absolute trusted workspace root. */
  workspaceRoot: string;
  /** SHA-256 of the loaded plan content. */
  planSha256: string;
  /** SHA-256 of the loaded spec content. */
  specSha256: string;
  /** Typed delegated obligations extracted from the approved plan. */
  definition: DelegatedPlanDefinition;
}

export type LoadApprovedDelegatedPlanErrorCode =
  | "ROOT_MISMATCH"
  | "PLAN_NOT_FOUND"
  | "PATH_ESCAPE"
  | "NOT_REGULAR_FILE"
  | "ARCHIVED_PLAN"
  | "PARSE_ERROR"
  | "NOT_A_PLAN"
  | "STATUS_NOT_APPROVED"
  | "SPEC_MISSING"
  | "SPEC_PATH_ESCAPE"
  | "SPEC_NOT_APPROVED"
  | "LINT_FAILED"
  | "NOT_DELEGATED";

export type LoadApprovedDelegatedPlanResult =
  | { ok: true; plan: LoadedDelegatedPlan }
  | { ok: false; code: LoadApprovedDelegatedPlanErrorCode; message: string };

export interface LoadApprovedDelegatedPlanInput {
  /** Trusted absolute workspace root. */
  workspaceRoot: string;
  /** Absolute or workspace-relative path to plan.xml. */
  planPath: string;
}
// END_BLOCK_IO_TYPES

// START_BLOCK_HASH_HELPER
/** Deterministic SHA-256 hex digest over provided text. */
export function contentSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
// END_BLOCK_HASH_HELPER

// START_BLOCK_NATIVE_SOURCE_ADAPTER
/**
 * Convert a fully validated native package into the common immutable source
 * identity. This is deliberately a pure mapping: native validation, lifecycle
 * checks, and hash binding have already happened during loading, and no generic
 * caller may invoke this to bypass them.
 */
export function nativeExecutionSource(
  plan: LoadedDelegatedPlan,
): Extract<WorkflowExecutionSource, { kind: "native-package" }> {
  return {
    kind: "native-package",
    planPath: plan.planPath,
    specPath: plan.specPath,
    planSha256: plan.planSha256,
    specSha256: plan.specSha256,
    definition: plan.definition,
  };
}
// END_BLOCK_NATIVE_SOURCE_ADAPTER

// START_CONTRACT: loadApprovedDelegatedPlan
//   PURPOSE: Load an active project-local approved vvoc delegated plan plus its linked approved spec, fully linted and typed.
//   INPUTS: { input: LoadApprovedDelegatedPlanInput - trusted workspace root and plan path }
//   OUTPUTS: { Promise<LoadApprovedDelegatedPlanResult> - canonical inputs, hashes, and definition, or a coded rejection }
//   SIDE_EFFECTS: Reads plan and spec files; performs no writes, agent dispatch, or command execution.
//   LINKS: [M-WORKFLOW-CHECKPOINTS, M-SPEC-LINT, registerDelegatedPlan]
// END_CONTRACT: loadApprovedDelegatedPlan
export async function loadApprovedDelegatedPlan(
  input: LoadApprovedDelegatedPlanInput,
): Promise<LoadApprovedDelegatedPlanResult> {
  if (typeof input.workspaceRoot !== "string" || !isAbsolute(input.workspaceRoot)) {
    return {
      ok: false,
      code: "ROOT_MISMATCH",
      message: `workspace root must be an absolute path, received: ${JSON.stringify(input.workspaceRoot)}`,
    };
  }
  if (typeof input.planPath !== "string" || input.planPath.trim() === "") {
    return {
      ok: false,
      code: "PLAN_NOT_FOUND",
      message: "planPath must be a non-empty string",
    };
  }

  let realRoot: string;
  try {
    realRoot = await realpath(input.workspaceRoot);
  } catch (error) {
    return {
      ok: false,
      code: "ROOT_MISMATCH",
      message: `workspace root ${input.workspaceRoot} cannot be resolved: ${(error as Error).message}`,
    };
  }

  const candidatePlanPath = isAbsolute(input.planPath)
    ? input.planPath
    : join(realRoot, input.planPath);
  const planContainment = relative(realRoot, candidatePlanPath);
  if (planContainment === "" || planContainment.startsWith("..") || isAbsolute(planContainment)) {
    return {
      ok: false,
      code: "PATH_ESCAPE",
      message: `plan path ${input.planPath} resolves outside the workspace root`,
    };
  }
  if (isSpecArchivePath(candidatePlanPath.replace(/\\/g, "/"))) {
    return {
      ok: false,
      code: "ARCHIVED_PLAN",
      message: `plan path ${input.planPath} sits inside an archive directory; archived plans are immutable history`,
    };
  }

  let planStat: Awaited<ReturnType<typeof stat>>;
  try {
    planStat = await stat(candidatePlanPath);
  } catch (error) {
    return {
      ok: false,
      code: "PLAN_NOT_FOUND",
      message: `plan file ${candidatePlanPath} cannot be read: ${(error as Error).message}`,
    };
  }
  if (!planStat.isFile()) {
    return {
      ok: false,
      code: "NOT_REGULAR_FILE",
      message: `plan path ${candidatePlanPath} is not a regular file`,
    };
  }

  const planContent = await readFile(candidatePlanPath, "utf8");
  const parsedPlan = parseSpecXml(planContent, candidatePlanPath);
  if (parsedPlan.findings.some((finding) => finding.severity === "error")) {
    return {
      ok: false,
      code: "PARSE_ERROR",
      message: parsedPlan.findings
        .filter((finding) => finding.severity === "error")
        .map((finding) => finding.message)
        .join("; "),
    };
  }
  if (!parsedPlan.root || parsedPlan.root.name !== "plan") {
    return {
      ok: false,
      code: "NOT_A_PLAN",
      message: `root element is not <plan>: ${parsedPlan.root?.name ?? "(none)"}`,
    };
  }

  const statusOf = (root: NonNullable<typeof parsedPlan.root>): string => {
    const statusNode = root.children.find((child) => child.name === "status");
    return statusNode ? statusNode.text.trim() : "";
  };
  const planStatus = statusOf(parsedPlan.root);
  if (planStatus !== "approved") {
    return {
      ok: false,
      code: "STATUS_NOT_APPROVED",
      message: `plan status is "${planStatus}", not approved`,
    };
  }

  const specRefNode = parsedPlan.root.children.find((child) => child.name === "spec");
  const specRef = specRefNode ? specRefNode.text.trim() : "";
  if (!specRef) {
    return {
      ok: false,
      code: "SPEC_MISSING",
      message: "plan declares an empty <spec> reference",
    };
  }
  const candidateSpecPath = isAbsolute(specRef)
    ? specRef
    : resolve(dirname(candidatePlanPath), specRef);
  const specContainment = relative(realRoot, candidateSpecPath);
  if (specContainment === "" || specContainment.startsWith("..") || isAbsolute(specContainment)) {
    return {
      ok: false,
      code: "SPEC_PATH_ESCAPE",
      message: `linked spec ${specRef} resolves outside the workspace root`,
    };
  }

  let specStat: Awaited<ReturnType<typeof stat>>;
  try {
    specStat = await stat(candidateSpecPath);
  } catch (error) {
    return {
      ok: false,
      code: "SPEC_MISSING",
      message: `linked spec file ${candidateSpecPath} cannot be read: ${(error as Error).message}`,
    };
  }
  if (!specStat.isFile()) {
    return {
      ok: false,
      code: "SPEC_MISSING",
      message: `linked spec path ${candidateSpecPath} is not a regular file`,
    };
  }

  const specContent = await readFile(candidateSpecPath, "utf8");
  const parsedSpec = parseSpecXml(specContent, candidateSpecPath);
  if (!parsedSpec.root || parsedSpec.root.name !== "spec") {
    return {
      ok: false,
      code: "SPEC_MISSING",
      message: `linked spec root element is not <spec>: ${parsedSpec.root?.name ?? "(none)"}`,
    };
  }
  const specStatus = statusOf(parsedSpec.root);
  if (specStatus !== "approved") {
    return {
      ok: false,
      code: "SPEC_NOT_APPROVED",
      message: `linked spec status is "${specStatus}", not approved`,
    };
  }

  const verdicts = lintSpecArtifacts([
    { file: candidateSpecPath, content: specContent },
    { file: candidatePlanPath, content: planContent },
  ]);
  const lintErrors = verdicts.flatMap((verdict) =>
    verdict.findings
      .filter((finding) => finding.severity === "error")
      .map((finding) => finding.message),
  );
  if (lintErrors.length > 0) {
    return {
      ok: false,
      code: "LINT_FAILED",
      message: lintErrors.join("; "),
    };
  }

  const extraction = extractDelegatedPlanDefinition(planContent, candidatePlanPath);
  if (!extraction.ok) {
    return {
      ok: false,
      code: "NOT_DELEGATED",
      message: extraction.errors.join("; "),
    };
  }

  return {
    ok: true,
    plan: {
      planPath: candidatePlanPath,
      specPath: candidateSpecPath,
      workspaceRoot: realRoot,
      planSha256: contentSha256(planContent),
      specSha256: contentSha256(specContent),
      definition: extraction.definition,
    },
  };
}
