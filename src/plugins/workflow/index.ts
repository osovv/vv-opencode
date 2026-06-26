// FILE: src/plugins/workflow/index.ts
// VERSION: 0.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Register workflow work-item tools, tracked task launch/result hooks, recovery excerpt propagation, and primary-session workflow guidance injection.
//   SCOPE: work_item_open/list/close tool registration, explicit tracked launch validation on task tool, OpenCode task-result wrapper normalization, one-shot resumable result repair, tracked result parsing/round aggregation with bounded excerpts, implementation-mode round-limit gating, and chat.message guidance injection with subagent filtering.
//   DEPENDS: [@opencode-ai/plugin, src/lib/config-layers.ts, src/lib/managed-agents.ts, src/lib/plugin-toggle-config.ts, src/plugins/workflow/protocol.ts, src/plugins/workflow/repair.ts, src/plugins/workflow/state.ts, src/plugins/workflow/transitions.ts, src/plugins/workflow/tooling.ts]
//   LINKS: [M-PLUGIN-WORKFLOW, M-WORKFLOW-PROTOCOL, M-WORKFLOW-REPAIR, M-WORKFLOW-STATE, M-WORKFLOW-TRANSITIONS, M-WORKFLOW-TOOLING]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   WorkflowPlugin - Registers workflow work-item tools, tracked task protocol enforcement, and primary-session workflow guidance injection.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.4.1 - Propagated bounded tracked-result excerpts through protocol errors, state-application errors, hard stops, and persisted work-item state.]
//   LAST_CHANGE: [v0.4.0 - Read plugin toggles from the shared startup vvoc config snapshot.]
//   LAST_CHANGE: [v0.3.0 - Integrated explicit work-item intent, reviewer in-flight tracking, and collect-all review-round result aggregation.]
//   LAST_CHANGE: [v0.2.6 - Restricted work-item tools and workflow guidance injection to vv-controller sessions only.]
//   LAST_CHANGE: [v0.2.5 - Limited resumable result repair to safe format-only protocol errors and disabled tool use during repair prompts where supported.]
//   LAST_CHANGE: [v0.2.4 - Added a single same-session repair attempt for malformed tracked results inside recognized resumable OpenCode task envelopes.]
//   LAST_CHANGE: [v0.2.3 - Tightened OpenCode task-result envelope detection to the known resumable task header shape before unwrapping.]
//   LAST_CHANGE: [v0.2.2 - Restricted task-result wrapper extraction to recognized OpenCode task envelopes so foreign `<task_result>` text still fails strict parsing.]
//   LAST_CHANGE: [v0.2.1 - Extracted inner OpenCode `<task_result>` content before strict tracked result parsing so task wrapper metadata does not trip protocol validation.]
//   LAST_CHANGE: [v0.2.0 - Used transition-policy checks so fresh work items can start with reviewer subagents for review-only workflows.]
//   LAST_CHANGE: [v0.1.1 - Excluded helper primary agents like enhancer from workflow guidance injection because they cannot participate in tracked workflow tooling.]
//   LAST_CHANGE: [v0.1.0 - Added workflow plugin integration with tool wiring, tracked launch/result hooks, loop-gate enforcement, and primary-session guidance injection.]
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
  type WorkflowResultExcerpt,
  type WorkItemRecord,
  type WorkItemStore,
} from "./state.js";
import {
  getAllowedNextAgents,
  getAttemptedImplementationRound,
  shouldBlockRound,
} from "./transitions.js";
import {
  createWorkItemCloseTool,
  createWorkItemListTool,
  createWorkItemOpenTool,
} from "./tooling.js";
import workflowSystemInstructionTemplate from "./system-instruction.md?raw";
import { loadVvocConfig } from "../../lib/config-layers.js";
import { isVvocPluginEnabled } from "../../lib/plugin-toggle-config.js";
import {
  deleteWorkflowSessionDir,
  hydrateWorkflowState,
  snapshotWorkflowState,
} from "./persistence.js";

const z = tool.schema;

const TRACKED_SUBAGENT_SET = new Set<string>(TRACKED_SUBAGENT_NAMES);
const WORK_ITEM_MISSING_MARKER = "__VVOC" + "_SECRET_BEARER_TOKEN_a6f582092f05__";
const INVALID_NEXT_AGENT_MARKER = "__VVOC" + "_SECRET_BEARER_TOKEN_513fa2de603d__";
const WORKFLOW_CONTROLLER_AGENT = "vv-controller";

const WORKFLOW_SYSTEM_INSTRUCTION = workflowSystemInstructionTemplate.trim();

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

// START_BLOCK_PLUGIN_ENTRY
export const WorkflowPlugin: Plugin = async ({ client, directory }) => {
  const vvoc = await loadVvocConfig({ cwd: directory });
  if (!isVvocPluginEnabled(vvoc.config, "workflow")) return {};

  // START_BLOCK_PERSISTENCE_SETUP
  // Each session (main or subagent) gets its own isolated store.
  // This prevents subagent tool calls from interfering with the main session's work items.
  const stores = new Map<string, WorkItemStore>();

  function getOrCreateStore(sessionId: string): WorkItemStore {
    let store = stores.get(sessionId);
    if (!store) {
      const hydrated = hydrateWorkflowState(sessionId);
      store = createWorkItemStore(hydrated);
      stores.set(sessionId, store);
    }
    return store;
  }

  function snapshotSession(sessionId: string): void {
    const store = stores.get(sessionId);
    if (store) {
      try {
        snapshotWorkflowState(sessionId, store.getStoreData());
      } catch {
        // Snapshot failures are non-blocking
      }
    }
  }
  // END_BLOCK_PERSISTENCE_SETUP

  // Tool wrappers still need a store reference for description/args shape
  // but execute handlers resolve the right store per-call
  const dummyStore = createWorkItemStore();
  const workItemOpenTool = createWorkItemOpenTool(dummyStore);
  const workItemListTool = createWorkItemListTool(dummyStore);
  const workItemCloseTool = createWorkItemCloseTool(dummyStore);

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
        throw new Error(
          [
            `RESULT_PROTOCOL_ERROR: no open work item ${parsed.value.workItemId} exists in this session`,
            formatResultExcerptForError(resultExcerpt),
          ].join("\n"),
        );
      }

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
        WORKFLOW_SYSTEM_INSTRUCTION,
      );
    },
    event: async (input) => {
      const eventType = (input.event as { type?: string }).type;
      const properties = (input.event as { properties?: Record<string, unknown> }).properties ?? {};
      const eventSessionId = properties.sessionID as string | undefined;

      if (!eventSessionId) return;

      // Hydration happens in tool.execute.before — not here,
      // because session.status fires for subagent child sessions too,
      // which would erroneously change persistedSessionId mid-flow.
      if (eventType === "session.status") {
        return;
      }

      if (eventType === "session.deleted") {
        await deleteWorkflowSessionDir(eventSessionId);
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
