// FILE: src/plugins/workflow/index.ts
// VERSION: 0.6.0
// START_MODULE_CONTRACT
//   PURPOSE: Register workflow tools and enforcement while injecting only startup-profile-compatible vv-controller guidance, including delegated control tools, host-call-bound attempts, and checkpoint reviewer linkage.
//   SCOPE: work_item_open/list/close registration, delegated-only work_item_decide and work_checkpoint registration with root-session authorization, tracked launch validation with delegated barriers and overlapping-write gates, result normalization and repair, callID-bound delegated attempt results and checkpoint reviewer bookkeeping, round aggregation with bounded excerpts, implementation round limits, checked persistence, and profile-selected chat.message guidance.
//   DEPENDS: [@opencode-ai/plugin, src/lib/config-layers.ts, src/lib/orchestration.ts, src/lib/plugin-toggle-config.ts, src/plugins/workflow/checkpoint-io.ts, src/plugins/workflow/checkpoints.ts, src/plugins/workflow/delegated.ts, src/plugins/workflow/persistence.ts, src/plugins/workflow/protocol.ts, src/plugins/workflow/repair.ts, src/plugins/workflow/state.ts, src/plugins/workflow/tooling.ts, src/plugins/workflow/transitions.ts]
//   LINKS: M-PLUGIN-WORKFLOW, M-ORCHESTRATION-PROFILES, M-WORKFLOW-PROTOCOL, M-WORKFLOW-REPAIR, M-WORKFLOW-STATE, M-WORKFLOW-TRANSITIONS, M-WORKFLOW-TOOLING, M-WORKFLOW-PERSISTENCE, M-WORKFLOW-DELEGATED, M-WORKFLOW-CHECKPOINTS, V-M-PLUGIN-WORKFLOW
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WorkflowPlugin - Registers workflow work-item tools, delegated control tools under the delegated profile, tracked task protocol enforcement with callID-bound delegated attempts and checkpoint linkage, and primary-session workflow guidance injection.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-DELEGATED-WORKFLOW-ASTRA-PRESETS - Added delegated control tools with root-session authorization, callID-bound attempts, checkpoint reviewer linkage, barrier gates, and checked persistence.]
// END_CHANGE_SUMMARY

import { type Plugin, tool } from "@opencode-ai/plugin";
import {
  attemptTrackedResultRepair,
  isTrackedResultRepairEligible,
  unwrapResumableTaskResult,
} from "./repair.js";
import {
  parseResultBlock,
  parseWorkItemHeader,
  TRACKED_SUBAGENT_NAMES,
  type TrackedAgentName,
} from "./protocol.js";
import {
  applyTrackedResult,
  createWorkflowResultExcerpt,
  beginTrackedLaunch,
  createWorkItemStore,
  getReviewRound,
  getWorkItem,
  revertReviewerLaunch,
  type WorkflowResultExcerpt,
  type WorkItemRecord,
  type WorkItemStore,
} from "./state.js";
import {
  applyDelegatedResult,
  beginDelegatedLaunch,
  revertInFlightDelegatedLaunches,
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
} from "./tooling.js";
import workflowSystemInstructionTemplate from "./system-instruction.md?raw";
import { loadVvocConfig } from "../../lib/config-layers.js";
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

const z = tool.schema;

const TRACKED_SUBAGENT_SET = new Set<string>(TRACKED_SUBAGENT_NAMES);
const WORK_ITEM_MISSING_MARKER = "__VVOC" + "_SECRET_BEARER_TOKEN_a6f582092f05__";
const INVALID_NEXT_AGENT_MARKER = "__VVOC" + "_SECRET_BEARER_TOKEN_513fa2de603d__";
const WORKFLOW_CONTROLLER_AGENT = "vv-controller";

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

Register an approved plan once with work_checkpoint register, start each declared review checkpoint
only after its prerequisite tasks are accepted, and run the due checkpoint before dependent waves.
A checkpoint passes only when every declared reviewer passes against the pinned snapshot; a closed
review-only FAIL report is a findings result, not approval. Do not write source files yourself:
delegate implementation edits, including fixes requested by reviewers, through bounded task
packets, while keeping planning artifacts, acceptance decisions, and verification commands in this
session.
</workflow_protocol>
`.trim();

/** Returns the exact workflow instruction compatible with one resolved policy. */
function getWorkflowSystemInstruction(policy: ResolvedOrchestrationPolicy): string {
  switch (policy.workflowGuidance) {
    case "review-only":
      return REVIEW_ONLY_WORKFLOW_SYSTEM_INSTRUCTION;
    case "selective":
      return SELECTIVE_WORKFLOW_SYSTEM_INSTRUCTION;
    case "tracked":
      return workflowSystemInstructionTemplate.trim();
    case "delegated":
      return DELEGATED_WORKFLOW_SYSTEM_INSTRUCTION;
  }
}

function isTrackedSubagent(value: unknown): value is TrackedAgentName {
  return typeof value === "string" && TRACKED_SUBAGENT_SET.has(value);
}

function readTaskSubagentType(args: unknown): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }

  const value = (args as { subagent_type?: unknown }).subagent_type;
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized || undefined;
}

function readTaskPrompt(args: unknown): string {
  if (!args || typeof args !== "object") {
    return "";
  }

  const value = (args as { prompt?: unknown }).prompt;
  if (typeof value !== "string") {
    return "";
  }

  return value;
}

function canUseWorkflowTools(agentName: string | undefined): boolean {
  return agentName === WORKFLOW_CONTROLLER_AGENT;
}

function assertWorkflowToolAccess(agentName: string | undefined, toolName: string): void {
  if (canUseWorkflowTools(agentName)) {
    return;
  }

  const resolvedAgent = agentName?.trim() || "unknown-agent";
  throw new Error(
    `WORKFLOW_TOOL_DENIED: ${toolName} is only available to ${WORKFLOW_CONTROLLER_AGENT} sessions. Current agent: ${resolvedAgent}.`,
  );
}

function shouldInjectForAgent(agentName: string | undefined): boolean {
  return canUseWorkflowTools(agentName);
}

function appendSystemInstruction(existingSystem: string | undefined, instruction: string): string {
  if (!existingSystem?.trim()) {
    return instruction;
  }
  if (existingSystem.includes(instruction)) {
    return existingSystem;
  }
  return `${existingSystem.trim()}\n\n${instruction}`;
}

function stringifyToolOutput(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
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

export const WorkflowPlugin: Plugin = async ({ client, directory, worktree }) => {
  const vvoc = await loadVvocConfig({ cwd: directory });
  if (!isVvocPluginEnabled(vvoc.config, "workflow")) return {};
  const resolvedPolicy = resolveOrchestrationPolicy(vvoc.config);
  const workflowSystemInstruction = getWorkflowSystemInstruction(resolvedPolicy);
  const delegatedProfileActive = resolvedPolicy.profile === "delegated";
  const trustedWorkspaceRoot = worktree || directory;

  // START_BLOCK_PERSISTENCE_SETUP
  // Each session (main or subagent) gets its own isolated store.
  // This prevents subagent tool calls from interfering with the main session's work items.
  // Hydration uses the checked loader: invalid persisted state is tracked so new
  // control transactions and snapshot writes fail closed instead of silently
  // resetting a malformed run.
  const stores = new Map<string, WorkItemStore>();
  const invalidHydrationSessions = new Set<string>();

  function getOrCreateStore(sessionId: string): WorkItemStore {
    let store = stores.get(sessionId);
    if (!store) {
      const hydrated = hydrateWorkflowStateChecked(sessionId);
      if (hydrated.status === "valid") {
        store = createWorkItemStore(hydrated.data);
        // A freshly hydrated session crossed a process-restart boundary: any
        // persisted in-flight delegated attempt can never receive its host
        // callback again, so reclaim it without consuming the attempt budget.
        const reclaimed = revertInFlightDelegatedLaunches(store.getStoreData(), sessionId);
        if (reclaimed.reverted > 0) {
          void client.app
            .log({
              body: {
                service: "workflow",
                level: "info",
                message:
                  "[workflow][hydration][BLOCK_RECLAIM_ATTEMPTS] orphaned in-flight delegated attempts reverted",
                extra: { sessionID: sessionId, workItemIds: reclaimed.workItemIds },
              },
            })
            .catch(() => undefined);
        }
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

  // START_BLOCK_DELEGATED_AUTHORIZATION
  // New control mutations require the primary vv-controller session: the calling
  // agent must be vv-controller, the session must be a root session (no
  // parentID), and the ToolContext workspace must match the plugin's trusted
  // directory/worktree. None of this identity comes from tool arguments.
  async function assertPrimaryControllerMutation(
    agent: string | undefined,
    sessionId: string,
    contextWorkspace: { directory?: string; worktree?: string },
    toolName: string,
  ): Promise<void> {
    if (!canUseWorkflowTools(agent)) {
      throw new Error(
        `CONTROL_DENIED: ${toolName} is only available to ${WORKFLOW_CONTROLLER_AGENT} sessions. Current agent: ${agent?.trim() || "unknown-agent"}.`,
      );
    }
    if (
      contextWorkspace.worktree !== undefined &&
      contextWorkspace.worktree !== worktree &&
      contextWorkspace.worktree !== trustedWorkspaceRoot
    ) {
      throw new Error(
        `CONTROL_DENIED: ${toolName} workspace ${contextWorkspace.worktree} does not match the trusted plugin workspace.`,
      );
    }
    if (
      contextWorkspace.worktree === undefined &&
      contextWorkspace.directory !== undefined &&
      contextWorkspace.directory !== directory
    ) {
      throw new Error(
        `CONTROL_DENIED: ${toolName} directory ${contextWorkspace.directory} does not match the trusted plugin directory.`,
      );
    }
    if (invalidHydrationSessions.has(sessionId)) {
      throw new Error(
        `CONTROL_DENIED: persisted workflow state for session ${sessionId} is invalid; resolve or remove it before new control mutations.`,
      );
    }

    let parentID: string | undefined;
    try {
      const response = await client.session.get({ path: { id: sessionId } });
      if (!response.data) {
        throw new Error("missing session payload");
      }
      parentID = response.data.parentID;
    } catch (error) {
      throw new Error(
        `CONTROL_DENIED: ${toolName} requires root-session identity for ${sessionId}, which could not be verified: ${(error as Error).message}`,
      );
    }
    if (parentID !== undefined && parentID !== null && parentID !== "") {
      throw new Error(
        `CONTROL_DENIED: ${toolName} may only run in the root session; session ${sessionId} is a child of ${parentID}.`,
      );
    }
  }
  // END_BLOCK_DELEGATED_AUTHORIZATION

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

  // START_BLOCK_PLUGIN_ENTRY
  // Tool wrappers still need a store reference for description/args shape
  // but execute handlers resolve the right store per-call
  const dummyStore = createWorkItemStore();
  const workItemOpenTool = createWorkItemOpenTool(dummyStore);
  const workItemListTool = createWorkItemListTool(dummyStore);
  const workItemCloseTool = createWorkItemCloseTool(dummyStore);
  const workItemDecideTool = createWorkItemDecideTool(dummyStore);
  const workCheckpointTool = createWorkCheckpointTool(dummyStore);

  return {
    tool: {
      work_item_open: tool({
        description: workItemOpenTool.description,
        args: {
          items: z.array(
            z.object({
              key: z.string(),
              title: z.string(),
              mode: z.string(),
              requiredReviewers: z.array(z.string()),
              writeScope: z.array(z.string()).optional(),
              planRunId: z.string().optional(),
              planTaskId: z.string().optional(),
            }),
          ),
        },
        async execute(args, context) {
          assertWorkflowToolAccess(context.agent, "work_item_open");
          const sessionStore = getOrCreateStore(context.sessionID);
          const opened = workItemOpenTool.execute(
            args,
            { sessionId: context.sessionID },
            sessionStore,
          );
          snapshotSession(context.sessionID);
          return stringifyToolOutput(opened);
        },
      }),
      work_item_list: tool({
        description: workItemListTool.description,
        args: {
          includeClosed: z.boolean().optional(),
        },
        async execute(args, context) {
          assertWorkflowToolAccess(context.agent, "work_item_list");
          const sessionStore = getOrCreateStore(context.sessionID);
          return stringifyToolOutput(
            workItemListTool.execute(args, { sessionId: context.sessionID }, sessionStore),
          );
        },
      }),
      work_item_close: tool({
        description: workItemCloseTool.description,
        args: {
          workItemId: z.string(),
        },
        async execute(args, context) {
          assertWorkflowToolAccess(context.agent, "work_item_close");
          const sessionStore = getOrCreateStore(context.sessionID);
          const closed = workItemCloseTool.execute(
            args,
            { sessionId: context.sessionID },
            sessionStore,
          );
          snapshotSession(context.sessionID);
          return stringifyToolOutput(closed);
        },
      }),
      // The delegated control tools are registered only under the delegated
      // startup profile; other profiles keep their current tool-schema footprint.
      ...(delegatedProfileActive
        ? {
            work_item_decide: tool({
              description: workItemDecideTool.description,
              args: {
                workItemId: z.string(),
                attempt: z.number().int().min(1),
                decision: z.enum(["accept", "request_changes", "rework"]),
                rationale: z.string(),
                evidence: z.array(z.string()),
                concernsDisposition: z.string().optional(),
                runId: z.string().optional(),
                checkpointId: z.string().optional(),
              },
              async execute(args, context) {
                // Resolve the store first so invalid persisted state is detected
                // before the authorization check reports it as a control denial.
                const sessionStore = getOrCreateStore(context.sessionID);
                await assertPrimaryControllerMutation(
                  context.agent,
                  context.sessionID,
                  { directory: context.directory, worktree: context.worktree },
                  "work_item_decide",
                );
                const decided = workItemDecideTool.execute(
                  args,
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
                return stringifyToolOutput(decided);
              },
            }),
            work_checkpoint: tool({
              description: workCheckpointTool.description,
              args: {
                action: z.enum(["register", "start", "verify"]),
                planPath: z.string().optional(),
                runId: z.string().optional(),
                checkpointId: z.string().optional(),
                complete: z.boolean().optional(),
              },
              async execute(args, context) {
                // Resolve the store first so invalid persisted state is detected
                // before the authorization check reports it as a control denial.
                const sessionStore = getOrCreateStore(context.sessionID);
                await assertPrimaryControllerMutation(
                  context.agent,
                  context.sessionID,
                  { directory: context.directory, worktree: context.worktree },
                  "work_checkpoint",
                );
                const toolContext = {
                  sessionId: context.sessionID,
                  workspaceRoot: trustedWorkspaceRoot,
                  loadPlan: async (planPath: string, workspaceRoot: string) => {
                    const loaded = await loadApprovedDelegatedPlan({ workspaceRoot, planPath });
                    return loaded.ok
                      ? loaded.plan
                      : { loadError: `${loaded.code}: ${loaded.message}` };
                  },
                };
                const result = await workCheckpointTool.execute(
                  { ...args },
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
                return stringifyToolOutput(result);
              },
            }),
          }
        : {}),
    },
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task") {
        return;
      }

      const subagentType = readTaskSubagentType(output.args);
      if (!isTrackedSubagent(subagentType)) {
        return;
      }

      const sessionStore = getOrCreateStore(input.sessionID);
      const header = parseWorkItemHeader(readTaskPrompt(output.args));
      if (!header.ok) {
        await client.app.log({
          body: {
            service: "workflow",
            level: "warn",
            message: "[workflow][launchValidation][BLOCK_VALIDATE_LAUNCH] launch rejected",
            extra: {
              sessionID: input.sessionID,
              agent: subagentType,
              reason: header.error.code,
            },
          },
        });
        throw new Error(`LAUNCH_REJECTED_MISSING_HEADER: ${header.error.message}`);
      }

      const workItem = getWorkItem(sessionStore, input.sessionID, header.value);
      if (!workItem || workItem.state === "closed") {
        await client.app.log({
          body: {
            service: "workflow",
            level: "warn",
            message: "[workflow][launchValidation][BLOCK_VALIDATE_LAUNCH] launch rejected",
            extra: {
              sessionID: input.sessionID,
              agent: subagentType,
              workItemId: header.value,
              reason: "WORK_ITEM_NOT_OPEN",
            },
          },
        });
        throw new Error(
          `${WORK_ITEM_MISSING_MARKER} LAUNCH_REJECTED_UNKNOWN_WORK_ITEM: no open work item ${header.value} exists in this session. Use work_item_open first or check state with work_item_list.`,
        );
      }

      const allowedNextAgents = getAllowedNextAgents(workItem);
      const reviewRound = getReviewRound(workItem);
      const attemptedRound =
        subagentType === "vv-implementer" ? getAttemptedImplementationRound(workItem) : reviewRound;
      const roundBlocked =
        workItem.mode === "implementation" &&
        subagentType === "vv-implementer" &&
        shouldBlockRound(attemptedRound);

      await client.app.log({
        body: {
          service: "workflow",
          level: "info",
          message: "[workflow][loopGate][BLOCK_CHECK_ROUND_LIMIT] round limit check",
          extra: {
            sessionID: input.sessionID,
            workItemId: workItem.workItemId,
            state: workItem.state,
            agent: subagentType,
            reviewRound,
            attemptedRound,
            blocked: roundBlocked,
          },
        },
      });

      if (roundBlocked) {
        await client.app.log({
          body: {
            service: "workflow",
            level: "warn",
            message: "[workflow][launchValidation][BLOCK_VALIDATE_LAUNCH] launch rejected",
            extra: {
              sessionID: input.sessionID,
              workItemId: workItem.workItemId,
              agent: subagentType,
              reviewRound,
            },
          },
        });
        throw new Error(createRoundLimitMessage(workItem, attemptedRound));
      }

      const launched = beginTrackedLaunch(sessionStore, {
        sessionId: input.sessionID,
        workItemId: workItem.workItemId,
        agent: subagentType,
      });
      if (!launched.ok) {
        await client.app.log({
          body: {
            service: "workflow",
            level: "warn",
            message: "[workflow][launchValidation][BLOCK_VALIDATE_LAUNCH] launch rejected",
            extra: {
              sessionID: input.sessionID,
              agent: subagentType,
              workItemId: workItem.workItemId,
              state: workItem.state,
              allowedNextAgents,
              reason: launched.errorCode,
            },
          },
        });
        throw new Error(
          `${INVALID_NEXT_AGENT_MARKER} LAUNCH_REJECTED_INVALID_TRANSITION: ${workItem.workItemId} in state ${workItem.state} only allows ${launched.allowedAgents.join(", ") || "no tracked agent"}. ${launched.message}`,
        );
      }

      // START_BLOCK_DELEGATED_LAUNCH_BINDING
      // Delegated implementer launches consume a callID-bound attempt after the
      // checkpoint barrier and overlapping-write gates pass. Reviewer launches
      // on a checkpoint-linked review item bind their call identity to the
      // current generation.
      if (workItem.mode === "delegated" && subagentType === "vv-implementer") {
        const data = sessionStore.getStoreData();
        const planRunId = workItem.delegated?.planRunId;
        if (planRunId) {
          const run = data.planRuns.get(planRunId);
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
        const delegatedLaunch = beginDelegatedLaunch(sessionStore, {
          sessionId: input.sessionID,
          workItemId: workItem.workItemId,
          callId: input.callID,
        });
        if (!delegatedLaunch.ok) {
          await client.app.log({
            body: {
              service: "workflow",
              level: "warn",
              message: "[workflow][launchValidation][BLOCK_VALIDATE_LAUNCH] launch rejected",
              extra: {
                sessionID: input.sessionID,
                agent: subagentType,
                workItemId: workItem.workItemId,
                reason: delegatedLaunch.errorCode,
              },
            },
          });
          throw new Error(
            `LAUNCH_REJECTED_DELEGATED_${delegatedLaunch.errorCode}: ${delegatedLaunch.message}`,
          );
        }
      } else {
        const reviewerRole = getReviewerRoleForAgent(subagentType);
        if (reviewerRole) {
          const linked = findCheckpointByReviewItem(input.sessionID, workItem.workItemId);
          if (linked) {
            const bound = recordCheckpointReviewerLaunch(sessionStore, {
              runId: linked.run.runId,
              checkpointId: linked.checkpointId,
              reviewer: reviewerRole,
              callId: input.callID,
            });
            if (!bound.ok) {
              revertReviewerLaunch(sessionStore, {
                sessionId: input.sessionID,
                workItemId: workItem.workItemId,
                agent: subagentType,
              });
              throw new Error(
                `LAUNCH_REJECTED_CHECKPOINT_REVIEW: ${bound.errorCode}: ${bound.message}`,
              );
            }
          }
        }
      }
      // END_BLOCK_DELEGATED_LAUNCH_BINDING

      snapshotSession(input.sessionID);

      await client.app.log({
        body: {
          service: "workflow",
          level: "info",
          message: "[workflow][launchValidation][BLOCK_VALIDATE_LAUNCH] launch validated",
          extra: {
            sessionID: input.sessionID,
            workItemId: workItem.workItemId,
            state: workItem.state,
            agent: subagentType,
            reviewRound,
            attemptedRound,
            mode: workItem.mode,
          },
        },
      });
    },
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "task") {
        return;
      }

      const subagentType = readTaskSubagentType(input.args);
      if (!isTrackedSubagent(subagentType)) {
        return;
      }

      const header = parseWorkItemHeader(readTaskPrompt(input.args));
      if (!header.ok) {
        await client.app.log({
          body: {
            service: "workflow",
            level: "warn",
            message: "[workflow][resultParsing][BLOCK_PARSE_RESULT] protocol error",
            extra: {
              sessionID: input.sessionID,
              agent: subagentType,
              reason: header.error.code,
            },
          },
        });
        throw new Error(`RESULT_PROTOCOL_ERROR: ${header.error.message}`);
      }

      // Revert an in-flight reviewer launch on any failure below so the work
      // item is not permanently stranded in REVIEWER_ALREADY_IN_FLIGHT. No-op
      // for implementer launches (they carry no in-flight reviewer slot).
      const revertLaunch = () => {
        const store = getOrCreateStore(input.sessionID);
        revertReviewerLaunch(store, {
          sessionId: input.sessionID,
          workItemId: header.value,
          agent: subagentType,
        });
        snapshotSession(input.sessionID);
      };

      if (typeof output.output !== "string") {
        await client.app.log({
          body: {
            service: "workflow",
            level: "warn",
            message: "[workflow][resultParsing][BLOCK_PARSE_RESULT] protocol error",
            extra: {
              sessionID: input.sessionID,
              agent: subagentType,
              reason: "INVALID_TASK_OUTPUT",
            },
          },
        });
        revertLaunch();
        throw new Error("RESULT_PROTOCOL_ERROR: tracked task output must be a string");
      }

      const unwrapped = unwrapResumableTaskResult(output.output);
      let effectiveNormalizedOutput = unwrapped.normalizedOutput;
      let parsed = parseResultBlock({
        agent: subagentType,
        output: effectiveNormalizedOutput,
        expectedWorkItemId: header.value,
      });
      if (!parsed.ok) {
        if (unwrapped.envelope && isTrackedResultRepairEligible(parsed.error.code)) {
          await client.app.log({
            body: {
              service: "workflow",
              level: "info",
              message: "[workflow][resultParsing][BLOCK_PARSE_RESULT] repair attempted",
              extra: {
                sessionID: input.sessionID,
                agent: subagentType,
                workItemId: header.value,
                taskId: unwrapped.envelope.taskId,
                reason: parsed.error.code,
                attempt: 1,
              },
            },
          });

          const repairedOutput = await attemptTrackedResultRepair({
            client,
            directory,
            taskId: unwrapped.envelope.taskId,
            agent: subagentType,
            workItemId: header.value,
            malformedOutput: unwrapped.normalizedOutput,
            parseErrorCode: parsed.error.code,
            parseErrorMessage: parsed.error.message,
          });

          if (repairedOutput) {
            effectiveNormalizedOutput = repairedOutput;
            parsed = parseResultBlock({
              agent: subagentType,
              output: effectiveNormalizedOutput,
              expectedWorkItemId: header.value,
            });
          }
        }
      }

      if (!parsed.ok) {
        const protocolFailureExcerpt = createWorkflowResultExcerpt({
          text: unwrapped.normalizedOutput,
          source: "normalized_output",
        });
        await client.app.log({
          body: {
            service: "workflow",
            level: "warn",
            message: "[workflow][resultParsing][BLOCK_PARSE_RESULT] protocol error",
            extra: {
              sessionID: input.sessionID,
              agent: subagentType,
              workItemId: header.value,
              reason: parsed.error.code,
            },
          },
        });
        revertLaunch();
        throw new Error(
          [
            `RESULT_PROTOCOL_ERROR: ${parsed.error.message}`,
            formatResultExcerptForError(protocolFailureExcerpt),
          ].join("\n"),
        );
      }

      const resultExcerpt = createResultExcerptForParsedOutput({
        body: parsed.value.body,
        normalizedOutput: effectiveNormalizedOutput,
      });

      await client.app.log({
        body: {
          service: "workflow",
          level: "info",
          message: "[workflow][resultParsing][BLOCK_PARSE_RESULT] result parsed",
          extra: {
            sessionID: input.sessionID,
            agent: subagentType,
            workItemId: parsed.value.workItemId,
            status: parsed.value.status,
            route: parsed.value.route,
          },
        },
      });

      const sessionStore = getOrCreateStore(input.sessionID);
      const current = getWorkItem(sessionStore, input.sessionID, parsed.value.workItemId);
      if (!current || current.state === "closed") {
        await client.app.log({
          body: {
            service: "workflow",
            level: "warn",
            message: "[workflow][resultParsing][BLOCK_PARSE_RESULT] protocol error",
            extra: {
              sessionID: input.sessionID,
              agent: subagentType,
              workItemId: parsed.value.workItemId,
              reason: "WORK_ITEM_NOT_OPEN",
            },
          },
        });
        revertLaunch();
        throw new Error(
          [
            `RESULT_PROTOCOL_ERROR: no open work item ${parsed.value.workItemId} exists in this session`,
            formatResultExcerptForError(resultExcerpt),
          ].join("\n"),
        );
      }

      // START_BLOCK_DELEGATED_RESULT_BINDING
      // Delegated implementer results apply to their matching callID-bound
      // attempt; reviewer results on checkpoint-linked review items are
      // recorded into the current generation before the legacy round applies.
      if (current.mode === "delegated" && subagentType === "vv-implementer") {
        const appliedDelegated = applyDelegatedResult(sessionStore, {
          sessionId: input.sessionID,
          workItemId: parsed.value.workItemId,
          callId: input.callID,
          resultStatus: parsed.value.status as
            | "DONE"
            | "DONE_WITH_CONCERNS"
            | "NEEDS_CONTEXT"
            | "BLOCKED",
          resultExcerpt,
        });
        if (!appliedDelegated.ok) {
          await client.app.log({
            body: {
              service: "workflow",
              level: "warn",
              message: "[workflow][resultParsing][BLOCK_PARSE_RESULT] protocol error",
              extra: {
                sessionID: input.sessionID,
                agent: subagentType,
                workItemId: parsed.value.workItemId,
                reason: appliedDelegated.errorCode,
              },
            },
          });
          throw new Error(
            [
              `RESULT_PROTOCOL_ERROR: ${appliedDelegated.message}`,
              formatResultExcerptForError(resultExcerpt),
            ].join("\n"),
          );
        }

        await client.app.log({
          body: {
            service: "workflow",
            level: "info",
            message: "[workflow][stateTransition][BLOCK_TRANSITION_STATE] state transitioned",
            extra: {
              sessionID: input.sessionID,
              agent: subagentType,
              workItemId: parsed.value.workItemId,
              fromState: appliedDelegated.fromState,
              toState: appliedDelegated.toState,
              mode: "delegated",
              attempt: appliedDelegated.attempt,
            },
          },
        });

        snapshotSession(input.sessionID);

        if (
          appliedDelegated.record.state === "needs_context" ||
          appliedDelegated.record.state === "blocked"
        ) {
          throw new Error(
            createHardStopMessage({
              record: appliedDelegated.record,
              triggeringAgent: subagentType,
              triggeringStatus: parsed.value.status,
              triggeringExcerpt: resultExcerpt,
            }),
          );
        }
        return;
      }

      const reviewerRoleForCheckpoint = getReviewerRoleForAgent(subagentType);
      if (reviewerRoleForCheckpoint) {
        const linked = findCheckpointByReviewItem(input.sessionID, parsed.value.workItemId);
        if (linked) {
          const recorded = recordCheckpointReviewerResult(sessionStore, {
            runId: linked.run.runId,
            checkpointId: linked.checkpointId,
            reviewer: reviewerRoleForCheckpoint,
            callId: input.callID,
            status: parsed.value.status as "PASS" | "FAIL" | "NEEDS_CONTEXT",
          });
          if (!recorded.ok) {
            await client.app.log({
              body: {
                service: "workflow",
                level: "warn",
                message: "[workflow][resultParsing][BLOCK_PARSE_RESULT] protocol error",
                extra: {
                  sessionID: input.sessionID,
                  agent: subagentType,
                  workItemId: parsed.value.workItemId,
                  reason: recorded.errorCode,
                },
              },
            });
            revertLaunch();
            throw new Error(
              [
                `RESULT_PROTOCOL_ERROR: checkpoint ${linked.checkpointId} rejected the reviewer result: ${recorded.message}`,
                formatResultExcerptForError(resultExcerpt),
              ].join("\n"),
            );
          }
        }
      }
      // END_BLOCK_DELEGATED_RESULT_BINDING

      const applied = applyTrackedResult(sessionStore, {
        sessionId: input.sessionID,
        workItemId: parsed.value.workItemId,
        result: parsed.value,
        resultExcerpt,
      });
      if (!applied.ok) {
        await client.app.log({
          body: {
            service: "workflow",
            level: "warn",
            message: "[workflow][resultParsing][BLOCK_PARSE_RESULT] protocol error",
            extra: {
              sessionID: input.sessionID,
              agent: subagentType,
              workItemId: parsed.value.workItemId,
              reason: applied.errorCode,
            },
          },
        });
        revertLaunch();
        throw new Error(
          [
            `RESULT_PROTOCOL_ERROR: ${applied.message}`,
            formatResultExcerptForError(resultExcerpt),
          ].join("\n"),
        );
      }

      await client.app.log({
        body: {
          service: "workflow",
          level: "info",
          message: "[workflow][stateTransition][BLOCK_TRANSITION_STATE] state transitioned",
          extra: {
            sessionID: input.sessionID,
            agent: subagentType,
            workItemId: parsed.value.workItemId,
            fromState: applied.fromState,
            toState: applied.record.state,
            specReviewCount: applied.record.specReviewCount,
            codeReviewCount: applied.record.codeReviewCount,
            reviewRound: getReviewRound(applied.record),
            aggregateComplete: applied.aggregateComplete,
          },
        },
      });

      snapshotSession(input.sessionID);

      if (applied.record.state === "needs_context" || applied.record.state === "blocked") {
        throw new Error(
          createHardStopMessage({
            record: applied.record,
            triggeringAgent: subagentType,
            triggeringStatus: parsed.value.status,
            triggeringExcerpt: resultExcerpt,
          }),
        );
      }
    },
    "chat.message": async (_input, output) => {
      if (!shouldInjectForAgent(output.message.agent)) {
        return;
      }

      output.message.system = appendSystemInstruction(
        output.message.system,
        workflowSystemInstruction,
      );
    },
    event: async (input) => {
      const eventType = (input.event as { type?: string }).type;
      const properties = (input.event as { properties?: Record<string, unknown> }).properties ?? {};
      const info = properties.info as { id?: string } | undefined;
      const eventSessionId = (properties.sessionID as string | undefined) ?? info?.id;

      if (!eventSessionId) return;

      // Hydration happens in tool.execute.before — not here,
      // because session.status fires for subagent child sessions too,
      // which would erroneously change persistedSessionId mid-flow.
      if (eventType === "session.status") {
        return;
      }

      if (eventType === "session.deleted") {
        stores.delete(eventSessionId);
        await deleteWorkflowSessionDir(eventSessionId);
        await client.app.log({
          body: {
            service: "workflow",
            level: "info",
            message: "[workflow][sessionCleanup][BLOCK_SESSION_CLEANUP] deleted",
            extra: {
              sessionID: eventSessionId,
            },
          },
        });
        return;
      }
    },
  };
};
// END_BLOCK_PLUGIN_ENTRY
