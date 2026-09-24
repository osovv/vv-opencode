// FILE: src/lib/workflow-contract.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Dependency-free common execution contract for native-package, provided-plan, and conversation-scoped workflow runs: canonical work-item/reviewer/authority enums, declared-path normalization, bounded task/checkpoint/boundary contracts, explicit reviewer sets, exact-reference DAG validation, lineage/revision records, and authority/stage provenance shapes.
//   SCOPE: Pure path normalization, bounded identity/text validation, canonical enum constants shared by tool schemas and domain owners, explicit reviewer-set normalization, execution boundary containment (with boundary-reporting containment failures), task and checkpoint contract validation, exact reference and acyclic dependency checks, native definition adaptation into common contracts, and structural source/lineage/authority record types. No filesystem access, native XML parsing, SDK transport, task dispatch, or persistence.
//   DEPENDS: [] (deliberately dependency-free so the native adapter and the generic runtime share one contract without a cycle)
//   LINKS: [M-WORKFLOW-CONTRACT, M-SPEC-LINT, M-WORKFLOW-EXECUTION, M-WORKFLOW-AUTHORITY, M-WORKFLOW-STATE, M-WORKFLOW-TOOLING]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WORKFLOW_CONTRACT_VERSION - Rule-set version for the common execution contract.
//   WORKFLOW_ID_MAX_CHARS - Maximum accepted workflow identity length.
//   WORKFLOW_TEXT_MAX_CHARS - Maximum accepted bounded contract text length.
//   WORKFLOW_TEXT_MAX_ITEMS - Maximum accepted list length inside one contract field.
//   WORK_ITEM_MODES - Canonical work-item intent values accepted by work_item_open.
//   REVIEWER_ROLES - Canonical independent reviewer roles accepted across workflow inputs.
//   AUTHORITY_STAGES - Canonical delegatable lifecycle stages for advance authority.
//   WorkflowReviewer - Canonical independent reviewer role.
//   WorkflowObligationOrigin - Where a registered obligation came from (source, user, controller).
//   DelegatedReviewer - Canonical delegated checkpoint reviewer roles (spec, code).
//   DelegatedTaskDefinition - Native-extracted task obligation with declared write scope and optional lifted contract text.
//   DelegatedCheckpointDefinition - Native-extracted review checkpoint obligation.
//   DelegatedPlanDefinition - Native typed obligations extracted from a delegated execution section.
//   DelegatedPlanExtractionResult - Success payload or error list returned by native delegated extraction.
//   DeclaredScopePathResult - Normalized workspace-relative path or a rejection reason.
//   normalizeDeclaredScopePath - Text-level canonical normalization for declared scope file paths.
//   normalizeDeclaredDirectoryPath - Text-level normalization for declared directory subtrees.
//   normalizeReviewerSet - Explicit reviewer array normalization; absent or malformed returns undefined.
//   NativePlanMetadata - Structural native definition shape accepted by the common adapter.
//   WorkflowTaskContract - Bounded generic task contract with explicit dependency and reviewer references.
//   WorkflowCheckpointContract - Bounded generic checkpoint obligation with explicit coverage and reviewers.
//   WorkflowExecutionBoundary - Normalized exact files plus explicitly named directory subtrees.
//   WorkflowExecutionSource - Immutable discriminated source identity for one execution.
//   WorkflowExecutionState - Lifecycle of the common execution registry entry.
//   WorkflowExecutionRevision - Monotonic contract revision number.
//   WorkflowLineageKind - Explicit replacement/split lineage classification.
//   WorkflowLineageEntry - One recorded amendment/replacement lineage event.
//   WorkflowAuthorityStage - Delegatable lifecycle stages for advance authority.
//   WorkflowAuthorityProvenance - Truthful origin of a stage approval.
//   WorkflowAuthorityScope - Bounded decision, stage, and file boundary of an authority grant.
//   WorkflowAuthorityExtension - One explicit finite extension of existing authority.
//   WorkflowAuthorityRevocation - Fail-safe narrowing/revocation of future authority use.
//   WorkflowAuthorityRecord - Advance-authority record with finite shared reserve metadata.
//   WorkflowStageApproval - Recorded stage approval bound to an approved artifact hash.
//   WorkflowReserveDebit - One consumed unit of the shared advance-recovery reserve.
//   WorkflowMessageClaim - Session-wide claim that one root-user message already funded a grant.
//   WorkflowContractProblem - One deterministic contract validation problem, with an optional indexed path.
//   WorkflowContractValidation - Validation result carrying a value or deterministic problems.
//   isBoundedWorkflowId - Whether a value is a bounded explicit workflow identity.
//   isPathInExecutionBoundary - Whether a normalized path is contained in an execution boundary.
//   validateWorkflowTaskContract - Validate one generic task contract.
//   validateWorkflowCheckpointContract - Validate one generic checkpoint contract.
//   validateExecutionBoundary - Validate and normalize exact files plus directory subtrees.
//   validateWorkflowContractGraph - Validate unique ids, exact references, containment, and acyclicity.
//   taskContractsFromNativeDefinition - Adapt native task obligations into common task contracts.
//   checkpointContractsFromNativeDefinition - Adapt native checkpoints into common checkpoint contracts.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-002 - Added canonical work-item mode, reviewer role, and authority stage enum constants for schema/domain reuse, made OUT_OF_BOUNDARY containment failures report the offending scope together with the applicable declared boundary, and gave boundary problems precise indexed paths with bounded value previews.]
// END_CHANGE_SUMMARY

// START_BLOCK_CONTRACT_CONSTANTS
export const WORKFLOW_CONTRACT_VERSION = 1;
export const WORKFLOW_ID_MAX_CHARS = 128;
export const WORKFLOW_TEXT_MAX_CHARS = 2000;
export const WORKFLOW_TEXT_MAX_ITEMS = 64;

/** Canonical work-item intent values accepted by work_item_open. */
export const WORK_ITEM_MODES = ["implementation", "review_only", "delegated"] as const;

/** Canonical independent reviewer roles accepted across workflow inputs. */
export const REVIEWER_ROLES = ["spec", "code"] as const;

/** Canonical delegatable lifecycle stages for advance authority. */
export const AUTHORITY_STAGES = [
  "specification",
  "planning",
  "implementation",
  "verification",
] as const;
// END_BLOCK_CONTRACT_CONSTANTS

// START_BLOCK_SCOPE_PATH_NORMALIZATION
/** Normalized workspace-relative path, or the reason a declared path is malformed. */
export type DeclaredScopePathResult = { ok: true; path: string } | { ok: false; reason: string };

/**
 * Text-level canonical normalization for declared scope file paths. The linter
 * and the runtime snapshot fingerprint share this representation so a plan that
 * lints clean cannot declare paths the runtime normalizer rejects on sight.
 * Filesystem-specific checks (existence, symlinks, regular files) stay in the
 * runtime normalizer; this function is deliberately pure.
 */
export function normalizeDeclaredScopePath(raw: string): DeclaredScopePathResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "empty path" };
  if (trimmed.includes("\\")) return { ok: false, reason: "backslash separator" };
  if (trimmed.startsWith("/")) return { ok: false, reason: "absolute path" };
  if (/^[A-Za-z]:/.test(trimmed)) return { ok: false, reason: "drive-absolute path" };
  if (trimmed.startsWith("~")) return { ok: false, reason: "home-relative path" };
  if (/[*?[\]]/.test(trimmed)) return { ok: false, reason: "wildcard characters" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { ok: false, reason: "control characters" };
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment === "") return { ok: false, reason: "empty path segment" };
    if (segment === "." || segment === "..") return { ok: false, reason: "traversal segment" };
  }
  return { ok: true, path: segments.join("/") };
}

/**
 * Normalize a declared directory subtree. Identical traversal and wildcard
 * rejection as file paths, but one trailing separator is allowed and removed so
 * an explicitly named subtree can never be normalized into an empty segment.
 */
export function normalizeDeclaredDirectoryPath(raw: string): DeclaredScopePathResult {
  const trimmed = raw.trim();
  const withoutTrailing = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  if (withoutTrailing === "") return { ok: false, reason: "empty path" };
  return normalizeDeclaredScopePath(withoutTrailing);
}
// END_BLOCK_SCOPE_PATH_NORMALIZATION

// START_BLOCK_NATIVE_DEFINITION_TYPES
/** Canonical reviewer roles accepted inside a delegated checkpoint's reviewer set. */
export type DelegatedReviewer = "spec" | "code";

/** Typed delegated obligation for one declared plan task. */
export interface DelegatedTaskDefinition {
  /** Canonical task id used by depends_on and checkpoint coverage (e.g. "T-001"). */
  taskId: string;
  /** Declaring identity element name (e.g. "TASK-T-001"). */
  taskElement: string;
  /** Declaring wave id in document order (e.g. "WAVE-1"). */
  wave: string;
  /** Normalized workspace-relative write scope files declared for the task. */
  writeScope: string[];
  /** Declared task title lifted from the validated source, when present. */
  title?: string;
  /** Declared acceptance criterion texts lifted from the validated source. */
  acceptance?: string[];
  /** Declared verification command texts lifted from the validated source. */
  verification?: string[];
  /** Declared task dependency ids lifted from the validated source. */
  dependsOn?: string[];
}

/** Typed delegated obligation for one declared review checkpoint. */
export interface DelegatedCheckpointDefinition {
  /** Declared checkpoint identity (e.g. "CHECKPOINT-R-001"). */
  checkpointId: string;
  kind: "milestone" | "final";
  /** Wave barrier that must be accepted before the checkpoint may start. */
  afterWave: string;
  /** Canonical task ids covered by the checkpoint. */
  covers: string[];
  /** Normalized workspace-relative files reviewed by the checkpoint. */
  scope: string[];
  /** Declared reviewer roles; every role must pass for the checkpoint to pass. */
  reviewers: DelegatedReviewer[];
  /** Acceptance criterion texts recorded in the plan. */
  acceptance: string[];
  /** Verification command texts recorded in the plan. */
  verification: string[];
}

/** Typed obligations extracted from a plan's delegated execution section. */
export interface DelegatedPlanDefinition {
  mode: "delegated";
  /** Declared wave ids in document order. */
  waves: string[];
  tasks: DelegatedTaskDefinition[];
  checkpoints: DelegatedCheckpointDefinition[];
}

/** Either a typed delegated definition or the collected validation errors. */
export type DelegatedPlanExtractionResult =
  | { ok: true; definition: DelegatedPlanDefinition }
  | { ok: false; errors: string[] };
// END_BLOCK_NATIVE_DEFINITION_TYPES

// START_BLOCK_COMMON_TYPES
export type WorkflowReviewer = DelegatedReviewer;

/** Where a registered obligation came from: the selected source, the user, or the controller. */
export type WorkflowObligationOrigin = "source" | "user" | "controller";

/** Structural native definition shape accepted by the common adapter. */
export interface NativePlanMetadata {
  mode: "delegated";
  waves: string[];
  tasks: DelegatedTaskDefinition[];
  checkpoints: DelegatedCheckpointDefinition[];
}

/** Bounded generic task contract with explicit dependencies, scope, and reviewer set. */
export interface WorkflowTaskContract {
  taskId: string;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  verification: string[];
  /** Normalized workspace-relative exact files the task may write. */
  writeScope: string[];
  /** Task ids that must be accepted before this task may launch. */
  dependsOn: string[];
  /** Checkpoint ids that must pass before this task may launch. */
  blockedBy: string[];
  /** Explicit reviewer set; [] deliberately means no independent review. */
  requiredReviewers: WorkflowReviewer[];
}

/** Bounded generic checkpoint obligation with explicit coverage and reviewer set. */
export interface WorkflowCheckpointContract {
  checkpointId: string;
  kind: "milestone" | "final";
  /** Task ids covered by the checkpoint. */
  covers: string[];
  /** Normalized workspace-relative exact files under review. */
  scope: string[];
  /** Explicit reviewer set; a checkpoint with an empty set is invalid. */
  requiredReviewers: WorkflowReviewer[];
  acceptance: string[];
  verification: string[];
  origin: WorkflowObligationOrigin;
  /** Checkpoint ids that must pass before this checkpoint may start. */
  dependsOn: string[];
}

/** Normalized exact files plus explicitly named directory subtrees. */
export interface WorkflowExecutionBoundary {
  files: string[];
  directories: string[];
}

export type WorkflowExecutionSource =
  | {
      kind: "native-package";
      planPath: string;
      specPath: string;
      planSha256: string;
      specSha256: string;
      definition: NativePlanMetadata;
    }
  | { kind: "provided-plan"; reference: string; sha256?: string }
  | { kind: "conversation-scoped" };

export type WorkflowExecutionState = "preparing" | "active" | "sealed";

/** Monotonic contract revision number for one execution. */
export type WorkflowExecutionRevision = number;

export type WorkflowLineageKind = "initial" | "amendment" | "replacement" | "split";

/** One recorded amendment/replacement/split lineage event. */
export interface WorkflowLineageEntry {
  lineageId: string;
  kind: WorkflowLineageKind;
  amendmentId: string;
  parentTaskId?: string;
  childTaskIds: string[];
  previousRevision: WorkflowExecutionRevision;
  newRevision: WorkflowExecutionRevision;
  rationale: string;
  createdAt: string;
}

/** Lifecycle stages that advance authority may cover. */
export type WorkflowAuthorityStage =
  | "specification"
  | "planning"
  | "implementation"
  | "verification";

export type WorkflowAuthorityProvenance = "controller_delegated" | "user_observed" | "unspecified";

/** Bounded decision, stage, and file boundary of one authority grant. */
export interface WorkflowAuthorityScope {
  stages: WorkflowAuthorityStage[];
  decisionScope: string;
  fileBoundary: string[];
  reservedStops: WorkflowAuthorityStage[];
}

export interface WorkflowAuthorityExtension {
  extensionId: string;
  messageId: string;
  messageCreatedMs: number;
  units: number;
  createdAt: string;
}

export interface WorkflowAuthorityRevocation {
  revocationId: string;
  /** "narrow" disables out-of-scope credits; "revoke" disables all future credits. */
  kind: "narrow" | "revoke";
  reason: string;
  /** Surviving stages after a narrowing; absent for a full revocation. */
  narrowedStages?: WorkflowAuthorityStage[];
  revokedAt: string;
}

/** Advance-authority record with its finite shared reserve metadata. */
export interface WorkflowAuthorityRecord {
  authorityId: string;
  /** Owning common execution; a second initial grant for the same run cannot add reserve. */
  runId: string;
  rootSessionId: string;
  grantedByMessageId: string;
  messageCreatedMs: number;
  scope: WorkflowAuthorityScope;
  initialUnits: number;
  extensions: WorkflowAuthorityExtension[];
  revocations: WorkflowAuthorityRevocation[];
  createdAt: string;
}

/** Recorded stage approval bound to an approved artifact hash and provenance. */
export interface WorkflowStageApproval {
  approvalId: string;
  authorityId: string;
  stage: WorkflowAuthorityStage;
  artifactPath: string;
  artifactSha256: string;
  provenance: WorkflowAuthorityProvenance;
  recordedAt: string;
}

/** One consumed unit of the shared advance-recovery reserve, bound to its exact target. */
export interface WorkflowReserveDebit {
  recoveryId: string;
  authorityId: string;
  targetKind: "task" | "checkpoint";
  targetId: string;
  units: number;
  debitedAt: string;
}

/** Session-wide claim that one root-user message already funded an authority grant. */
export interface WorkflowMessageClaim {
  messageId: string;
  runId: string;
  authorityId: string;
  claimedAt: string;
}
// END_BLOCK_COMMON_TYPES

// START_BLOCK_CONTRACT_VALIDATION_TYPES
export interface WorkflowContractProblem {
  code: string;
  message: string;
  /**
   * Tokenized field/index path of the offending value when it applies to one
   * element (e.g. ["boundary", "files", 0]); absent when the problem applies to
   * the whole value rather than a single indexed element.
   */
  path?: readonly (string | number)[];
}

export type WorkflowContractValidation<T> =
  | { ok: true; value: T }
  | { ok: false; problems: WorkflowContractProblem[] };
// END_BLOCK_CONTRACT_VALIDATION_TYPES

// START_BLOCK_ID_AND_TEXT_HELPERS
const BOUNDED_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/** Whether a value is a bounded explicit workflow identity (not a native-only pattern). */
export function isBoundedWorkflowId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > WORKFLOW_ID_MAX_CHARS) return false;
  return BOUNDED_ID_PATTERN.test(trimmed);
}

function boundedText(value: unknown, field: string, problems: WorkflowContractProblem[]): string {
  if (typeof value !== "string") {
    problems.push({ code: "INVALID_TEXT", message: `${field} must be a string` });
    return "";
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    problems.push({ code: "EMPTY_TEXT", message: `${field} must be non-empty` });
    return "";
  }
  if (trimmed.length > WORKFLOW_TEXT_MAX_CHARS) {
    problems.push({
      code: "TEXT_TOO_LONG",
      message: `${field} exceeds ${WORKFLOW_TEXT_MAX_CHARS} characters`,
    });
    return "";
  }
  return trimmed;
}

function boundedTextList(
  value: unknown,
  field: string,
  problems: WorkflowContractProblem[],
  options: { allowEmpty: boolean } = { allowEmpty: true },
): string[] {
  if (value === undefined || value === null) {
    if (options.allowEmpty) return [];
    problems.push({ code: "MISSING_LIST", message: `${field} is required` });
    return [];
  }
  if (!Array.isArray(value)) {
    problems.push({ code: "INVALID_LIST", message: `${field} must be an array` });
    return [];
  }
  if (value.length > WORKFLOW_TEXT_MAX_ITEMS) {
    problems.push({
      code: "LIST_TOO_LONG",
      message: `${field} declares more than ${WORKFLOW_TEXT_MAX_ITEMS} entries`,
    });
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      problems.push({
        code: "INVALID_TEXT",
        message: `${field} entries must be non-empty strings`,
      });
      return [];
    }
    const trimmed = entry.trim();
    if (trimmed.length > WORKFLOW_TEXT_MAX_CHARS) {
      problems.push({
        code: "TEXT_TOO_LONG",
        message: `${field} entry exceeds ${WORKFLOW_TEXT_MAX_CHARS} characters`,
      });
      return [];
    }
    out.push(trimmed);
  }
  return out;
}
// END_BLOCK_ID_AND_TEXT_HELPERS

// START_BLOCK_REVIEWER_NORMALIZATION
function isWorkflowReviewer(value: unknown): value is WorkflowReviewer {
  return value === "spec" || value === "code";
}

/**
 * Normalize an explicit reviewer array. Absent, non-array, malformed, or
 * duplicate-bearing input returns undefined so callers cannot silently turn a
 * missing or invalid declaration into "no review". An explicit empty array is
 * preserved as [] because it deliberately means no independent review.
 */
export function normalizeReviewerSet(value: unknown): WorkflowReviewer[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!value.every(isWorkflowReviewer)) return undefined;
  const unique = new Set(value);
  if (unique.size !== value.length) return undefined;
  return [...value].sort((left, right) => (left === right ? 0 : left === "spec" ? -1 : 1));
}
// END_BLOCK_REVIEWER_NORMALIZATION

// START_BLOCK_BOUNDARY_VALIDATION
/** Bounded preview of one offending value; never echoes an unbounded payload. */
const DIAGNOSTIC_PREVIEW_MAX_CHARS = 64;
function previewValue(value: unknown): string {
  const json = JSON.stringify(value);
  const text = json === undefined ? String(value) : json;
  return text.length <= DIAGNOSTIC_PREVIEW_MAX_CHARS
    ? text
    : `${text.slice(0, DIAGNOSTIC_PREVIEW_MAX_CHARS - 1)}…`;
}

function normalizeUniquePaths(
  raw: unknown,
  field: string,
  normalize: (value: string) => DeclaredScopePathResult,
  problems: WorkflowContractProblem[],
  pathBase: readonly (string | number)[] = [],
): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push({
      code: "INVALID_LIST",
      message: `${field} must be an array`,
      path: [...pathBase],
    });
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const entry: unknown = raw[index];
    if (typeof entry !== "string") {
      problems.push({
        code: "INVALID_PATH",
        message: `${field} entries must be strings`,
        path: [...pathBase, index],
      });
      return [];
    }
    const normalized = normalize(entry);
    if (!normalized.ok) {
      problems.push({
        code: "INVALID_PATH",
        message: `${field} path ${previewValue(entry)} is malformed (${normalized.reason})`,
        path: [...pathBase, index],
      });
      return [];
    }
    if (seen.has(normalized.path)) {
      problems.push({
        code: "DUPLICATE_PATH",
        message: `${field} path ${previewValue(normalized.path)} is declared more than once`,
        path: [...pathBase, index],
      });
      return [];
    }
    seen.add(normalized.path);
    out.push(normalized.path);
  }
  return out;
}

/** Validate and normalize exact files plus explicitly named directory subtrees. */
export function validateExecutionBoundary(
  raw: unknown,
): WorkflowContractValidation<WorkflowExecutionBoundary> {
  const problems: WorkflowContractProblem[] = [];
  if (raw === null || typeof raw !== "object") {
    return {
      ok: false,
      problems: [
        {
          code: "INVALID_BOUNDARY",
          message: "execution boundary must be an object",
          path: ["boundary"],
        },
      ],
    };
  }
  const candidate = raw as { files?: unknown; directories?: unknown };
  const files = normalizeUniquePaths(
    candidate.files,
    "boundary.files",
    normalizeDeclaredScopePath,
    problems,
    ["boundary", "files"],
  );
  const directories = normalizeUniquePaths(
    candidate.directories,
    "boundary.directories",
    normalizeDeclaredDirectoryPath,
    problems,
    ["boundary", "directories"],
  );
  if (problems.length > 0) return { ok: false, problems };
  if (files.length === 0 && directories.length === 0) {
    return {
      ok: false,
      problems: [
        {
          code: "EMPTY_BOUNDARY",
          message: "execution boundary declares no files or directories",
          path: ["boundary"],
        },
      ],
    };
  }
  return { ok: true, value: { files, directories } };
}

/** Whether a normalized path is contained in a normalized execution boundary. */
export function isPathInExecutionBoundary(
  path: string,
  boundary: WorkflowExecutionBoundary,
): boolean {
  if (boundary.files.includes(path)) return true;
  return boundary.directories.some((directory) => path.startsWith(`${directory}/`));
}

/** Bounded one-line summary of a declared boundary for containment diagnostics. */
function describeExecutionBoundary(boundary: WorkflowExecutionBoundary): string {
  const summarize = (entries: readonly string[]): string =>
    entries.length <= 8
      ? entries.join(", ")
      : `${entries.slice(0, 8).join(", ")}, …(+${entries.length - 8})`;
  const files = boundary.files.length > 0 ? summarize(boundary.files) : "(none)";
  const directories = boundary.directories.length > 0 ? summarize(boundary.directories) : "(none)";
  return `files: ${files}; directories: ${directories}`;
}
// END_BLOCK_BOUNDARY_VALIDATION

// START_BLOCK_TASK_VALIDATION
function normalizeBoundaryFiles(
  raw: unknown,
  field: string,
  problems: WorkflowContractProblem[],
  options: { allowEmpty: boolean },
): string[] {
  if (raw === undefined || raw === null) {
    if (options.allowEmpty) return [];
    problems.push({ code: "MISSING_LIST", message: `${field} is required` });
    return [];
  }
  if (!Array.isArray(raw)) {
    problems.push({ code: "INVALID_LIST", message: `${field} must be an array` });
    return [];
  }
  if (raw.length === 0) {
    if (options.allowEmpty) return [];
    problems.push({ code: "EMPTY_LIST", message: `${field} must declare at least one entry` });
    return [];
  }
  return normalizeUniquePaths(raw, field, normalizeDeclaredScopePath, problems);
}

function normalizeIdList(
  raw: unknown,
  field: string,
  problems: WorkflowContractProblem[],
): string[] {
  const values = boundedTextList(raw, field, problems);
  const unique = new Set<string>();
  for (const value of values) {
    if (!isBoundedWorkflowId(value)) {
      problems.push({
        code: "INVALID_ID",
        message: `${field} entry ${JSON.stringify(value)} is not a bounded id`,
      });
      return [];
    }
    if (unique.has(value)) {
      problems.push({
        code: "DUPLICATE_ID",
        message: `${field} entry ${JSON.stringify(value)} is repeated`,
      });
      return [];
    }
    unique.add(value);
  }
  return values;
}

/** Validate one generic task contract. */
export function validateWorkflowTaskContract(
  raw: unknown,
): WorkflowContractValidation<WorkflowTaskContract> {
  const problems: WorkflowContractProblem[] = [];
  if (raw === null || typeof raw !== "object") {
    return {
      ok: false,
      problems: [{ code: "INVALID_TASK", message: "task contract must be an object" }],
    };
  }
  const candidate = raw as Record<string, unknown>;
  if (!isBoundedWorkflowId(candidate.taskId)) {
    problems.push({ code: "INVALID_ID", message: "taskId must be a bounded workflow identity" });
  }
  const title = boundedText(candidate.title, "title", problems);
  const goal = boundedText(candidate.goal, "goal", problems);
  const acceptanceCriteria = boundedTextList(
    candidate.acceptanceCriteria,
    "acceptanceCriteria",
    problems,
  );
  const verification = boundedTextList(candidate.verification, "verification", problems);
  const writeScope = normalizeBoundaryFiles(candidate.writeScope, "writeScope", problems, {
    allowEmpty: false,
  });
  const dependsOn = normalizeIdList(candidate.dependsOn, "dependsOn", problems);
  const blockedBy = normalizeIdList(candidate.blockedBy, "blockedBy", problems);

  let requiredReviewers: WorkflowReviewer[] = [];
  if (candidate.requiredReviewers === undefined) {
    problems.push({
      code: "MISSING_REVIEWERS",
      message: "requiredReviewers must be declared explicitly (use [] for no independent review)",
    });
  } else {
    const normalized = normalizeReviewerSet(candidate.requiredReviewers);
    if (!normalized) {
      problems.push({
        code: "INVALID_REVIEWERS",
        message: "requiredReviewers must be a canonical spec/code set with no duplicates",
      });
    } else {
      requiredReviewers = normalized;
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: {
      taskId: candidate.taskId as string,
      title,
      goal,
      acceptanceCriteria,
      verification,
      writeScope,
      dependsOn,
      blockedBy,
      requiredReviewers,
    },
  };
}
// END_BLOCK_TASK_VALIDATION

// START_BLOCK_CHECKPOINT_VALIDATION
function isObligationOrigin(value: unknown): value is WorkflowObligationOrigin {
  return value === "source" || value === "user" || value === "controller";
}

/** Validate one generic checkpoint contract. */
export function validateWorkflowCheckpointContract(
  raw: unknown,
): WorkflowContractValidation<WorkflowCheckpointContract> {
  const problems: WorkflowContractProblem[] = [];
  if (raw === null || typeof raw !== "object") {
    return {
      ok: false,
      problems: [{ code: "INVALID_CHECKPOINT", message: "checkpoint contract must be an object" }],
    };
  }
  const candidate = raw as Record<string, unknown>;
  if (!isBoundedWorkflowId(candidate.checkpointId)) {
    problems.push({
      code: "INVALID_ID",
      message: "checkpointId must be a bounded workflow identity",
    });
  }
  const kind =
    candidate.kind === "final" ? "final" : candidate.kind === "milestone" ? "milestone" : undefined;
  if (!kind) {
    problems.push({ code: "INVALID_KIND", message: "kind must be milestone or final" });
  }
  const covers = normalizeIdList(candidate.covers, "covers", problems);
  if (covers.length === 0) {
    problems.push({ code: "EMPTY_COVERS", message: "covers must declare at least one task id" });
  }
  const scope = normalizeBoundaryFiles(candidate.scope, "scope", problems, { allowEmpty: true });
  const acceptance = boundedTextList(candidate.acceptance, "acceptance", problems);
  const verification = boundedTextList(candidate.verification, "verification", problems);
  const dependsOn = normalizeIdList(candidate.dependsOn, "dependsOn", problems);

  let requiredReviewers: WorkflowReviewer[] = [];
  const normalized = normalizeReviewerSet(candidate.requiredReviewers);
  if (!normalized || normalized.length === 0) {
    problems.push({
      code: "INVALID_REVIEWERS",
      message:
        "an assigned checkpoint requires a non-empty canonical spec/code reviewer set; represent no review with no checkpoint",
    });
  } else {
    requiredReviewers = normalized;
  }

  let origin: WorkflowObligationOrigin = "source";
  if (!isObligationOrigin(candidate.origin)) {
    problems.push({
      code: "INVALID_ORIGIN",
      message: "origin must be source, user, or controller",
    });
  } else {
    origin = candidate.origin;
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    value: {
      checkpointId: candidate.checkpointId as string,
      kind: kind as "milestone" | "final",
      covers,
      scope,
      requiredReviewers,
      acceptance,
      verification,
      origin,
      dependsOn,
    },
  };
}
// END_BLOCK_CHECKPOINT_VALIDATION

// START_BLOCK_GRAPH_VALIDATION
function detectCycle(adjacency: Map<string, string[]>): string[] | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  let cycle: string[] | undefined;

  const visit = (node: string): void => {
    if (cycle) return;
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      cycle = [...stack.slice(start), node];
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) visit(next);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };

  for (const node of adjacency.keys()) visit(node);
  return cycle;
}

function exactReference(
  reference: string,
  known: Set<string>,
  field: string,
  owner: string,
  problems: WorkflowContractProblem[],
): void {
  if (!known.has(reference)) {
    problems.push({
      code: "UNKNOWN_REFERENCE",
      message: `${owner} ${field} references unknown identity ${JSON.stringify(reference)}`,
    });
  }
}

/**
 * Validate unique ids, exact references, boundary containment, and acyclicity
 * across tasks and checkpoints. Same-batch references are validated before any
 * caller publishes an item or key index.
 */
export function validateWorkflowContractGraph(graph: {
  tasks: readonly WorkflowTaskContract[];
  checkpoints: readonly WorkflowCheckpointContract[];
  boundary: WorkflowExecutionBoundary;
}): WorkflowContractValidation<{
  tasks: WorkflowTaskContract[];
  checkpoints: WorkflowCheckpointContract[];
}> {
  const problems: WorkflowContractProblem[] = [];
  const taskIds = new Set<string>();
  const allIds = new Set<string>();

  for (const task of graph.tasks) {
    if (allIds.has(task.taskId)) {
      problems.push({
        code: "DUPLICATE_ID",
        message: `task id ${JSON.stringify(task.taskId)} is declared more than once`,
      });
    }
    allIds.add(task.taskId);
    taskIds.add(task.taskId);
  }
  const checkpointIds = new Set<string>();
  for (const checkpoint of graph.checkpoints) {
    if (allIds.has(checkpoint.checkpointId)) {
      problems.push({
        code: "DUPLICATE_ID",
        message: `identity ${JSON.stringify(checkpoint.checkpointId)} collides with another task or checkpoint`,
      });
    }
    allIds.add(checkpoint.checkpointId);
    checkpointIds.add(checkpoint.checkpointId);
  }

  for (const task of graph.tasks) {
    for (const dependency of task.dependsOn) {
      exactReference(dependency, taskIds, "dependsOn", `task ${task.taskId}`, problems);
    }
    for (const barrier of task.blockedBy) {
      exactReference(barrier, checkpointIds, "blockedBy", `task ${task.taskId}`, problems);
    }
    for (const path of task.writeScope) {
      if (!isPathInExecutionBoundary(path, graph.boundary)) {
        problems.push({
          code: "OUT_OF_BOUNDARY",
          message: `task ${task.taskId} writeScope ${JSON.stringify(path)} is outside the execution boundary (declared ${describeExecutionBoundary(graph.boundary)})`,
        });
      }
    }
  }

  for (const checkpoint of graph.checkpoints) {
    if (checkpoint.covers.length === 0) {
      problems.push({
        code: "EMPTY_COVERS",
        message: `checkpoint ${checkpoint.checkpointId} covers no tasks`,
      });
    }
    for (const covered of checkpoint.covers) {
      exactReference(covered, taskIds, "covers", `checkpoint ${checkpoint.checkpointId}`, problems);
    }
    for (const dependency of checkpoint.dependsOn) {
      exactReference(
        dependency,
        checkpointIds,
        "dependsOn",
        `checkpoint ${checkpoint.checkpointId}`,
        problems,
      );
    }
    for (const path of checkpoint.scope) {
      if (!isPathInExecutionBoundary(path, graph.boundary)) {
        problems.push({
          code: "OUT_OF_BOUNDARY",
          message: `checkpoint ${checkpoint.checkpointId} scope ${JSON.stringify(path)} is outside the execution boundary (declared ${describeExecutionBoundary(graph.boundary)})`,
        });
      }
    }
  }

  if (problems.length === 0) {
    const taskAdjacency = new Map<string, string[]>();
    for (const task of graph.tasks) {
      if (task.dependsOn.includes(task.taskId)) {
        problems.push({
          code: "SELF_REFERENCE",
          message: `task ${task.taskId} depends on itself`,
        });
        continue;
      }
      taskAdjacency.set(task.taskId, [...task.dependsOn]);
    }
    const taskCycle = detectCycle(taskAdjacency);
    if (taskCycle) {
      problems.push({
        code: "CYCLIC_DEPENDENCY",
        message: `task dependencies form a cycle: ${taskCycle.join(" -> ")}`,
      });
    }

    const checkpointAdjacency = new Map<string, string[]>();
    for (const checkpoint of graph.checkpoints) {
      if (checkpoint.dependsOn.includes(checkpoint.checkpointId)) {
        problems.push({
          code: "SELF_REFERENCE",
          message: `checkpoint ${checkpoint.checkpointId} depends on itself`,
        });
        continue;
      }
      // A checkpoint covering task T is implicitly gated by T's own task
      // dependencies only through declared blockedBy; keep the graph purely
      // structural here so callers own the enforcement order.
      checkpointAdjacency.set(checkpoint.checkpointId, [...checkpoint.dependsOn]);
    }
    const checkpointCycle = detectCycle(checkpointAdjacency);
    if (checkpointCycle) {
      problems.push({
        code: "CYCLIC_DEPENDENCY",
        message: `checkpoint dependencies form a cycle: ${checkpointCycle.join(" -> ")}`,
      });
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { tasks: [...graph.tasks], checkpoints: [...graph.checkpoints] } };
}
// END_BLOCK_GRAPH_VALIDATION

// START_BLOCK_NATIVE_ADAPTER
/**
 * Adapt native-extracted task obligations into common task contracts, lifting
 * acceptance/verification/dependency text from the validated source instead of
 * inventing generic requirements. The source's own wave barriers remain owned
 * by the native adapter and are not converted into per-task dependencies here.
 */
export function taskContractsFromNativeDefinition(
  definition: NativePlanMetadata,
): WorkflowTaskContract[] {
  const taskIds = new Set(definition.tasks.map((task) => task.taskId));
  return definition.tasks.map((task) => {
    const acceptance = (task.acceptance ?? []).map((entry) => entry.trim()).filter(Boolean);
    const verification = (task.verification ?? []).map((entry) => entry.trim()).filter(Boolean);
    const dependsOn = (task.dependsOn ?? [])
      .map((entry) => entry.trim())
      .filter((entry) => taskIds.has(entry));
    return {
      taskId: task.taskId,
      title: (task.title ?? task.taskId).trim() || task.taskId,
      goal: (task.title ?? task.taskId).trim() || task.taskId,
      acceptanceCriteria: acceptance,
      verification,
      writeScope: [...task.writeScope],
      dependsOn: [...new Set(dependsOn)],
      blockedBy: [],
      // Native task-level reviewer sets do not exist; native reviews are
      // checkpoint obligations, so the per-task set is explicitly empty.
      requiredReviewers: [],
    };
  });
}

/** Adapt native checkpoints into common checkpoint contracts with source origin. */
export function checkpointContractsFromNativeDefinition(
  definition: NativePlanMetadata,
  scope?: { origin?: WorkflowObligationOrigin; dependsOn?: string[] },
): WorkflowCheckpointContract[] {
  return definition.checkpoints.map((checkpoint) => ({
    checkpointId: checkpoint.checkpointId,
    kind: checkpoint.kind,
    covers: [...checkpoint.covers],
    scope: [...checkpoint.scope],
    requiredReviewers: [...checkpoint.reviewers],
    acceptance: [...checkpoint.acceptance],
    verification: [...checkpoint.verification],
    origin: scope?.origin ?? "source",
    dependsOn: [...(scope?.dependsOn ?? [])],
  }));
}
// END_BLOCK_NATIVE_ADAPTER
