// FILE: src/plugins/workflow/index.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Register the five workflow tools as native OpenCode 2.0.18 tools and enforce tracked launch/result/continuation/cancellation semantics through native tool and session hooks while injecting only startup-profile-compatible vv-controller guidance.
//   SCOPE: Native Plugin.define entry, work_item_open/list/close registration, profile-independent work_item_decide and work_checkpoint registration with root-session authorization and native session-backed authorization-message lookup, native tool input-schema publication plus early execute.before structural guards, tracked native subagent launch validation with delegated barriers and overlapping-write gates, authoritative native sealed-run rejection, live host-call bindings that convert supported foreground subagent launches into failed delegated attempts on confirmed host-terminal errors, native structured subagent result normalization with bounded same-child continuation, background terminal settlement from the native subagent synthetic delivery, callID-bound delegated attempt results, terminal settlement of protocol-invalid reports as report_rejected attempts through staged persistence, checkpoint reviewer bookkeeping, round aggregation, implementation round limits, checked persistence, and profile-selected session-context guidance. Tool argument schemas come from schemas.ts; branch-aware validation from input-validation.ts; the authorization guard and message lookups from authorization.ts; staged transactions and committed recovery from recovery.ts; native host shape decoding from host.ts; native cancellation evidence from cancellation.ts.
//   DEPENDS: [@opencode/plugin, zod (schemas), src/lib/agent-tool-contract.ts, src/lib/config-layers.ts, src/lib/orchestration.ts, src/lib/plugin-toggle-config.ts, src/plugins/workflow/authorization.ts, src/plugins/workflow/cancellation.ts, src/plugins/workflow/checkpoint-io.ts, src/plugins/workflow/checkpoints.ts, src/plugins/workflow/delegated.ts, src/plugins/workflow/host.ts, src/plugins/workflow/input-validation.ts, src/plugins/workflow/persistence.ts, src/plugins/workflow/protocol.ts, src/plugins/workflow/recovery.ts, src/plugins/workflow/repair.ts, src/plugins/workflow/results.ts, src/plugins/workflow/schemas.ts, src/plugins/workflow/state.ts, src/plugins/workflow/tooling.ts, src/plugins/workflow/transitions.ts]
//   LINKS: M-PLUGIN-WORKFLOW, M-ORCHESTRATION-PROFILES, M-WORKFLOW-PROTOCOL, M-WORKFLOW-REPAIR, M-WORKFLOW-STATE, M-WORKFLOW-TRANSITIONS, M-WORKFLOW-TOOLING, M-WORKFLOW-PERSISTENCE, M-WORKFLOW-DELEGATED, M-WORKFLOW-AUTHORITY, M-AGENT-TOOL-CONTRACT, V-M-PLUGIN-WORKFLOW
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WorkflowClient - Narrow authenticated full-client surface consumed by the plugin.
//   WorkflowRuntime - Narrow shared native runtime surface (snapshots/config/client/release).
//   WorkflowPluginOptions - Optional injectable runtime acquisition for tests.
//   createWorkflowPlugin - Plugin factory; the default export acquires the real native runtime.
//   WorkflowPlugin - Native Plugin.define object registering workflow work-item tools, profile-independent root-gated control tools, owned input-schema publication and execute.before guards, tracked native subagent protocol enforcement with callID-bound delegated attempts, bounded recovery with durable persist-and-rollback commits, terminal report-rejection settlement, checkpoint linkage, background completion settlement, evidence-gated explicit cancellation recovery, and primary-session workflow guidance injection.
//   default - Default export: the native WorkflowPlugin object.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE wi-7 attempt 2 - Tracked/delegated/reviewer launches are staged, persisted, then published so a failed write refuses before native execution and leaves attempt/budget/reviewer state intact; the event pump contains per-event handler failures with bounded diagnostics; a rejected lazy client acquisition is retried instead of cached forever; foreground bounded-continuation acquisition/repair failures are contained locally so the original-output report_rejected path settles instead of leaving the attempt in_flight.]
// END_CHANGE_SUMMARY

import { Plugin } from "@opencode/plugin";
import { z, type ZodTypeAny } from "zod";
import {
  attemptTrackedResultRepair,
  detectExplicitHardStopStatus,
  isTrackedResultRepairEligible,
  unwrapResumableTaskResult,
} from "./repair.js";
import {
  describeStatusVocabulary,
  parseResultBlock,
  parseWorkItemHeader,
  TRACKED_SUBAGENT_NAMES,
  type TrackedAgentName,
} from "./protocol.js";
import {
  applyTrackedResult,
  createRecordLookupKey,
  createWorkflowResultExcerpt,
  beginTrackedLaunch,
  createWorkItemStore,
  createWorkItemStoreView,
  getReviewRound,
  getWorkItem,
  revertReviewerLaunch,
  type WorkflowResultExcerpt,
  type WorkItemRecord,
  type WorkItemStore,
} from "./state.js";
import {
  runWorkflowTransaction,
  WorkflowTransactionQueue,
  type WorkflowMutation,
} from "./transactions.js";
import {
  applyDelegatedLaunchFailure,
  applyDelegatedReportRejection,
  applyDelegatedResult,
  beginDelegatedLaunch,
  summarizeDelegatedProgress,
} from "./delegated.js";
import {
  checkpointBarrierUnsatisfied,
  findOverlappingInFlightReview,
  recordCheckpointReviewerLaunch,
  recordCheckpointReviewerResult,
} from "./checkpoints.js";
import type { DelegatedPlanRun } from "./checkpoints.js";
import {
  getAllowedNextAgents,
  getAttemptedImplementationRound,
  getReviewerRoleForAgent,
  shouldBlockRound,
} from "./transitions.js";
import {
  createWorkItemCloseTool,
  createWorkItemDecideTool,
  createWorkItemListTool,
  createWorkItemOpenTool,
  createWorkCheckpointTool,
  type DelegatedControlOptions,
} from "./tooling.js";
import {
  isWorkflowToolId,
  validateWorkflowToolInput,
  workflowToolContracts,
} from "./input-validation.js";
import { ContractInputError } from "../../lib/agent-tool-contract.js";
import {
  normalizeWorkflowFailure,
  serializeWorkflowResult,
  workflowInputFailure,
  WorkflowDiagnosticError,
} from "./results.js";
import type { WorkflowMutationOutcome } from "./results.js";
import { deriveDelegatedGuidance } from "./inspection.js";
import {
  assertWorkflowToolAccess,
  createWorkflowAuthorization,
  shouldInjectForAgent,
} from "./authorization.js";
import { createRecoverySupport } from "./recovery.js";
import {
  acquireNativeSnapshotRuntime,
  type NativeSessionInfoLike,
  type NativeSnapshotContext,
} from "../../runtime/context.js";
import type { EffectiveRuntimeConfig, SnapshotService } from "../../runtime/types.js";
import {
  createConsoleDiagnosticSink,
  decodeNativeSubagentResult,
  evaluateFreshExclusiveLaunch,
  parseSubagentCompletionElement,
  readNativeSubagentInput,
  readSubagentAgent,
  readSubagentPrompt,
  type WorkflowDiagnosticSink,
} from "./host.js";
import {
  evaluateCancellationEvidence,
  isAbortedStructuredError,
  parseSubagentToolFailure,
  type SubagentToolFailure,
} from "./cancellation.js";
import workflowSystemInstructionTemplate from "./system-instruction.md?raw";
import {
  resolveOrchestrationPolicy,
  type ResolvedOrchestrationPolicy,
} from "../../lib/orchestration.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import {
  deleteWorkflowSessionDir,
  hydrateWorkflowStateChecked,
  snapshotWorkflowStateChecked,
} from "./persistence.js";
import { loadApprovedDelegatedPlan } from "./checkpoint-io.js";
import { isTaskLaunchableInStore, latestAttemptView } from "./execution.js";

const TRACKED_SUBAGENT_SET = new Set<string>(TRACKED_SUBAGENT_NAMES);
const WORK_ITEM_MISSING_MARKER = "__VVOC" + "_SECRET_BEARER_TOKEN_a6f582092f05__";
const INVALID_NEXT_AGENT_MARKER = "__VVOC" + "_SECRET_BEARER_TOKEN_513fa2de603d__";

const REVIEW_ONLY_WORKFLOW_SYSTEM_INSTRUCTION = `
<workflow_protocol>
Tracked review-only mechanics are available when independent evaluation is explicitly requested or
materially useful. Open one work item with mode "review_only" and the required reviewer roles,
launch only reviewers with the returned VVOC_WORK_ITEM_ID, and collect the complete review round.
Use one review round by default and personally validate every finding. Reviewer FAIL is a completed
finding result, not a route to vv-implementer. For an explicit review-only request, report findings
and stop before fixes; during active implementation, apply confirmed fixes directly and run fresh
verification. Treat BLOCKED and NEEDS_CONTEXT as hard stops and close the work item when ready.
</workflow_protocol>
`.trim();

const SELECTIVE_WORKFLOW_SYSTEM_INSTRUCTION = `
<workflow_protocol>
Selective delegation is available but never mandatory. Keep critical reasoning and final synthesis
in vv-controller; use bounded explore for search, investigator for an isolated failure, a mechanical
vv-implementer for a settled task, or reviewers for independent evaluation only when useful. Open
the matching work item with work_item_open, explicit mode, and requiredReviewers before tracked
implementer or reviewer launches, then preserve its VVOC_WORK_ITEM_ID. Do not create automatic
implementation or reviewer loops. Review-only FAIL
results are findings and do not route to an implementer. Treat BLOCKED and NEEDS_CONTEXT as hard
stops, validate delegated results yourself, run fresh verification, and close completed work items.
</workflow_protocol>
`.trim();

const DELEGATED_WORKFLOW_SYSTEM_INSTRUCTION = `
<workflow_protocol>
Delegated execution mechanics are available in this session. Open implementation tasks with
work_item_open using mode "delegated" and an empty requiredReviewers array, then dispatch exactly
one vv-implementer per task with a bounded task packet and the returned VVOC_WORK_ITEM_ID. Let the
worker complete its local edit, test, and fix cycle before it reports.

A DONE worker result waits in awaiting_acceptance: it never closes the work item and the worker
never accepts its own result. Inspect the changed code and evidence yourself, then call
work_item_decide with the attempt number to accept or request changes. DONE_WITH_CONCERNS requires
an explicit concerns disposition. Controller retries are bounded to one correction attempt before
explicit recovery; BLOCKED and NEEDS_CONTEXT remain hard stops.

Bounded recovery: when a delegated task stops (BLOCKED or NEEDS_CONTEXT) or exhausts its two
ordinary attempts without acceptance, diagnose it yourself and call work_item_decide with decision
"recover", the terminal attempt number, a diagnosis, the changed condition or approach, the
required verification references, and a stable recoveryId. A recovery resumes the same work item
and its ordinary budget; when a further attempt is necessary it grants exactly one. The single
autonomous grant per target is consumed on first use. After that, a further unit requires either a
fresh root-user message referenced by userMessageId — validated for role, session identity, and
timing, never wording — or a recorded advance authority referenced by runId and authorityId whose
finite shared reserve still has a unit. Recovery never accepts a result, replaces a reviewer, or
changes declared scope. A rejected report (a worker execution that finished with a protocol-invalid
result) is recorded with bounded diagnostics and has the same recovery path; it never becomes DONE.
A worker cancelled by the host stays in-flight across a restart; recovery requires authoritative
native cancellation evidence (parent tool-call cancellation, the child's terminal abort, and child
quiescence) and settles the attempt and the recovery together.

Requirements may come from the supported approved native spec/plan package under .vvoc/specs/, a
provided plan reference, or the current conversation. Register a native package once with
work_checkpoint register (planPath); start and verify declared checkpoints only after their
prerequisite tasks are accepted. A provided-plan or conversation-scoped run is registered once with
work_item_open carrying an execution descriptor (executionKey, source, goal, boundary) and its
first task batch; later tasks append with the same runId plus amendmentId and rationale, and generic
review obligations run through work_checkpoint start/review/complete. A selected source stays
authoritative: a failed native package is never silently reopened as weaker generic execution, and
a provided document is never converted or executed as commands. A checkpoint passes only when
every declared reviewer passes against the pinned snapshot; a closed review-only FAIL report is a
findings result, not approval. A checkpoint generation that stopped or exhausted its ordinary
generations recovers through work_checkpoint action "recover" with the same bounded fields and the
same authority options. Do not write source files yourself:
delegate implementation edits, including fixes requested by reviewers, through bounded task
packets, while keeping planning artifacts, acceptance decisions, and verification commands in this
session.
</workflow_protocol>
`.trim();

// Common result-protocol guidance appended to the non-tracked profile
// instructions. It states shared launch/result rules only: it does not select a
// source or lifecycle, and it adds no delegation or review obligation. Status
// vocabularies come from protocol.ts so the text cannot drift from the parser.
const TRACKED_RESULT_PROTOCOL_INSTRUCTION = `
<tracked_result_protocol>
A tracked subagent result begins on its first line with the protocol top block — no preface, prose, or code fence — followed by a blank line and the body. Use the exact VVOC_WORK_ITEM_ID returned by work_item_open for that assignment; never reuse a sample id from another task.
- vv-implementer: VVOC_STATUS ${describeStatusVocabulary("vv-implementer")}, with a required VVOC_ROUTE.
- vv-spec-reviewer / vv-code-reviewer: VVOC_STATUS ${describeStatusVocabulary("vv-spec-reviewer")}; a reviewer result carries no route.
A result whose first field names a different work item is a work-item mismatch, not a malformed header, and is never relabeled to the expected id. Inspect work_item_list before retrying to recover the current identity, state, attempt, and remaining budget. Common tool calls follow the published input schemas, and work_item_list reports the loaded contract revision and the on-demand reference path at contract.referencePath.
</tracked_result_protocol>
`.trim();

/** Returns the exact workflow instruction compatible with one resolved policy. */
function getWorkflowSystemInstruction(policy: ResolvedOrchestrationPolicy): string {
  switch (policy.workflowGuidance) {
    case "review-only":
      return `${REVIEW_ONLY_WORKFLOW_SYSTEM_INSTRUCTION}\n\n${TRACKED_RESULT_PROTOCOL_INSTRUCTION}`;
    case "selective":
      return `${SELECTIVE_WORKFLOW_SYSTEM_INSTRUCTION}\n\n${TRACKED_RESULT_PROTOCOL_INSTRUCTION}`;
    case "tracked":
      return workflowSystemInstructionTemplate.trim();
    case "delegated":
      return `${DELEGATED_WORKFLOW_SYSTEM_INSTRUCTION}\n\n${TRACKED_RESULT_PROTOCOL_INSTRUCTION}`;
  }
}

function isTrackedSubagent(value: unknown): value is TrackedAgentName {
  return typeof value === "string" && TRACKED_SUBAGENT_SET.has(value);
}

// START_BLOCK_DELEGATED_FAILURE_BINDING_TYPES
/**
 * Live, in-memory binding from one native subagent tool call to the delegated
 * attempt it allocated. Only confirmed foreground failures consume it; every
 * other path latches it ineligible so ambiguous events fail closed.
 */
interface DelegatedLaunchBinding {
  sessionId: string;
  callId: string;
  workItemId: string;
  attempt: number;
  /** Fresh-exclusive foreground eligibility; once false it stays false. */
  eligible: boolean;
  ineligibleReason?: string;
  /** Latched at the first line of the native after hook, before parsing or repair. */
  afterHookEntered: boolean;
  /** Child session observed from host metadata, used to detect resume/share. */
  childSessionId?: string;
  /** True for a background launch whose terminal delivery arrives later. */
  background: boolean;
  /** True once a failure was durably applied or the event was refused for good. */
  settled: boolean;
}

function delegatedLaunchBindingKey(sessionId: string, callId: string): string {
  return `${sessionId}::${callId}`;
}
// END_BLOCK_DELEGATED_FAILURE_BINDING_TYPES

// START_BLOCK_LAUNCH_MUTATION_TYPES
/**
 * Outcome of the staged launch transition. `applied` means the domain change
 * was persisted and published; the `*-rejected` variants are validation
 * refusals that persisted and published nothing.
 */
type LaunchOutcome =
  | { kind: "applied"; delegatedAttempt?: number }
  | {
      kind: "tracked-rejected";
      errorCode: string;
      message: string;
      allowedAgents: string[];
    }
  | { kind: "delegated-rejected"; errorCode: string; message: string }
  | { kind: "reviewer-rejected"; errorCode: string; message: string };
// END_BLOCK_LAUNCH_MUTATION_TYPES

function appendSystemInstruction(existingSystem: string | undefined, instruction: string): string {
  if (!existingSystem?.trim()) {
    return instruction;
  }
  if (existingSystem.includes(instruction)) {
    return existingSystem;
  }
  return `${existingSystem.trim()}\n\n${instruction}`;
}

// Serialize every public workflow result through the shared results contract so
// failures gain a stable category and post-side-effect reporting failures stay
// bounded and truthful instead of throwing raw after a committed mutation.
function stringifyToolOutput(
  value: Record<string, unknown>,
  outcome?: WorkflowMutationOutcome,
): string {
  return serializeWorkflowResult(value, outcome !== undefined ? { outcome } : undefined);
}

function createRoundLimitMessage(record: WorkItemRecord, attemptedRound: number): string {
  return [
    "LAUNCH_REJECTED_ROUND_LIMIT: review loop gate blocked tracked launch before entering a disallowed implementation retry round.",
    `Work item ${record.workItemId} is in state ${record.state} at reviewRound=${getReviewRound(record)} and cannot start round ${attemptedRound}.`,
    "Next action: call work_item_list for this session, resolve concerns with explicit context, then open/continue a fresh work item instead of retrying the same loop.",
  ].join(" ");
}

function createResultExcerptForParsedOutput(options: {
  body: string;
  normalizedOutput: string;
}): WorkflowResultExcerpt | undefined {
  const bodyExcerpt = createWorkflowResultExcerpt({
    text: options.body,
    source: "parsed_body",
  });
  if (bodyExcerpt) {
    return bodyExcerpt;
  }

  return createWorkflowResultExcerpt({
    text: options.normalizedOutput,
    source: "normalized_output",
  });
}

function formatResultExcerptForError(excerpt: WorkflowResultExcerpt | undefined): string {
  if (!excerpt) {
    return "Result excerpt: <empty>";
  }

  const truncation = excerpt.truncated
    ? `, truncated to ${excerpt.maxLength} of ${excerpt.originalLength} characters`
    : "";
  return `Result excerpt (${excerpt.source}${truncation}):\n${excerpt.text}`;
}

function findHardStopRecoveryContext(
  record: WorkItemRecord,
  fallback: { agent: TrackedAgentName; status: string; excerpt?: WorkflowResultExcerpt },
): { agent: string; status: string; excerpt?: WorkflowResultExcerpt } {
  if (record.state === "needs_context" && record.currentRound) {
    const needsContextResult = Object.values(record.currentRound.results).find(
      (result) => result?.status === "NEEDS_CONTEXT",
    );
    if (needsContextResult?.resultExcerpt) {
      return {
        agent: needsContextResult.agent,
        status: needsContextResult.status,
        excerpt: needsContextResult.resultExcerpt,
      };
    }
  }

  if (record.resultExcerpt) {
    return {
      agent: fallback.agent,
      status: fallback.status,
      excerpt: record.resultExcerpt,
    };
  }

  return fallback;
}

function createHardStopMessage(options: {
  record: WorkItemRecord;
  triggeringAgent: TrackedAgentName;
  triggeringStatus: string;
  triggeringExcerpt?: WorkflowResultExcerpt;
}): string {
  const recovery = findHardStopRecoveryContext(options.record, {
    agent: options.triggeringAgent,
    status: options.triggeringStatus,
    excerpt: options.triggeringExcerpt,
  });
  return [
    `RESULT_HARD_STOP: ${options.record.state} requires explicit user action for ${options.record.workItemId}.`,
    `Recovery context: agent=${recovery.agent}; status=${recovery.status}.`,
    formatResultExcerptForError(recovery.excerpt),
    "Inspect work_item_list before retrying.",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaFor(toolId: string): ZodTypeAny {
  const contract = workflowToolContracts.find((candidate) => candidate.toolId === toolId);
  if (!contract) throw new Error(`missing workflow tool contract ${toolId}`);
  return contract.runtimeSchema;
}

// START_BLOCK_NATIVE_TOOL_RESULT
/** Convert a serialized workflow string into a native Tool.Result. */
function nativeToolResult(output: string): { output: string; content: string } {
  return { output, content: output };
}
// END_BLOCK_NATIVE_TOOL_RESULT

// START_BLOCK_PLUGIN_ENTRY
/**
 * Narrow full-client surface consumed by the workflow plugin. The real
 * authenticated `OpenCodeClient` satisfies it structurally; tests inject a fake.
 */
export interface WorkflowClient {
  readonly session: {
    get(input: { readonly sessionID: string }): Promise<NativeSessionInfoLike>;
    context(input: { readonly sessionID: string }): Promise<ReadonlyArray<unknown>>;
    message: {
      get(input: { readonly sessionID: string; readonly messageID: string }): Promise<unknown>;
    };
    active(): Promise<Record<string, unknown>>;
    inbox: {
      list(input: { readonly sessionID: string }): Promise<ReadonlyArray<unknown>>;
    };
    prompt(input: { readonly sessionID: string; readonly text: string }): Promise<unknown>;
    wait(input: { readonly sessionID: string }): Promise<void>;
    interrupt(input: { readonly sessionID: string }): Promise<unknown>;
  };
  readonly message: {
    list(input: {
      readonly sessionID: string;
      readonly order?: "asc" | "desc";
      readonly limit?: number;
      readonly type?: string;
    }): Promise<unknown>;
  };
}

/**
 * Narrow runtime surface consumed by the workflow plugin. The real
 * `NativeSnapshotRuntime` satisfies it structurally; tests inject a fake.
 */
export interface WorkflowRuntime {
  readonly snapshots: Pick<SnapshotService, "configFor" | "accept">;
  client(): Promise<WorkflowClient>;
  effectiveConfig(): EffectiveRuntimeConfig;
  release(): Promise<void>;
}

export interface WorkflowPluginOptions {
  /**
   * Test-only injectable runtime acquisition. The default acquires the real
   * native snapshot runtime from the actual plugin context.
   */
  acquireRuntime?: (ctx: NativeSnapshotContext) => Promise<WorkflowRuntime>;
}

/** Native workflow plugin factory; the default export uses the real runtime. */
export function createWorkflowPlugin(options: WorkflowPluginOptions = {}): Plugin.Plugin {
  return Plugin.define({
    id: "vvoc.workflow",
    setup: (ctx) => setupWorkflow(ctx, options),
  });
}

async function setupWorkflow(
  ctx: Plugin.Context,
  options: WorkflowPluginOptions,
): Promise<(() => Promise<void>) | undefined> {
  const acquire: (c: NativeSnapshotContext) => Promise<WorkflowRuntime> =
    options.acquireRuntime ??
    (async (c) => (await acquireNativeSnapshotRuntime(c)) as unknown as WorkflowRuntime);
  const runtime = await acquire(ctx as unknown as NativeSnapshotContext);
  // The authenticated full client is acquired LAZILY: authenticating it during
  // plugin setup can deadlock host activation, so only a real lookup triggers it.
  // A rejected acquisition is NOT cached forever: the share is reset so a later
  // lookup can authenticate again instead of permanently poisoning all callers.
  let clientPromise: Promise<WorkflowClient> | undefined;
  const getClient = (): Promise<WorkflowClient> => {
    if (clientPromise === undefined) {
      const pending = runtime.client();
      clientPromise = pending;
      void pending.catch(() => {
        if (clientPromise === pending) clientPromise = undefined;
      });
    }
    return clientPromise;
  };
  const directory = ctx.location.directory;
  const trustedWorkspaceRoot = ctx.location.project?.directory ?? directory;
  // Registration is STABLE and independent of startup config. Execution,
  // visibility and guidance are gated per bound family below. Setup never
  // grants execution authority from the startup/current config.
  const WORKFLOW_TOOL_NAMES = workflowToolContracts.map((contract) => contract.toolId);
  async function resolveFamilyPolicy(
    sessionId: string,
  ): Promise<{ policy: ResolvedOrchestrationPolicy; enabled: boolean } | undefined> {
    let capture: { vvoc: EffectiveRuntimeConfig["vvoc"] } | undefined;
    try {
      capture = await runtime.snapshots.configFor(sessionId);
    } catch {
      return undefined;
    }
    if (capture === undefined) {
      // A first accepted workload may be persisted but not yet published;
      // reconcile through the native acceptance service, then read again.
      try {
        await runtime.snapshots.accept({ sessionID: sessionId });
      } catch {
        // fall through to the second read; absence fails closed below
      }
      try {
        capture = await runtime.snapshots.configFor(sessionId);
      } catch {
        return undefined;
      }
    }
    if (capture === undefined) return undefined;
    return {
      policy: resolveOrchestrationPolicy(capture.vvoc),
      enabled: isVvocPluginEnabled(capture.vvoc, "workflow"),
    };
  }
  async function requireFamilyEnabled(sessionId: string): Promise<ResolvedOrchestrationPolicy> {
    const family = await resolveFamilyPolicy(sessionId);
    if (family === undefined) {
      throw new WorkflowDiagnosticError(
        "FAMILY_UNBOUND",
        "authorization",
        `FAMILY_UNBOUND: no immutable policy capture is bound to session ${sessionId}; workflow tools fail closed until a family is bound.`,
      );
    }
    if (!family.enabled) {
      throw new WorkflowDiagnosticError(
        "FAMILY_DISABLED",
        "authorization",
        `FAMILY_DISABLED: the workflow plugin is disabled for the policy bound to session ${sessionId}.`,
      );
    }
    return family.policy;
  }
  const diagnostics: WorkflowDiagnosticSink = createConsoleDiagnosticSink({
    namespace: "workflow",
  });
  // Serializes launch-state mutations with the same staged persist-then-publish
  // boundary used by recovery: a launch never advances live attempt/budget/
  // reviewer state without a durable snapshot of that transition.
  const workflowTransactions = new WorkflowTransactionQueue();

  // START_BLOCK_PERSISTENCE_SETUP
  // Each session (main or subagent) gets its own isolated store.
  // This prevents subagent tool calls from interfering with the main session's work items.
  // Hydration uses the checked loader: invalid persisted state is tracked so new
  // control transactions and snapshot writes fail closed instead of silently
  // resetting a malformed run. A restart boundary does NOT refund in-flight
  // attempts or consumed budget: a cancelled worker's attempt stays in-flight
  // until explicit, evidence-backed recovery settles it.
  const stores = new Map<string, WorkItemStore>();
  const invalidHydrationSessions = new Set<string>();

  function getOrCreateStore(sessionId: string): WorkItemStore {
    let store = stores.get(sessionId);
    if (!store) {
      const hydrated = hydrateWorkflowStateChecked(sessionId);
      if (hydrated.status === "valid") {
        store = createWorkItemStore(hydrated.data);
      } else {
        if (hydrated.status === "invalid") {
          invalidHydrationSessions.add(sessionId);
        }
        store = createWorkItemStore();
      }
      stores.set(sessionId, store);
    }
    return store;
  }

  function snapshotSession(sessionId: string): { ok: boolean; error?: string } {
    const store = stores.get(sessionId);
    if (!store) return { ok: true };
    if (invalidHydrationSessions.has(sessionId)) {
      return {
        ok: false,
        error: `persisted workflow state for session ${sessionId} is invalid; refusing to overwrite it`,
      };
    }
    const result = snapshotWorkflowStateChecked(sessionId, store.getStoreData());
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }
  // END_BLOCK_PERSISTENCE_SETUP

  // START_BLOCK_DELEGATED_FAILURE_BINDING
  // Live host-call bindings let the plugin consume confirmed host-terminal
  // failures of foreground subagent launches without hydrating a store from
  // an event. Every exclusion is sticky: once a binding is tainted it can
  // never authorize a failure transition.
  const delegatedLaunchBindings = new Map<string, DelegatedLaunchBinding>();
  const resumedChildSessions = new Set<string>();
  const childPromptMessageIds = new Map<string, Set<string>>();

  function taintDelegatedLaunchBinding(binding: DelegatedLaunchBinding, reason: string): void {
    if (binding.eligible) {
      binding.eligible = false;
      binding.ineligibleReason = reason;
    }
  }

  function taintBindingsForChild(childSessionId: string, reason: string): void {
    for (const binding of delegatedLaunchBindings.values()) {
      if (binding.childSessionId === childSessionId) taintDelegatedLaunchBinding(binding, reason);
    }
  }

  function findBindingByChild(childSessionId: string): DelegatedLaunchBinding | undefined {
    for (const binding of delegatedLaunchBindings.values()) {
      if (binding.childSessionId === childSessionId) return binding;
    }
    return undefined;
  }

  /**
   * Track distinct user-prompt message ids per session: a child session
   * prompted with more than one distinct message is shared or resumed, so it
   * can no longer be a fresh-exclusive child.
   */
  function observeChildPrompt(sessionId: string, messageId: string | undefined): void {
    if (!messageId) return;
    let messageIds = childPromptMessageIds.get(sessionId);
    if (!messageIds) {
      messageIds = new Set<string>();
      childPromptMessageIds.set(sessionId, messageIds);
    }
    if (messageIds.has(messageId)) return;
    messageIds.add(messageId);
    if (messageIds.size > 1) {
      resumedChildSessions.add(sessionId);
      taintBindingsForChild(sessionId, "child_reprompted");
    }
  }

  function observeSubagentLaunchInput(input: unknown): void {
    const parsed = readNativeSubagentInput(input);
    if (!parsed?.sessionID) return;
    resumedChildSessions.add(parsed.sessionID);
    taintBindingsForChild(parsed.sessionID, "child_resumed");
  }

  /** Observe native result metadata for the bound child/background identity. */
  function observeAfterMetadata(sessionId: string, callId: string, metadata: unknown): void {
    const binding = delegatedLaunchBindings.get(delegatedLaunchBindingKey(sessionId, callId));
    if (!binding || !isRecord(metadata)) return;
    const child = metadata.sessionID;
    if (typeof child === "string" && child.trim() !== "") {
      if (binding.childSessionId === undefined) {
        binding.childSessionId = child;
      } else if (binding.childSessionId !== child) {
        taintDelegatedLaunchBinding(binding, "metadata_child_replaced");
      }
    }
  }

  /**
   * Stage the failed-attempt transition, persist a checked snapshot of the
   * staged state, and only then commit it in memory. There is no async yield
   * between the final identity/exclusion check and the commit; a checked write
   * failure leaves the live in-flight attempt (and retry block) intact.
   */
  function commitDelegatedLaunchFailure(
    sessionId: string,
    binding: DelegatedLaunchBinding,
    failureExcerpt: WorkflowResultExcerpt,
    completedAt?: string,
  ): void {
    const liveStore = stores.get(sessionId);
    if (!liveStore || invalidHydrationSessions.has(sessionId)) return;
    const liveData = liveStore.getStoreData();
    const stagedStore = createWorkItemStore(liveData);
    const applied = applyDelegatedLaunchFailure(stagedStore, {
      sessionId,
      workItemId: binding.workItemId,
      callId: binding.callId,
      failureExcerpt,
      ...(completedAt === undefined ? {} : { completedAt }),
    });
    if (!applied.ok) {
      binding.settled = true;
      return;
    }

    const stagedData = stagedStore.getStoreData();
    const persisted = snapshotWorkflowStateChecked(sessionId, stagedData);
    if (!persisted.ok) {
      diagnostics.log({
        level: "error",
        message: "[workflow][delegatedFailure][BLOCK_DELEGATED_FAILURE] persistence failed",
        extra: {
          sessionID: sessionId,
          workItemId: binding.workItemId,
          attempt: binding.attempt,
          error: persisted.error.slice(0, 300),
        },
      });
      return;
    }

    const lookupKey = createRecordLookupKey(sessionId, binding.workItemId);
    const committed = stagedData.records.get(lookupKey);
    if (!committed) return;
    liveData.records.set(lookupKey, committed);
    binding.settled = true;
    diagnostics.log({
      level: "warn",
      message:
        "[workflow][delegatedFailure][BLOCK_DELEGATED_FAILURE] host-terminal launch failure recorded",
      extra: {
        sessionID: sessionId,
        workItemId: binding.workItemId,
        attempt: applied.attempt,
        consumedAttempts: applied.consumedAttempts,
        attemptBudget: applied.attemptBudget,
        retryAllowed: applied.retryAllowed,
      },
    });
  }

  /**
   * Settle a confirmed terminal protocol-invalid delegated report: the domain
   * reducer applies to a staged copy, the staged state persists, and only then
   * the settled record commits to the live store, returning the settled
   * attempt number. A failed write keeps the live in-flight attempt so an
   * unpersisted settlement never frees a launch slot.
   */
  function commitDelegatedReportRejection(
    sessionId: string,
    workItemId: string,
    callId: string,
    protocolErrorCode: string,
    excerpt: WorkflowResultExcerpt,
    explicitHardStop: "BLOCKED" | "NEEDS_CONTEXT" | undefined,
  ): number | undefined {
    const liveStore = stores.get(sessionId);
    if (!liveStore || invalidHydrationSessions.has(sessionId)) return undefined;
    const liveData = liveStore.getStoreData();
    const stagedStore = createWorkItemStore(liveData);
    const applied = applyDelegatedReportRejection(stagedStore, {
      sessionId,
      workItemId,
      callId,
      protocolErrorCode,
      excerpt,
      ...(explicitHardStop ? { explicitHardStop } : {}),
    });
    if (!applied.ok) {
      return undefined;
    }

    const stagedData = stagedStore.getStoreData();
    const persisted = snapshotWorkflowStateChecked(sessionId, stagedData);
    if (!persisted.ok) {
      diagnostics.log({
        level: "error",
        message: "[workflow][reportRejection][BLOCK_REPORT_REJECTION] persistence failed",
        extra: {
          sessionID: sessionId,
          workItemId,
          attempt: applied.attempt,
          error: persisted.error.slice(0, 300),
        },
      });
      return undefined;
    }

    const lookupKey = createRecordLookupKey(sessionId, workItemId);
    const committed = stagedData.records.get(lookupKey);
    if (!committed) return undefined;
    liveData.records.set(lookupKey, committed);
    diagnostics.log({
      level: "warn",
      message:
        "[workflow][reportRejection][BLOCK_REPORT_REJECTION] terminal report rejected and settled",
      extra: {
        sessionID: sessionId,
        workItemId,
        attempt: applied.attempt,
        protocolErrorCode,
        observedHardStop: explicitHardStop,
        consumedAttempts: applied.consumedAttempts,
        attemptBudget: applied.attemptBudget,
      },
    });
    return applied.attempt;
  }

  /** Settle one confirmed host-terminal failure from a native tool error. */
  function handleSubagentToolTermination(
    sessionId: string,
    callId: string,
    failure: SubagentToolFailure,
    detail: string,
  ): void {
    const binding = delegatedLaunchBindings.get(delegatedLaunchBindingKey(sessionId, callId));
    if (!binding) return;
    // Only a confirmed host-terminal 'failed' termination consumes the attempt
    // immediately. A cancelled/interrupted tool call stays in-flight and is
    // settled only by explicit, evidence-backed cancellation recovery.
    if (failure.kind !== "failed") return;
    if (binding.background) return;
    if (binding.afterHookEntered || !binding.eligible || binding.settled) return;
    if (binding.childSessionId === undefined) {
      binding.childSessionId = failure.childSessionId;
    } else if (binding.childSessionId !== failure.childSessionId) {
      taintDelegatedLaunchBinding(binding, "metadata_child_replaced");
      return;
    }
    if (resumedChildSessions.has(failure.childSessionId)) {
      taintDelegatedLaunchBinding(binding, "child_resumed");
      return;
    }
    const failureExcerpt = createWorkflowResultExcerpt({
      text: detail,
      source: "normalized_output",
    });
    if (!failureExcerpt) return;
    if (!stores.has(sessionId) || invalidHydrationSessions.has(sessionId)) return;
    commitDelegatedLaunchFailure(sessionId, binding, failureExcerpt);
  }
  // END_BLOCK_DELEGATED_FAILURE_BINDING

  // START_BLOCK_DELEGATED_AUTHORIZATION
  // New control mutations require the primary vv-controller session; the
  // guard, its root/fork identity check, and the native session-backed
  // message lookups live in authorization.js over this explicit plugin context.
  const { assertPrimaryControllerMutation, lookupRecoveryUserMessage, lookupAuthorityMessage } =
    createWorkflowAuthorization({
      getClient,
      directory,
      trustedWorkspaceRoot,
      invalidHydrationSessions,
    });
  // END_BLOCK_DELEGATED_AUTHORIZATION

  // START_BLOCK_RECOVERY_SUPPORT
  const {
    commitGenericToolResult,
    executeCommittedRecovery,
    captureRecordRestore,
    captureCheckpointRestore,
  } = createRecoverySupport({ diagnostics, stores, invalidHydrationSessions });
  // END_BLOCK_RECOVERY_SUPPORT

  // START_BLOCK_CHECKPOINT_LINKAGE
  /** Find the in-flight checkpoint generation whose linked review item matches. */
  function findCheckpointByReviewItem(
    sessionId: string,
    reviewWorkItemId: string,
  ): { run: DelegatedPlanRun; checkpointId: string } | undefined {
    for (const run of getOrCreateStore(sessionId).getStoreData().planRuns.values()) {
      if (run.sessionId !== sessionId) continue;
      for (const checkpoint of run.checkpoints.values()) {
        if (checkpoint.currentReview?.reviewWorkItemId === reviewWorkItemId) {
          return { run, checkpointId: checkpoint.checkpointId };
        }
      }
    }
    return undefined;
  }
  // END_BLOCK_CHECKPOINT_LINKAGE

  // START_BLOCK_CANCELLATION_EVIDENCE
  /**
   * Retrieve authoritative native cancellation evidence for an in-flight
   * delegated attempt: the parent subagent tool-call termination, the actual
   * child's LATEST terminal abort attributable to this launch, and full child
   * quiescence (not active, empty inbox). Historical timestamps come from the
   * parent assistant tool part's own `time.completed` and the child terminal
   * assistant message's `time.completed`; recovery never repairs them.
   */
  async function gatherCancellationEvidence(
    sessionId: string,
    callId: string,
    knownChildSessionId: string | undefined,
  ): Promise<
    | {
        ok: true;
        childSessionId: string;
        completedAtMs: number;
      }
    | { ok: false; reason: string }
  > {
    const finite = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) ? value : undefined;

    let client: WorkflowClient;
    try {
      client = await getClient();
    } catch {
      return { ok: false, reason: "CLIENT_UNAVAILABLE" };
    }

    let parentMessages: ReadonlyArray<unknown>;
    try {
      const list = await client.message.list({
        sessionID: sessionId,
        order: "desc",
        limit: 50,
        type: "assistant",
      });
      parentMessages = isRecord(list) && Array.isArray(list.data) ? list.data : [];
    } catch {
      return { ok: false, reason: "PARENT_LOOKUP_FAILED" };
    }

    let parentFailure: SubagentToolFailure | undefined;
    let parentCompletedMs: number | undefined;
    let parentCreatedMs: number | undefined;
    let childSessionId = knownChildSessionId;
    for (const message of parentMessages) {
      if (!isRecord(message) || message.type !== "assistant" || !Array.isArray(message.content))
        continue;
      for (const part of message.content) {
        if (!isRecord(part) || part.type !== "tool" || part.id !== callId) continue;
        // The tool-call name must be the native subagent tool.
        if (part.name !== "subagent") continue;
        const state = part.state;
        if (!isRecord(state)) continue;
        const metadata = isRecord(state.metadata) ? state.metadata : undefined;
        const metaChild = metadata?.sessionID;
        if (typeof metaChild === "string" && metaChild !== "") {
          if (childSessionId === undefined) childSessionId = metaChild;
          else if (childSessionId !== metaChild) {
            return { ok: false, reason: "PARENT_CHILD_SESSION_MISMATCH" };
          }
        }
        if (state.status !== "error") continue;
        const error = state.error;
        if (!isRecord(error) || typeof error.message !== "string") continue;
        const parsed = parseSubagentToolFailure(error.message);
        if (!parsed) continue;
        // Native timing lives beside `state`, on the assistant tool part.
        const partTime = isRecord(part.time) ? part.time : undefined;
        const completed = partTime ? finite(partTime.completed) : undefined;
        if (completed === undefined || completed <= 0) {
          return { ok: false, reason: "PARENT_TERMINAL_TIME_MISSING" };
        }
        parentFailure = parsed;
        parentCompletedMs = completed;
        parentCreatedMs = partTime ? finite(partTime.created) : undefined;
      }
    }
    if (childSessionId === undefined) {
      return { ok: false, reason: "MISSING_CHILD_IDENTITY" };
    }
    if (!parentFailure || parentCompletedMs === undefined) {
      return { ok: false, reason: "NO_PARENT_CANCELLATION_EVIDENCE" };
    }
    if (parentFailure.childSessionId !== childSessionId) {
      return { ok: false, reason: "PARENT_CHILD_SESSION_MISMATCH" };
    }

    // Child identity must be a real child of the parent session.
    let childParentID: unknown;
    try {
      const childInfo = (await client.session.get({ sessionID: childSessionId })) as {
        parentID?: unknown;
      };
      childParentID = childInfo.parentID;
    } catch {
      return { ok: false, reason: "CHILD_LOOKUP_FAILED" };
    }
    if (childParentID !== sessionId) {
      return { ok: false, reason: "CHILD_NOT_OF_PARENT" };
    }

    // Full quiescence: the child is not active and its inbox has no pending
    // work. A missing/invalid native record is UNAVAILABLE evidence, not
    // quiescence, so it refuses.
    try {
      const active = await client.session.active();
      if (!isRecord(active)) {
        return { ok: false, reason: "CHILD_ACTIVE_STATE_UNAVAILABLE" };
      }
      if (active[childSessionId] !== undefined) {
        return { ok: false, reason: "CHILD_STILL_ACTIVE" };
      }
      const inbox = await client.session.inbox.list({ sessionID: childSessionId });
      if (!Array.isArray(inbox)) {
        return { ok: false, reason: "CHILD_INBOX_UNAVAILABLE" };
      }
      if (inbox.length > 0) {
        return { ok: false, reason: "CHILD_INBOX_NOT_EMPTY" };
      }
    } catch {
      return { ok: false, reason: "CHILD_QUIESCENCE_LOOKUP_FAILED" };
    }

    let childMessages: ReadonlyArray<unknown>;
    try {
      const list = await client.message.list({
        sessionID: childSessionId,
        order: "desc",
        limit: 10,
        type: "assistant",
      });
      childMessages = isRecord(list) && Array.isArray(list.data) ? list.data : [];
    } catch {
      return { ok: false, reason: "CHILD_LOOKUP_FAILED" };
    }
    // The LATEST terminal assistant must be aborted; a later success or a new
    // active run is never evidence.
    const latest = childMessages.find(
      (message) => isRecord(message) && message.type === "assistant",
    );
    if (!isRecord(latest)) {
      return { ok: false, reason: "NO_CHILD_TERMINAL_ABORT" };
    }
    const childError = isRecord(latest.error) ? latest.error : undefined;
    if (
      childError === undefined ||
      typeof childError.type !== "string" ||
      typeof childError.message !== "string" ||
      !isAbortedStructuredError({ type: childError.type, message: childError.message })
    ) {
      return { ok: false, reason: "CHILD_TERMINAL_NOT_ABORTED" };
    }
    const childTime = isRecord(latest.time) ? latest.time : undefined;
    const childCompletedMs = childTime ? finite(childTime.completed) : undefined;
    if (childCompletedMs === undefined || childCompletedMs <= 0) {
      return { ok: false, reason: "CHILD_TERMINAL_TIME_MISSING" };
    }
    const childCreatedMs = childTime ? finite(childTime.created) : undefined;
    if (childCreatedMs === undefined || childCreatedMs <= 0) {
      return { ok: false, reason: "CHILD_TERMINAL_TIME_MISSING" };
    }
    if (parentCreatedMs === undefined || parentCreatedMs <= 0) {
      return { ok: false, reason: "PARENT_TERMINAL_TIME_MISSING" };
    }
    if (childCreatedMs < parentCreatedMs) {
      return { ok: false, reason: "CHILD_TERMINAL_BEFORE_LAUNCH" };
    }

    const decision = evaluateCancellationEvidence({
      parentSessionId: sessionId,
      callID: callId,
      childSessionId,
      parentToolFailure: parentFailure,
      childTerminalError: { type: childError.type, message: childError.message },
      childActive: false,
    });
    if (!decision.ok) {
      return { ok: false, reason: decision.reason };
    }
    // Both exact historical timestamps are required; max of the exact values.
    return {
      ok: true,
      childSessionId,
      completedAtMs: Math.max(parentCompletedMs, childCompletedMs),
    };
  }
  // END_BLOCK_CANCELLATION_EVIDENCE

  // START_BLOCK_PLUGIN_TOOLS
  // Tool wrappers still need a store reference for description/args shape
  // but execute handlers resolve the right store per-call.
  const dummyStore = createWorkItemStore();
  const workItemOpenTool = createWorkItemOpenTool(dummyStore);
  const workItemListTool = createWorkItemListTool(dummyStore);
  const workItemCloseTool = createWorkItemCloseTool(dummyStore);
  const delegatedControlOptions: DelegatedControlOptions = {
    lookupUserMessage: lookupRecoveryUserMessage,
    lookupAuthorityMessage,
  };
  const workItemDecideTool = createWorkItemDecideTool(dummyStore, delegatedControlOptions);
  const workCheckpointTool = createWorkCheckpointTool(dummyStore, delegatedControlOptions);

  await ctx.tool.transform((editor) => {
    // START_BLOCK_TOOL_CONTRACT_PUBLICATION
    // The strict closed input schema is published directly to the native tool
    // registry; execute.before independently re-validates raw arguments with
    // bounded tokenized paths before any handler runs.
    editor.add({
      name: "work_item_open",
      input: schemaFor("work_item_open"),
      output: z.string(),
      description: workItemOpenTool.description,
      options: { codemode: false },
      execute: async (args, context) => {
        assertWorkflowToolAccess(String(context.agent), "work_item_open");
        await requireFamilyEnabled(context.sessionID);
        const validation = validateWorkflowToolInput("work_item_open", args);
        if (!validation.ok) {
          return nativeToolResult(
            stringifyToolOutput(
              workflowInputFailure("work_item_open", context.sessionID, validation.issues),
            ),
          );
        }
        const isGeneric =
          validation.data.execution !== undefined || validation.data.runId !== undefined;
        if (isGeneric) {
          getOrCreateStore(context.sessionID);
          const result = await commitGenericToolResult(
            context.sessionID,
            "work_item_open",
            (view) =>
              workItemOpenTool.execute(
                args as never,
                { sessionId: context.sessionID, workspaceRoot: trustedWorkspaceRoot },
                view,
              ),
          );
          return nativeToolResult(
            stringifyToolOutput(result, result.ok === true ? "committed" : "not_applied"),
          );
        }
        const sessionStore = getOrCreateStore(context.sessionID);
        const opened = workItemOpenTool.execute(
          args as never,
          { sessionId: context.sessionID },
          sessionStore,
        );
        const openedPersisted = snapshotSession(context.sessionID);
        return nativeToolResult(
          stringifyToolOutput(
            opened,
            opened.ok === false ? "not_applied" : openedPersisted.ok ? "committed" : "unknown",
          ),
        );
      },
    });

    editor.add({
      name: "work_item_list",
      input: schemaFor("work_item_list"),
      output: z.string(),
      description: workItemListTool.description,
      options: { codemode: false },
      execute: async (args, context) => {
        assertWorkflowToolAccess(String(context.agent), "work_item_list");
        await requireFamilyEnabled(context.sessionID);
        const sessionStore = getOrCreateStore(context.sessionID);
        return nativeToolResult(
          stringifyToolOutput(
            workItemListTool.execute(args as never, { sessionId: context.sessionID }, sessionStore),
          ),
        );
      },
    });

    editor.add({
      name: "work_item_close",
      input: schemaFor("work_item_close"),
      output: z.string(),
      description: workItemCloseTool.description,
      options: { codemode: false },
      execute: async (args, context) => {
        assertWorkflowToolAccess(String(context.agent), "work_item_close");
        await requireFamilyEnabled(context.sessionID);
        const sessionStore = getOrCreateStore(context.sessionID);
        const closed = workItemCloseTool.execute(
          args as never,
          { sessionId: context.sessionID },
          sessionStore,
        );
        const closedPersisted = snapshotSession(context.sessionID);
        return nativeToolResult(
          stringifyToolOutput(
            closed,
            closed.ok === false ? "not_applied" : closedPersisted.ok ? "committed" : "unknown",
          ),
        );
      },
    });

    editor.add({
      name: "work_item_decide",
      input: schemaFor("work_item_decide"),
      output: z.string(),
      description: workItemDecideTool.description,
      options: { codemode: false },
      execute: async (args, context) => {
        const sessionStore = getOrCreateStore(context.sessionID);
        await assertPrimaryControllerMutation(
          String(context.agent),
          context.sessionID,
          "work_item_decide",
        );
        await requireFamilyEnabled(context.sessionID);
        const validation = validateWorkflowToolInput("work_item_decide", args);
        if (!validation.ok) {
          return nativeToolResult(
            stringifyToolOutput(
              workflowInputFailure("work_item_decide", context.sessionID, validation.issues),
            ),
          );
        }
        const parsedDecide = validation.data;
        if (parsedDecide.decision === "recover") {
          // START_BLOCK_EXPLICIT_CANCELLATION_RECOVERY
          // A recover whose delegated attempt is still in-flight (a worker
          // cancelled by the host) is the cancellation path for EVERY recover
          // authorization family — ordinary, root-user, or recorded advance
          // authority. It requires authoritative native cancellation evidence
          // and settles the attempt and the recovery in ONE staged transaction
          // with the historical completion timestamp. No evidence, an active
          // child, a changed attempt identity, or a failed write leaves both
          // the settlement and the budget unchanged.
          const workItemId = parsedDecide.workItemId.trim();
          const inFlight = getWorkItem(
            sessionStore,
            context.sessionID,
            workItemId,
          )?.delegated?.attempts.find((attempt) => attempt.status === "in_flight");
          if (inFlight?.callId !== undefined) {
            const evidence = await gatherCancellationEvidence(
              context.sessionID,
              inFlight.callId,
              undefined,
            );
            if (!evidence.ok) {
              return nativeToolResult(
                stringifyToolOutput(
                  normalizeWorkflowFailure({
                    tool: "work_item_decide",
                    sessionId: context.sessionID,
                    ok: false,
                    errorCode: "CANCELLATION_EVIDENCE_REQUIRED",
                    category: "state",
                    message: `CANCELLATION_EVIDENCE_REQUIRED: recovery of cancelled attempt ${inFlight.attempt} of ${workItemId} needs authoritative parent cancellation, child terminal abort and quiescence evidence (${evidence.reason}); settlement and budget are unchanged.`,
                  }),
                ),
              );
            }
            // Re-check the exact in-flight attempt after the async lookups so a
            // changed/duplicate call binding can never be settled.
            const liveAttempt = getWorkItem(
              sessionStore,
              context.sessionID,
              workItemId,
            )?.delegated?.attempts.find((attempt) => attempt.status === "in_flight");
            if (
              liveAttempt === undefined ||
              liveAttempt.callId !== inFlight.callId ||
              liveAttempt.attempt !== inFlight.attempt
            ) {
              return nativeToolResult(
                stringifyToolOutput(
                  normalizeWorkflowFailure({
                    tool: "work_item_decide",
                    sessionId: context.sessionID,
                    ok: false,
                    errorCode: "CANCELLATION_EVIDENCE_REQUIRED",
                    category: "state",
                    message:
                      "CANCELLATION_EVIDENCE_REQUIRED: the in-flight attempt changed during evidence lookup; settlement and budget are unchanged.",
                  }),
                ),
              );
            }
            const completedAt = new Date(evidence.completedAtMs).toISOString();
            const completed = await commitGenericToolResult(
              context.sessionID,
              "work_item_decide",
              (view) => {
                const failureExcerpt = createWorkflowResultExcerpt({
                  text: "Subagent cancelled: recovered from native parent cancellation, child terminal abort and quiescence evidence.",
                  source: "normalized_output",
                });
                if (!failureExcerpt) {
                  return normalizeWorkflowFailure({
                    tool: "work_item_decide",
                    sessionId: context.sessionID,
                    ok: false,
                    errorCode: "CANCELLATION_SETTLEMENT_FAILED",
                    category: "state",
                    message:
                      "CANCELLATION_SETTLEMENT_FAILED: could not build a bounded cancellation excerpt.",
                  });
                }
                const settled = applyDelegatedLaunchFailure(view, {
                  sessionId: context.sessionID,
                  workItemId,
                  callId: inFlight.callId,
                  failureExcerpt,
                  completedAt,
                });
                if (!settled.ok) {
                  return normalizeWorkflowFailure({
                    tool: "work_item_decide",
                    sessionId: context.sessionID,
                    ok: false,
                    errorCode: settled.errorCode,
                    category: "state",
                    message: settled.message,
                  });
                }
                return workItemDecideTool.execute(
                  args as never,
                  { sessionId: context.sessionID, cancellationSettled: true },
                  view,
                );
              },
            );
            return nativeToolResult(
              stringifyToolOutput(completed, completed.ok === true ? "committed" : "not_applied"),
            );
          }
          // END_BLOCK_EXPLICIT_CANCELLATION_RECOVERY
          if (parsedDecide.authorityId !== undefined) {
            const staged = await commitGenericToolResult(
              context.sessionID,
              "work_item_decide",
              (view) =>
                workItemDecideTool.execute(args as never, { sessionId: context.sessionID }, view),
            );
            return nativeToolResult(
              stringifyToolOutput(staged, staged.ok === true ? "committed" : "not_applied"),
            );
          }
          const recovered = await executeCommittedRecovery(
            context.sessionID,
            (liveStore) =>
              workItemDecideTool.execute(
                args as never,
                { sessionId: context.sessionID },
                liveStore,
              ),
            () => captureRecordRestore(context.sessionID, workItemId),
            (result) => result.ok === true,
          );
          return nativeToolResult(
            stringifyToolOutput(recovered, recovered.ok === true ? "committed" : "not_applied"),
          );
        }
        const decided = await workItemDecideTool.execute(
          args as never,
          { sessionId: context.sessionID },
          sessionStore,
        );
        if (decided.ok) {
          const persisted = snapshotSession(context.sessionID);
          if (!persisted.ok) {
            throw new Error(
              `PERSISTENCE_FAILED: decision applied in memory but could not be persisted: ${persisted.error}`,
            );
          }
        }
        return nativeToolResult(
          stringifyToolOutput(decided, decided.ok === true ? "committed" : "not_applied"),
        );
      },
    });

    editor.add({
      name: "work_checkpoint",
      input: schemaFor("work_checkpoint"),
      output: z.string(),
      description: workCheckpointTool.description,
      options: { codemode: false },
      execute: async (args, context) => {
        const sessionStore = getOrCreateStore(context.sessionID);
        await assertPrimaryControllerMutation(
          String(context.agent),
          context.sessionID,
          "work_checkpoint",
        );
        await requireFamilyEnabled(context.sessionID);
        const validation = validateWorkflowToolInput("work_checkpoint", args);
        if (!validation.ok) {
          return nativeToolResult(
            stringifyToolOutput(
              workflowInputFailure("work_checkpoint", context.sessionID, validation.issues),
            ),
          );
        }
        const parsedArgs = validation.data;
        const toolContext = {
          sessionId: context.sessionID,
          workspaceRoot: trustedWorkspaceRoot,
          loadPlan: async (planPath: string, workspaceRoot: string) => {
            const loaded = await loadApprovedDelegatedPlan({ workspaceRoot, planPath });
            return loaded.ok ? loaded.plan : { loadError: `${loaded.code}: ${loaded.message}` };
          },
        };
        const runIdArg = parsedArgs.runId?.trim() ?? "";
        const liveExecution = runIdArg
          ? sessionStore.getStoreData().executions.get(runIdArg)
          : undefined;
        const authorityAction =
          parsedArgs.action === "authorize" ||
          parsedArgs.action === "record_approval" ||
          parsedArgs.action === "revoke_authority";
        const genericAction =
          parsedArgs.action !== "register" &&
          liveExecution !== undefined &&
          (liveExecution.source.kind !== "native-package" || authorityAction);
        const nativeAuthorityRecover =
          parsedArgs.action === "recover" &&
          parsedArgs.authorityId !== undefined &&
          liveExecution !== undefined;
        const genericRegister =
          parsedArgs.action === "register" && parsedArgs.planPath === undefined;
        if (genericAction || genericRegister || nativeAuthorityRecover) {
          const result = await commitGenericToolResult(
            context.sessionID,
            "work_checkpoint",
            (view) => workCheckpointTool.execute(args as never, toolContext, view),
          );
          return nativeToolResult(
            stringifyToolOutput(result, result.ok === true ? "committed" : "not_applied"),
          );
        }
        if (parsedArgs.action === "recover") {
          const runId = parsedArgs.runId ?? "";
          const checkpointId = parsedArgs.checkpointId ?? "";
          const recovered = await executeCommittedRecovery(
            context.sessionID,
            (liveStore) => workCheckpointTool.execute(args as never, toolContext, liveStore),
            () => captureCheckpointRestore(context.sessionID, runId, checkpointId),
            (result) => result.ok === true,
          );
          return nativeToolResult(
            stringifyToolOutput(recovered, recovered.ok === true ? "committed" : "not_applied"),
          );
        }
        const result = await workCheckpointTool.execute(
          { ...(args as Record<string, unknown>) } as never,
          toolContext,
          sessionStore,
        );
        if (result.ok) {
          const persisted = snapshotSession(context.sessionID);
          if (!persisted.ok) {
            throw new Error(
              `PERSISTENCE_FAILED: checkpoint change applied in memory but could not be persisted: ${persisted.error}`,
            );
          }
        }
        return nativeToolResult(
          stringifyToolOutput(result, result.ok === true ? "committed" : "not_applied"),
        );
      },
    });
  });
  // END_BLOCK_TOOL_CONTRACT_PUBLICATION
  // END_BLOCK_PLUGIN_TOOLS

  // START_BLOCK_TOOL_EXECUTE_BEFORE
  const beforeRegistration = await ctx.tool.hook("execute.before", async (event) => {
    // Owned workflow tools get strict structural plus branch validation on
    // the raw forwarded arguments before their handlers run. This runs before
    // the subagent early return and never mutates event.input.
    if (isWorkflowToolId(event.tool)) {
      const validation = validateWorkflowToolInput(event.tool, event.input);
      if (!validation.ok) {
        throw new ContractInputError(event.tool, validation.issues);
      }
      return;
    }
    if (event.tool !== "subagent") {
      return;
    }

    // Observe resume identities from every launch, including untracked ones,
    // before any early return so a resumed child cannot stay eligible.
    observeSubagentLaunchInput(event.input);

    const subagentType = readSubagentAgent(event.input);
    if (!isTrackedSubagent(subagentType)) {
      return;
    }

    const sessionStore = getOrCreateStore(event.sessionID);
    const header = parseWorkItemHeader(readSubagentPrompt(event.input));
    if (!header.ok) {
      diagnostics.log({
        level: "warn",
        message: "[workflow][launchValidation][BLOCK_VALIDATE_LAUNCH] launch rejected",
        extra: { sessionID: event.sessionID, agent: subagentType, reason: header.error.code },
      });
      throw new Error(`LAUNCH_REJECTED_MISSING_HEADER: ${header.error.message}`);
    }

    const workItem = getWorkItem(sessionStore, event.sessionID, header.value);
    if (!workItem || workItem.state === "closed") {
      diagnostics.log({
        level: "warn",
        message: "[workflow][launchValidation][BLOCK_VALIDATE_LAUNCH] launch rejected",
        extra: {
          sessionID: event.sessionID,
          agent: subagentType,
          workItemId: header.value,
          reason: "WORK_ITEM_NOT_OPEN",
        },
      });
      throw new Error(
        `${WORK_ITEM_MISSING_MARKER} LAUNCH_REJECTED_UNKNOWN_WORK_ITEM: no open work item ${header.value} exists in this session. Use work_item_open first or check state with work_item_list.`,
      );
    }

    if (subagentType === "vv-implementer") {
      const data = sessionStore.getStoreData();
      for (const execution of data.executions.values()) {
        if (execution.sessionId !== event.sessionID) continue;
        const boundTask = [...execution.tasks.values()].find(
          (binding) => binding.workItemId === workItem.workItemId,
        );
        if (!boundTask) continue;
        const launchable = isTaskLaunchableInStore(data, {
          sessionId: event.sessionID,
          runId: execution.runId,
          taskId: boundTask.taskId,
        });
        if (!launchable.ok) {
          diagnostics.log({
            level: "warn",
            message: "[workflow][launchValidation][BLOCK_VALIDATE_LAUNCH] dependency gate",
            extra: {
              sessionID: event.sessionID,
              workItemId: workItem.workItemId,
              runId: execution.runId,
              taskId: boundTask.taskId,
              reason: launchable.reason,
            },
          });
          throw new Error(
            `${INVALID_NEXT_AGENT_MARKER} LAUNCH_REJECTED_DEPENDENCY: task ${boundTask.taskId} cannot start yet: ${launchable.message}`,
          );
        }
        break;
      }
    }

    const allowedNextAgents = getAllowedNextAgents(workItem);
    const reviewRound = getReviewRound(workItem);
    const attemptedRound =
      subagentType === "vv-implementer" ? getAttemptedImplementationRound(workItem) : reviewRound;
    const roundBlocked =
      workItem.mode === "implementation" &&
      subagentType === "vv-implementer" &&
      shouldBlockRound(attemptedRound);

    diagnostics.log({
      level: "info",
      message: "[workflow][loopGate][BLOCK_CHECK_ROUND_LIMIT] round limit check",
      extra: {
        sessionID: event.sessionID,
        workItemId: workItem.workItemId,
        state: workItem.state,
        agent: subagentType,
        reviewRound,
        attemptedRound,
        blocked: roundBlocked,
      },
    });

    if (roundBlocked) {
      diagnostics.log({
        level: "warn",
        message: "[workflow][launchValidation][BLOCK_VALIDATE_LAUNCH] launch rejected",
        extra: {
          sessionID: event.sessionID,
          workItemId: workItem.workItemId,
          agent: subagentType,
          reviewRound,
        },
      });
      throw new Error(createRoundLimitMessage(workItem, attemptedRound));
    }

    // Read-only pre-launch gates: they never mutate state, so they stay on the
    // live snapshot and refuse before any staged transaction begins.
    if (workItem.mode === "delegated" && subagentType === "vv-implementer") {
      const data = sessionStore.getStoreData();
      const planRunId = workItem.delegated?.planRunId;
      if (planRunId) {
        const run = data.planRuns.get(planRunId);
        if (run?.status === "sealed") {
          throw new Error(
            `LAUNCH_REJECTED_SEALED: run ${planRunId} is sealed and cannot launch ${workItem.workItemId}.`,
          );
        }
        const binding = run
          ? [...run.tasks.values()].find((task) => task.workItemId === workItem.workItemId)
          : undefined;
        const taskDefinition = run?.definition.tasks.find(
          (task) => task.taskId === binding?.taskId,
        );
        if (run && taskDefinition) {
          const barrier = checkpointBarrierUnsatisfied(data, planRunId, taskDefinition.wave);
          if (barrier.ok && barrier.blockers.length > 0) {
            throw new Error(
              `LAUNCH_REJECTED_CHECKPOINT_BARRIER: ${workItem.workItemId} is in wave ${taskDefinition.wave} blocked by unpassed checkpoint(s) ${barrier.blockers.join(", ")}.`,
            );
          }
        }
        const overlapping = findOverlappingInFlightReview(
          data,
          planRunId,
          workItem.delegated?.writeScope ?? [],
        );
        if (overlapping) {
          throw new Error(
            `LAUNCH_REJECTED_OVERLAPPING_REVIEW: declared write scope overlaps checkpoint ${overlapping} currently in review.`,
          );
        }
      }
    }

    // The launch transition is STAGED: begin the tracked/delegated/reviewer
    // domain change on a cloned store, persist that snapshot atomically, and
    // only then publish it plus the in-memory host-call binding. A failed write
    // refuses the launch BEFORE the native subagent executes and leaves the
    // original attempt/budget/reviewer state untouched.
    const parsedLaunchInput =
      workItem.mode === "delegated" && subagentType === "vv-implementer"
        ? readNativeSubagentInput(event.input)
        : undefined;
    const launchEligibility = parsedLaunchInput
      ? evaluateFreshExclusiveLaunch(parsedLaunchInput)
      : { eligible: false as const, reason: "resume_session" as const };

    const launchTransaction = await runWorkflowTransaction<LaunchOutcome>({
      queue: workflowTransactions,
      sessionId: event.sessionID,
      getData: () => sessionStore.getStoreData(),
      persist: async (sessionId, data) => {
        if (invalidHydrationSessions.has(sessionId)) {
          return {
            ok: false,
            error: `persisted workflow state for session ${sessionId} is invalid; refusing to overwrite it`,
          };
        }
        return snapshotWorkflowStateChecked(sessionId, data);
      },
      operation: (stagedData): WorkflowMutation<LaunchOutcome> => {
        const stagedStore = createWorkItemStoreView(stagedData);
        const launched = beginTrackedLaunch(stagedStore, {
          sessionId: event.sessionID,
          workItemId: workItem.workItemId,
          agent: subagentType,
        });
        if (!launched.ok) {
          return {
            result: {
              kind: "tracked-rejected",
              errorCode: launched.errorCode,
              message: launched.message,
              allowedAgents: launched.allowedAgents,
            },
            skipPersist: true,
          };
        }

        // START_BLOCK_DELEGATED_LAUNCH_BINDING
        if (workItem.mode === "delegated" && subagentType === "vv-implementer") {
          const delegatedLaunch = beginDelegatedLaunch(stagedStore, {
            sessionId: event.sessionID,
            workItemId: workItem.workItemId,
            callId: String(event.id),
          });
          if (!delegatedLaunch.ok) {
            return {
              result: {
                kind: "delegated-rejected",
                errorCode: delegatedLaunch.errorCode,
                message: delegatedLaunch.message,
              },
              skipPersist: true,
            };
          }
          return { result: { kind: "applied", delegatedAttempt: delegatedLaunch.attempt } };
        }

        if (subagentType === "vv-implementer") {
          return { result: { kind: "applied" } };
        }

        const reviewerRole = getReviewerRoleForAgent(subagentType);
        if (reviewerRole) {
          const linked = findCheckpointByReviewItem(event.sessionID, workItem.workItemId);
          if (linked) {
            const bound = recordCheckpointReviewerLaunch(stagedStore, {
              runId: linked.run.runId,
              checkpointId: linked.checkpointId,
              reviewer: reviewerRole,
              callId: String(event.id),
            });
            if (!bound.ok) {
              return {
                result: {
                  kind: "reviewer-rejected",
                  errorCode: bound.errorCode,
                  message: bound.message,
                },
                skipPersist: true,
              };
            }
          }
        }
        return { result: { kind: "applied" } };
        // END_BLOCK_DELEGATED_LAUNCH_BINDING
      },
    });

    if (!launchTransaction.ok) {
      diagnostics.log({
        level: "error",
        message: "[workflow][launchValidation][BLOCK_VALIDATE_LAUNCH] launch persistence failed",
        extra: {
          sessionID: event.sessionID,
          workItemId: workItem.workItemId,
          agent: subagentType,
          error: launchTransaction.error.slice(0, 300),
        },
      });
      throw new Error(
        `LAUNCH_PERSISTENCE_FAILED: ${workItem.workItemId} launch was refused because its transition could not be persisted: ${launchTransaction.error}`,
      );
    }

    const launch = launchTransaction.result;
    if (launch.kind === "tracked-rejected") {
      diagnostics.log({
        level: "warn",
        message: "[workflow][launchValidation][BLOCK_VALIDATE_LAUNCH] launch rejected",
        extra: {
          sessionID: event.sessionID,
          agent: subagentType,
          workItemId: workItem.workItemId,
          state: workItem.state,
          allowedNextAgents,
          reason: launch.errorCode,
        },
      });
      throw new Error(
        `${INVALID_NEXT_AGENT_MARKER} LAUNCH_REJECTED_INVALID_TRANSITION: ${workItem.workItemId} in state ${workItem.state} only allows ${launch.allowedAgents.join(", ") || "no tracked agent"}. ${launch.message}`,
      );
    }
    if (launch.kind === "delegated-rejected") {
      diagnostics.log({
        level: "warn",
        message: "[workflow][launchValidation][BLOCK_VALIDATE_LAUNCH] launch rejected",
        extra: {
          sessionID: event.sessionID,
          agent: subagentType,
          workItemId: workItem.workItemId,
          reason: launch.errorCode,
        },
      });
      throw new Error(`LAUNCH_REJECTED_DELEGATED_${launch.errorCode}: ${launch.message}`);
    }
    if (launch.kind === "reviewer-rejected") {
      throw new Error(`LAUNCH_REJECTED_CHECKPOINT_REVIEW: ${launch.errorCode}: ${launch.message}`);
    }

    // Publish the live host-call binding only after the durable commit.
    if (workItem.mode === "delegated" && subagentType === "vv-implementer") {
      delegatedLaunchBindings.set(delegatedLaunchBindingKey(event.sessionID, String(event.id)), {
        sessionId: event.sessionID,
        callId: String(event.id),
        workItemId: workItem.workItemId,
        attempt: launch.delegatedAttempt ?? 0,
        eligible: launchEligibility.eligible,
        ...(launchEligibility.eligible ? {} : { ineligibleReason: launchEligibility.reason }),
        afterHookEntered: false,
        ...("resumedChildSessionId" in launchEligibility &&
        launchEligibility.resumedChildSessionId !== undefined
          ? { childSessionId: launchEligibility.resumedChildSessionId }
          : {}),
        background: parsedLaunchInput?.background === true,
        settled: false,
      });
    } else if (subagentType === "vv-implementer") {
      delegatedLaunchBindings.set(delegatedLaunchBindingKey(event.sessionID, String(event.id)), {
        sessionId: event.sessionID,
        callId: String(event.id),
        workItemId: workItem.workItemId,
        attempt: 0,
        eligible: false,
        ineligibleReason: "non_delegated_mode",
        afterHookEntered: false,
        background: false,
        settled: false,
      });
    }

    diagnostics.log({
      level: "info",
      message: "[workflow][launchValidation][BLOCK_VALIDATE_LAUNCH] launch validated",
      extra: {
        sessionID: event.sessionID,
        workItemId: workItem.workItemId,
        state: workItem.state,
        agent: subagentType,
        reviewRound,
        attemptedRound,
        mode: workItem.mode,
      },
    });
  });
  // END_BLOCK_TOOL_EXECUTE_BEFORE

  // START_BLOCK_TOOL_EXECUTE_AFTER
  const afterRegistration = await ctx.tool.hook("execute.after", async (event) => {
    // Latch the ambiguous after-hook path synchronously before any logging,
    // parsing, or repair so a later error event for this call cannot be
    // classified as a terminal launch failure.
    if (event.tool === "subagent" && event.status === "completed") {
      const binding = delegatedLaunchBindings.get(
        delegatedLaunchBindingKey(event.sessionID, String(event.id)),
      );
      if (binding) binding.afterHookEntered = true;
      observeAfterMetadata(event.sessionID, String(event.id), event.result.metadata);
    }
    if (event.tool !== "subagent") {
      return;
    }

    const subagentType = readSubagentAgent(event.input);
    if (!isTrackedSubagent(subagentType)) {
      return;
    }

    const header = parseWorkItemHeader(readSubagentPrompt(event.input));
    if (!header.ok) {
      diagnostics.log({
        level: "warn",
        message: "[workflow][resultParsing][BLOCK_PARSE_RESULT] protocol error",
        extra: { sessionID: event.sessionID, agent: subagentType, reason: header.error.code },
      });
      throw new Error(`RESULT_PROTOCOL_ERROR: ${header.error.message}`);
    }

    const revertLaunch = () => {
      const store = getOrCreateStore(event.sessionID);
      revertReviewerLaunch(store, {
        sessionId: event.sessionID,
        workItemId: header.value,
        agent: subagentType,
      });
      snapshotSession(event.sessionID);
    };

    if (event.status === "error") {
      // A host-terminal failure surfaced by the native tool. The binding
      // consults the exact pinned subagent failure/cancel message; unrelated
      // provider errors never settle a delegated attempt.
      const failure = parseSubagentToolFailure(event.error.message);
      if (failure) {
        handleSubagentToolTermination(
          event.sessionID,
          String(event.id),
          failure,
          event.error.message,
        );
      }
      revertLaunch();
      return;
    }

    const decoded = decodeNativeSubagentResult(event.result.output);
    if (decoded?.status === "running") {
      // Background launch: the attempt stays in-flight; the terminal result
      // arrives later as a native session.synthetic delivery.
      const binding = delegatedLaunchBindings.get(
        delegatedLaunchBindingKey(event.sessionID, String(event.id)),
      );
      if (binding) {
        binding.background = true;
        if (binding.childSessionId === undefined) binding.childSessionId = decoded.sessionID;
      }
      return;
    }

    const outputText =
      decoded?.status === "completed"
        ? decoded.output
        : typeof event.result.output === "string"
          ? event.result.output
          : typeof event.result.content === "string"
            ? event.result.content
            : undefined;
    if (outputText === undefined) {
      diagnostics.log({
        level: "warn",
        message: "[workflow][resultParsing][BLOCK_PARSE_RESULT] protocol error",
        extra: { sessionID: event.sessionID, agent: subagentType, reason: "INVALID_TASK_OUTPUT" },
      });
      revertLaunch();
      event.result = {
        output: "RESULT_PROTOCOL_ERROR: tracked agent output must be text",
        content: "RESULT_PROTOCOL_ERROR: tracked agent output must be text",
      };
      return;
    }

    const finalText = await applyTrackedOutputResult({
      sessionId: event.sessionID,
      callId: String(event.id),
      subagentType,
      workItemId: header.value,
      outputText,
      childSessionId: decoded?.sessionID,
      revertLaunch,
    });
    if (finalText !== undefined) {
      event.result = { output: finalText, content: finalText, metadata: event.result.metadata };
    }
  });
  // END_BLOCK_TOOL_EXECUTE_AFTER

  // START_BLOCK_RESULT_APPLICATION
  /** Parse, optionally continue, and settle one tracked completed subagent result. */
  async function applyTrackedOutputResult(options: {
    sessionId: string;
    callId: string;
    subagentType: TrackedAgentName;
    workItemId: string;
    outputText: string;
    childSessionId?: string | undefined;
    revertLaunch: () => void;
  }): Promise<string | undefined> {
    const { sessionId, callId, subagentType, workItemId, outputText } = options;
    const unwrapped = unwrapResumableTaskResult(outputText);
    let effectiveNormalizedOutput = unwrapped.normalizedOutput;
    let parsed = parseResultBlock({
      agent: subagentType,
      output: effectiveNormalizedOutput,
      expectedWorkItemId: workItemId,
    });
    if (!parsed.ok) {
      const explicitHardStop = detectExplicitHardStopStatus(unwrapped.normalizedOutput);
      const repairChildId = options.childSessionId ?? unwrapped.envelope?.taskId;
      // A real native child identity is enough for one bounded continuation;
      // the legacy envelope is no longer required.
      if (
        repairChildId !== undefined &&
        isTrackedResultRepairEligible(parsed.error.code) &&
        !explicitHardStop
      ) {
        diagnostics.log({
          level: "info",
          message: "[workflow][resultParsing][BLOCK_PARSE_RESULT] bounded continuation attempted",
          extra: {
            sessionID: sessionId,
            agent: subagentType,
            workItemId,
            taskId: repairChildId,
            reason: parsed.error.code,
            attempt: 1,
          },
        });
        // Client acquisition and the bounded continuation are contained LOCALLY:
        // a rejected lazy client or a continuation failure must not escape the
        // after hook, which would leave the attempt in_flight. Falling through
        // lets the existing original-output protocol path settle a truthful
        // report_rejected with the original excerpt and hard-stop rules.
        let repairedOutput: string | undefined;
        try {
          repairedOutput = await attemptTrackedResultRepair({
            client: await getClient(),
            sessionId: repairChildId,
            agent: subagentType,
            workItemId,
            malformedOutput: unwrapped.normalizedOutput,
            parseErrorCode: parsed.error.code,
            parseErrorMessage: parsed.error.message,
          });
        } catch (error) {
          diagnostics.log({
            level: "warn",
            message:
              "[workflow][resultParsing][BLOCK_PARSE_RESULT] bounded continuation unavailable",
            extra: {
              sessionID: sessionId,
              agent: subagentType,
              workItemId,
              taskId: repairChildId,
              reason: parsed.error.code,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
        if (repairedOutput) {
          effectiveNormalizedOutput = repairedOutput;
          parsed = parseResultBlock({
            agent: subagentType,
            output: effectiveNormalizedOutput,
            expectedWorkItemId: workItemId,
          });
        }
      }
    }

    if (!parsed.ok) {
      const protocolFailureExcerpt = createWorkflowResultExcerpt({
        text: unwrapped.normalizedOutput,
        source: "normalized_output",
      });
      diagnostics.log({
        level: "warn",
        message: "[workflow][resultParsing][BLOCK_PARSE_RESULT] protocol error",
        extra: {
          sessionID: sessionId,
          agent: subagentType,
          workItemId,
          reason: parsed.error.code,
        },
      });
      options.revertLaunch();

      const currentForSettlement = getWorkItem(getOrCreateStore(sessionId), sessionId, workItemId);
      const settledAttempt = (() => {
        if (!protocolFailureExcerpt || !currentForSettlement) return undefined;
        if (
          currentForSettlement.state === "closed" ||
          currentForSettlement.mode !== "delegated" ||
          subagentType !== "vv-implementer"
        ) {
          return undefined;
        }
        if (
          !currentForSettlement.delegated?.attempts.some(
            (attempt) => attempt.status === "in_flight" && attempt.callId === callId,
          )
        ) {
          return undefined;
        }
        const observedHardStop = detectExplicitHardStopStatus(unwrapped.normalizedOutput);
        return commitDelegatedReportRejection(
          sessionId,
          workItemId,
          callId,
          parsed.error.code,
          protocolFailureExcerpt,
          observedHardStop,
        );
      })();

      const settlementLines = settledAttempt
        ? [
            `Report rejected: attempt ${settledAttempt} of ${workItemId} settled as report_rejected with bounded diagnostics retained.`,
            (() => {
              const store = getOrCreateStore(sessionId);
              const settledRecord = getWorkItem(store, sessionId, workItemId);
              const guidance = settledRecord
                ? deriveDelegatedGuidance({
                    record: settledRecord,
                    progress: summarizeDelegatedProgress(settledRecord),
                    latest: latestAttemptView(settledRecord),
                    context: { data: store.getStoreData(), sessionId },
                  })
                : undefined;
              return `Next action: ${guidance?.nextAction ?? "inspect work_item_list"}${
                guidance?.nextAction === "recover" ||
                guidance?.nextAction === "recover_with_user_authorization"
                  ? ' through work_item_decide decision "recover"'
                  : ""
              }.`;
            })(),
          ]
        : [];
      return [
        `RESULT_PROTOCOL_ERROR: ${parsed.error.message}`,
        ...settlementLines,
        formatResultExcerptForError(protocolFailureExcerpt),
      ].join("\n");
    }

    const resultExcerpt = createResultExcerptForParsedOutput({
      body: parsed.value.body,
      normalizedOutput: effectiveNormalizedOutput,
    });

    diagnostics.log({
      level: "info",
      message: "[workflow][resultParsing][BLOCK_PARSE_RESULT] result parsed",
      extra: {
        sessionID: sessionId,
        agent: subagentType,
        workItemId: parsed.value.workItemId,
        status: parsed.value.status,
        route: parsed.value.route,
      },
    });

    const sessionStore = getOrCreateStore(sessionId);
    const current = getWorkItem(sessionStore, sessionId, parsed.value.workItemId);
    if (!current || current.state === "closed") {
      options.revertLaunch();
      return [
        `RESULT_PROTOCOL_ERROR: no open work item ${parsed.value.workItemId} exists in this session`,
        formatResultExcerptForError(resultExcerpt),
      ].join("\n");
    }

    if (current.mode === "delegated" && subagentType === "vv-implementer") {
      const appliedDelegated = applyDelegatedResult(sessionStore, {
        sessionId,
        workItemId: parsed.value.workItemId,
        callId,
        resultStatus: parsed.value.status as
          | "DONE"
          | "DONE_WITH_CONCERNS"
          | "NEEDS_CONTEXT"
          | "BLOCKED",
        resultExcerpt,
      });
      if (!appliedDelegated.ok) {
        return [
          `RESULT_PROTOCOL_ERROR: ${appliedDelegated.message}`,
          formatResultExcerptForError(resultExcerpt),
        ].join("\n");
      }

      diagnostics.log({
        level: "info",
        message: "[workflow][stateTransition][BLOCK_TRANSITION_STATE] state transitioned",
        extra: {
          sessionID: sessionId,
          agent: subagentType,
          workItemId: parsed.value.workItemId,
          fromState: appliedDelegated.fromState,
          toState: appliedDelegated.toState,
          mode: "delegated",
          attempt: appliedDelegated.attempt,
        },
      });

      snapshotSession(sessionId);

      if (
        appliedDelegated.record.state === "needs_context" ||
        appliedDelegated.record.state === "blocked"
      ) {
        return createHardStopMessage({
          record: appliedDelegated.record,
          triggeringAgent: subagentType,
          triggeringStatus: parsed.value.status,
          triggeringExcerpt: resultExcerpt,
        });
      }
      return undefined;
    }

    const reviewerRoleForCheckpoint = getReviewerRoleForAgent(subagentType);
    if (reviewerRoleForCheckpoint) {
      const linked = findCheckpointByReviewItem(sessionId, parsed.value.workItemId);
      if (linked) {
        const recorded = recordCheckpointReviewerResult(sessionStore, {
          runId: linked.run.runId,
          checkpointId: linked.checkpointId,
          reviewer: reviewerRoleForCheckpoint,
          callId,
          status: parsed.value.status as "PASS" | "FAIL" | "NEEDS_CONTEXT",
        });
        if (!recorded.ok) {
          options.revertLaunch();
          return [
            `RESULT_PROTOCOL_ERROR: checkpoint ${linked.checkpointId} rejected the reviewer result: ${recorded.message}`,
            formatResultExcerptForError(resultExcerpt),
          ].join("\n");
        }
      }
    }

    const applied = applyTrackedResult(sessionStore, {
      sessionId,
      workItemId: parsed.value.workItemId,
      result: parsed.value,
      resultExcerpt,
    });
    if (!applied.ok) {
      options.revertLaunch();
      return [
        `RESULT_PROTOCOL_ERROR: ${applied.message}`,
        formatResultExcerptForError(resultExcerpt),
      ].join("\n");
    }

    diagnostics.log({
      level: "info",
      message: "[workflow][stateTransition][BLOCK_TRANSITION_STATE] state transitioned",
      extra: {
        sessionID: sessionId,
        agent: subagentType,
        workItemId: parsed.value.workItemId,
        fromState: applied.fromState,
        toState: applied.record.state,
        specReviewCount: applied.record.specReviewCount,
        codeReviewCount: applied.record.codeReviewCount,
        reviewRound: getReviewRound(applied.record),
        aggregateComplete: applied.aggregateComplete,
      },
    });

    snapshotSession(sessionId);

    if (applied.record.state === "needs_context" || applied.record.state === "blocked") {
      return createHardStopMessage({
        record: applied.record,
        triggeringAgent: subagentType,
        triggeringStatus: parsed.value.status,
        triggeringExcerpt: resultExcerpt,
      });
    }
    return undefined;
  }

  /**
   * Settle one background subagent completion delivered as a native
   * `session.synthetic` element. Only a binding whose child matches is settled;
   * a running status is never treated as a completed result.
   */
  async function handleBackgroundDelivery(
    parentSessionId: string,
    text: string,
    metadata: unknown,
  ): Promise<void> {
    // The synthetic delivery must be a genuine native subagent completion for
    // the same parent session and bound child. A forged literal wrapper or an
    // unrelated session is never accepted.
    if (!isRecord(metadata)) return;
    if (metadata.source !== "subagent") return;
    const parsed = parseSubagentCompletionElement(text);
    if (!parsed) return;
    const metaChild = metadata.childID;
    const metaState = metadata.state;
    if (typeof metaChild !== "string" || metaChild !== parsed.sessionID) return;
    if (typeof metaState !== "string" || metaState !== parsed.state) return;
    const binding = findBindingByChild(parsed.sessionID);
    if (!binding || !binding.background || binding.settled) return;
    if (binding.sessionId !== parentSessionId) return;
    const sessionId = binding.sessionId;
    const callId = binding.callId;
    if (parsed.state === "cancelled" || parsed.state === "error") {
      // A background `cancelled` delivery stays in-flight for explicit
      // evidence-backed cancellation recovery. A background `error` is a
      // confirmed terminal failure and settles the bound attempt directly
      // (bypassing the foreground-only guard).
      if (parsed.state === "cancelled") return;
      const failureExcerpt = createWorkflowResultExcerpt({
        text: parsed.output,
        source: "normalized_output",
      });
      if (!failureExcerpt) return;
      commitDelegatedLaunchFailure(sessionId, binding, failureExcerpt);
      return;
    }
    // A completed background delivery must correspond to a terminal,
    // non-aborted child run; verify through the full client before settling.
    try {
      const client = await getClient();
      const childInfo = (await client.session.get({ sessionID: parsed.sessionID })) as {
        parentID?: unknown;
      };
      if (childInfo.parentID !== parentSessionId) return;
      const active = (await client.session.active()) as Record<string, unknown> | undefined;
      if (active !== undefined && active !== null && active[parsed.sessionID] !== undefined) return;
    } catch {
      return;
    }
    const workItem = getWorkItem(getOrCreateStore(sessionId), sessionId, binding.workItemId);
    if (!workItem || workItem.state === "closed") return;
    const subagentType = workItem.mode === "delegated" ? "vv-implementer" : undefined;
    if (!subagentType) return;
    binding.afterHookEntered = true;
    await applyTrackedOutputResult({
      sessionId,
      callId,
      subagentType,
      workItemId: binding.workItemId,
      outputText: parsed.output,
      childSessionId: parsed.sessionID,
      revertLaunch: () => undefined,
    });
  }
  // END_BLOCK_RESULT_APPLICATION

  // START_BLOCK_SESSION_CONTEXT_GUIDANCE
  const guidanceRegistration = await ctx.session.hook("context", async (event) => {
    const family = await resolveFamilyPolicy(event.sessionID);
    // A disabled/unbound family neither sees the workflow tools nor receives
    // workflow guidance; the tools stay registered but are hidden per session.
    if (family === undefined || !family.enabled) {
      const tools = event.tools as Record<string, unknown> | undefined;
      if (tools !== undefined) {
        for (const name of WORKFLOW_TOOL_NAMES) delete tools[name];
      }
      return;
    }
    if (!shouldInjectForAgent(event.agent)) return;
    const instruction = getWorkflowSystemInstruction(family.policy);
    event.system.push({ type: "text", text: appendSystemInstruction(undefined, instruction) });
  });
  // END_BLOCK_SESSION_CONTEXT_GUIDANCE

  // START_BLOCK_EVENT_PUMP
  const lifecycle = new AbortController();
  const pump = (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: lifecycle.signal })) {
        // Contain every handler failure PER EVENT: a rejected client acquisition,
        // malformed background result, or cleanup error must not end the only
        // subscription and silently stop later completion/failure/deletion work.
        try {
          const type = typeof event.type === "string" ? event.type : "";
          const data = isRecord(event.data) ? (event.data as Record<string, unknown>) : undefined;
          if (type === "session.synthetic" && data) {
            const text = data.text;
            const parentSessionId = data.sessionID;
            if (typeof text === "string" && typeof parentSessionId === "string") {
              await handleBackgroundDelivery(parentSessionId, text, data.metadata);
            }
            continue;
          }
          if (type === "session.tool.failed" && data) {
            const sessionID = data.sessionID;
            const callID = data.id;
            const error = isRecord(data.error) ? data.error : undefined;
            const message = typeof error?.message === "string" ? error.message : undefined;
            if (
              typeof sessionID === "string" &&
              typeof callID === "string" &&
              message !== undefined
            ) {
              observeAfterMetadata(sessionID, callID, data.metadata);
              const failure = parseSubagentToolFailure(message);
              if (failure) handleSubagentToolTermination(sessionID, callID, failure, message);
            }
            continue;
          }
          if (
            (type === "session.tool.called" ||
              type === "session.tool.progress" ||
              type === "session.tool.success") &&
            data
          ) {
            const sessionID = data.sessionID;
            const callID = data.id;
            if (typeof sessionID === "string" && typeof callID === "string") {
              observeAfterMetadata(sessionID, callID, data.metadata);
            }
            continue;
          }
          if (type === "session.inbox.enqueued" && data) {
            const sessionID = data.sessionID;
            const inboxID = data.inboxID;
            if (typeof sessionID === "string" && typeof inboxID === "string") {
              observeChildPrompt(sessionID, inboxID);
            }
            continue;
          }
          if (type === "session.deleted" && data) {
            const sessionID = data.sessionID;
            if (typeof sessionID === "string") {
              for (const [key, binding] of delegatedLaunchBindings) {
                if (binding.sessionId === sessionID) delegatedLaunchBindings.delete(key);
              }
              childPromptMessageIds.delete(sessionID);
              resumedChildSessions.delete(sessionID);
              stores.delete(sessionID);
              invalidHydrationSessions.delete(sessionID);
              await deleteWorkflowSessionDir(sessionID);
              diagnostics.log({
                level: "info",
                message: "[workflow][sessionCleanup][BLOCK_SESSION_CLEANUP] deleted",
                extra: { sessionID },
              });
            }
          }
        } catch (error) {
          const data = isRecord(event.data) ? (event.data as Record<string, unknown>) : undefined;
          diagnostics.log({
            level: "error",
            message: "[workflow][eventPump][BLOCK_EVENT_PUMP] contained handler failure",
            extra: {
              eventType: typeof event.type === "string" ? event.type : "unknown",
              ...(typeof data?.sessionID === "string" ? { sessionID: data.sessionID } : {}),
              error: error instanceof Error ? error.message : String(error),
            },
          });
        }
      }
    } catch {
      // A closed native event stream ends the pump; plugin cleanup aborts it.
    }
  })();
  void pump;
  // END_BLOCK_EVENT_PUMP

  return async () => {
    lifecycle.abort();
    await pump.catch(() => undefined);
    await afterRegistration.dispose();
    await beforeRegistration.dispose();
    await guidanceRegistration.dispose();
    await runtime.release();
  };
}

/** Native workflow plugin: registers workflow tools, native hooks and the event pump. */
export const WorkflowPlugin = createWorkflowPlugin();
export default WorkflowPlugin;
// END_BLOCK_PLUGIN_ENTRY
