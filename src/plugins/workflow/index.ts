// FILE: src/plugins/workflow/index.ts
// VERSION: 0.2.5
// START_MODULE_CONTRACT
//   PURPOSE: Register workflow work-item tools, tracked task launch/result hooks, and primary-session workflow guidance injection.
//   SCOPE: work_item_open/list/close tool registration, tracked launch validation on task tool, OpenCode task-result wrapper normalization, one-shot resumable result repair, tracked result parsing/state transitions, round-limit gating, and chat.message guidance injection with subagent filtering.
//   DEPENDS: [@opencode-ai/plugin, src/lib/managed-agents.ts, src/plugins/workflow/protocol.ts, src/plugins/workflow/repair.ts, src/plugins/workflow/state.ts, src/plugins/workflow/transitions.ts, src/plugins/workflow/tooling.ts]
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
//   LAST_CHANGE: [v0.2.5 - Limited resumable result repair to safe format-only protocol errors and disabled tool use during repair prompts where supported.]
//   LAST_CHANGE: [v0.2.4 - Added a single same-session repair attempt for malformed tracked results inside recognized resumable OpenCode task envelopes.]
//   LAST_CHANGE: [v0.2.3 - Tightened OpenCode task-result envelope detection to the known resumable task header shape before unwrapping.]
//   LAST_CHANGE: [v0.2.2 - Restricted task-result wrapper extraction to recognized OpenCode task envelopes so foreign `<task_result>` text still fails strict parsing.]
//   LAST_CHANGE: [v0.2.1 - Extracted inner OpenCode `<task_result>` content before strict tracked result parsing so task wrapper metadata does not trip protocol validation.]
//   LAST_CHANGE: [v0.2.0 - Used transition-policy checks so fresh work items can start with reviewer subagents for review-only workflows.]
//   LAST_CHANGE: [v0.1.1 - Excluded helper primary agents like enhancer from workflow guidance injection because they cannot participate in tracked workflow tooling.]
//   LAST_CHANGE: [v0.1.0 - Added workflow plugin integration with tool wiring, tracked launch/result hooks, loop-gate enforcement, and primary-session guidance injection.]
// END_CHANGE_SUMMARY

import { type Config, type Plugin, tool } from "@opencode-ai/plugin";
import { MANAGED_SUBAGENT_NAMES } from "../../lib/managed-agents.js";
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
  createWorkItemStore,
  getReviewRound,
  getWorkItem,
  transitionWorkItemState,
  type WorkItemRecord,
} from "./state.js";
import {
  getAllowedNextAgent,
  getNextState,
  isAllowedTransition,
  shouldBlockRound,
} from "./transitions.js";
import {
  createWorkItemCloseTool,
  createWorkItemListTool,
  createWorkItemOpenTool,
} from "./tooling.js";
import workflowSystemInstructionTemplate from "./system-instruction.md?raw";
import { isPluginEnabled } from "../../lib/plugin-toggle-config.js";

const z = tool.schema;

const BUILT_IN_SUBAGENTS = ["general", "explore"] as const;
const PLUGIN_MANAGED_SUBAGENTS = ["guardian"] as const;
const INTERNAL_PRIMARY_AGENTS = ["compaction", "title", "summary"] as const;
const HELPER_PRIMARY_AGENTS = ["enhancer"] as const;
const TRACKED_SUBAGENT_SET = new Set<string>(TRACKED_SUBAGENT_NAMES);
const WORK_ITEM_MISSING_MARKER = "__VVOC" + "_SECRET_BEARER_TOKEN_a6f582092f05__";
const INVALID_NEXT_AGENT_MARKER = "__VVOC" + "_SECRET_BEARER_TOKEN_513fa2de603d__";

const WORKFLOW_SYSTEM_INSTRUCTION = workflowSystemInstructionTemplate.trim();

type AgentConfigShape = {
  mode?: unknown;
};

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

function createKnownSubagentSet(): Set<string> {
  return new Set([
    ...BUILT_IN_SUBAGENTS,
    ...PLUGIN_MANAGED_SUBAGENTS,
    ...MANAGED_SUBAGENT_NAMES,
    ...TRACKED_SUBAGENT_NAMES,
  ]);
}

function syncConfiguredSubagents(config: Config, knownSubagents: Set<string>): void {
  for (const [name, definition] of Object.entries(config.agent ?? {})) {
    if ((definition as AgentConfigShape | undefined)?.mode === "subagent") {
      knownSubagents.add(name);
    }
  }
}

function shouldInjectForAgent(agentName: string | undefined, knownSubagents: Set<string>): boolean {
  if (!agentName) {
    return false;
  }
  if (knownSubagents.has(agentName)) {
    return false;
  }
  if (INTERNAL_PRIMARY_AGENTS.includes(agentName as (typeof INTERNAL_PRIMARY_AGENTS)[number])) {
    return false;
  }
  if (HELPER_PRIMARY_AGENTS.includes(agentName as (typeof HELPER_PRIMARY_AGENTS)[number])) {
    return false;
  }
  return true;
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
    "LAUNCH_REJECTED_ROUND_LIMIT: review loop gate blocked tracked launch before entering round 3.",
    `Work item ${record.workItemId} is in state ${record.state} at reviewRound=${getReviewRound(record)} and cannot start round ${attemptedRound}.`,
    "Next action: call work_item_list for this session, resolve concerns with explicit context, then open/continue a fresh work item instead of retrying the same loop.",
  ].join(" ");
}

// START_BLOCK_PLUGIN_ENTRY
export const WorkflowPlugin: Plugin = async ({ client, directory }) => {
  if (!(await isPluginEnabled("workflow"))) return {};
  const store = createWorkItemStore();
  const knownSubagents = createKnownSubagentSet();

  const workItemOpenTool = createWorkItemOpenTool(store);
  const workItemListTool = createWorkItemListTool(store);
  const workItemCloseTool = createWorkItemCloseTool(store);

  return {
    config: async (config) => {
      syncConfiguredSubagents(config, knownSubagents);
    },
    tool: {
      work_item_open: tool({
        description: workItemOpenTool.description,
        args: {
          items: z.array(
            z.object({
              key: z.string(),
              title: z.string(),
            }),
          ),
        },
        async execute(args, context) {
          return stringifyToolOutput(
            workItemOpenTool.execute(args, {
              sessionId: context.sessionID,
            }),
          );
        },
      }),
      work_item_list: tool({
        description: workItemListTool.description,
        args: {
          includeClosed: z.boolean().optional(),
        },
        async execute(args, context) {
          return stringifyToolOutput(
            workItemListTool.execute(args, {
              sessionId: context.sessionID,
            }),
          );
        },
      }),
      work_item_close: tool({
        description: workItemCloseTool.description,
        args: {
          workItemId: z.string(),
        },
        async execute(args, context) {
          return stringifyToolOutput(
            workItemCloseTool.execute(args, {
              sessionId: context.sessionID,
            }),
          );
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

      const workItem = getWorkItem(store, input.sessionID, header.value);
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

      const allowedNextAgent = getAllowedNextAgent(workItem.state);
      if (!isAllowedTransition(workItem.state, subagentType)) {
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
              allowedNextAgent,
              reason: "INVALID_NEXT_AGENT",
            },
          },
        });
        throw new Error(
          `${INVALID_NEXT_AGENT_MARKER} LAUNCH_REJECTED_INVALID_TRANSITION: ${workItem.workItemId} in state ${workItem.state} only allows ${allowedNextAgent ?? "no tracked agent"}.`,
        );
      }

      const reviewRound = getReviewRound(workItem);
      const attemptedRound = subagentType === "vv-implementer" ? reviewRound + 1 : reviewRound;
      const roundBlocked = subagentType === "vv-implementer" && shouldBlockRound(attemptedRound);

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
      let parsed = parseResultBlock({
        agent: subagentType,
        output: unwrapped.normalizedOutput,
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
            parseErrorMessage: parsed.error.message,
          });

          if (repairedOutput) {
            parsed = parseResultBlock({
              agent: subagentType,
              output: repairedOutput,
              expectedWorkItemId: header.value,
            });
          }
        }
      }

      if (!parsed.ok) {
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
        throw new Error(`RESULT_PROTOCOL_ERROR: ${parsed.error.message}`);
      }

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

      const current = getWorkItem(store, input.sessionID, parsed.value.workItemId);
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
          `RESULT_PROTOCOL_ERROR: no open work item ${parsed.value.workItemId} exists in this session`,
        );
      }

      const nextState = getNextState(current.state, parsed.value);
      const transitioned = transitionWorkItemState(store, {
        sessionId: input.sessionID,
        workItemId: parsed.value.workItemId,
        state: nextState,
        actor: subagentType,
      });
      if (!transitioned.ok) {
        await client.app.log({
          body: {
            service: "workflow",
            level: "warn",
            message: "[workflow][resultParsing][BLOCK_PARSE_RESULT] protocol error",
            extra: {
              sessionID: input.sessionID,
              agent: subagentType,
              workItemId: parsed.value.workItemId,
              reason: transitioned.errorCode,
            },
          },
        });
        throw new Error(`RESULT_PROTOCOL_ERROR: ${transitioned.message}`);
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
            fromState: current.state,
            toState: transitioned.record.state,
            specReviewCount: transitioned.record.specReviewCount,
            codeReviewCount: transitioned.record.codeReviewCount,
          },
        },
      });

      if (parsed.value.status === "NEEDS_CONTEXT" || parsed.value.status === "BLOCKED") {
        throw new Error(
          `RESULT_HARD_STOP: ${parsed.value.status} requires explicit user action. Inspect work_item_list before retrying.`,
        );
      }
    },
    "chat.message": async (_input, output) => {
      if (!shouldInjectForAgent(output.message.agent, knownSubagents)) {
        return;
      }

      output.message.system = appendSystemInstruction(
        output.message.system,
        WORKFLOW_SYSTEM_INSTRUCTION,
      );
    },
  };
};
// END_BLOCK_PLUGIN_ENTRY
