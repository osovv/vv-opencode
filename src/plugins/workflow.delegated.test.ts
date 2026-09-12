// FILE: src/plugins/workflow.delegated.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify WorkflowPlugin delegated integration: control-tool registration and authorization, callID-bound attempts, checkpoint linkage through real hooks, bounded recovery, terminal report-rejection settlement, and legacy-profile isolation.
//   SCOPE: Delegated-only tool registration, root-session and workspace authorization denial, unauthorized self-acceptance, unknown root-session data, stale call callbacks, premature close bypass, checkpoint register/start/verify/recover through the tool wrapper with hook-driven reviewer results, barrier-blocked launches, invalid persisted state denial, event-hook host-terminal launch failures with sticky exclusions and persistence recovery, same-child malformed-result continuation with SDK-derived prompt fixtures that preserves the original attempt identity, pre-checkpoint bounded recovery after exhaustion with autonomous denial and root-user message extension plus replay rejection, terminal malformed hard-stop settlement as a rejected report with a reachable recovery path, staged recovery persistence failure that keeps launches blocked, final completion refusing skipped reviewers after checkpoint recovery, and old-profile regressions.
//   DEPENDS: [bun:test, node:fs, node:fs/promises, node:os, node:path, @opencode-ai/sdk, src/lib/config-layers.ts, src/lib/vvoc-config.ts, src/plugins/workflow/index.ts, src/plugins/workflow/persistence.ts, src/plugins/workflow/protocol.ts]
//   LINKS: [M-PLUGIN-WORKFLOW, M-WORKFLOW-DELEGATED, M-WORKFLOW-CHECKPOINTS, M-WORKFLOW-PERSISTENCE, V-M-PLUGIN-WORKFLOW]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ROOT_SESSION - Stable root session identifier shared by delegated plugin fixtures.
//   previousConfigHome - Preserves the caller's config-home environment for cleanup.
//   previousDataHome - Preserves the caller's data-home environment for cleanup.
//   dataHome - Isolated per-process XDG data home for persistence fixtures.
//   cleanupPaths - Tracks temporary workspaces for cleanup after each test.
//   StubSession - Minimal session stub shape with an optional parentID.
//   DelegatedPluginHarness - Captured plugin hooks, tools, logs, prompt calls, and workspace paths for one delegated fixture.
//   DelegatedSessionPromptCall - SDK-derived session.prompt request recorded for continuation assertions.
//   DelegatedSessionPromptResponse - SDK-derived session.prompt response with a valid assistant message and text part.
//   DelegatedSessionPromptError - SDK-derived session.prompt error consumed by continuation.
//   DelegatedSessionPromptResult - Narrowed SDK session.prompt data/error boundary consumed by continuation.
//   delegatedAssistantMessage - Builds a valid SDK AssistantMessage fixture for one session.
//   delegatedTextPart - Builds a valid SDK TextPart response fixture.
//   delegatedPromptResponse - Builds a valid SDK session.prompt response fixture.
//   writeProfile - Writes an isolated orchestration profile fixture.
//   specXml - Renders the approved spec fixture for the task pipeline.
//   PlanTaskInput - Task index and wave pairing used by the plan builder.
//   planXml - Renders the approved delegated plan fixture with waves and checkpoints.
//   buildDelegatedWorkspace - Writes an approved spec/plan package and scope files for one harness.
//   createStubToolContext - Builds an SDK-shaped ToolContext stub bound to the harness workspace.
//   createDelegatedPluginHarness - Creates an isolated delegated-profile plugin harness bound to a temporary workspace.
//   parseToolJson - Parses structured tool output into typed payloads.
//   registerPlan - Registers the fixture plan through the real work_checkpoint tool.
//   taskWorkItemId - Resolves the bound work-item id for one plan task through work_item_list.
//   launchTask - Drives the tool.execute.before hook for one tracked launch.
//   launchTaskWithArgs - Drives the before hook with extra SDK-shaped launch arguments.
//   finishTask - Drives the tool.execute.after hook for one tracked result.
//   finishTaskWithRawOutput - Drives the after hook with raw tracked task output for continuation tests.
//   wrapTaskResult - Wraps tracked output in an OpenCode task-result envelope.
//   taskToolPart - Builds a real SDK-shaped ToolPart for one parent task call.
//   taskPartUpdated - Wraps a ToolPart in a real message.part.updated event.
//   runningState - Builds a real SDK-shaped running ToolState with host metadata.
//   errorState - Builds a real SDK-shaped error ToolState with a host error.
//   emitPart - Delivers one message.part.updated event through the plugin event hook.
//   listItems - Reads the current work-item list through the real tool.
//   decide - Calls work_item_decide with a stub controller context.
//   driveAcceptedTask - Runs one delegated task from launch to controller acceptance through hooks and tools.
//   DelegatedUserMessageStub - Minimal SDK-shaped message snapshot served for authorization lookups.
//   checkpointCall - Calls the work_checkpoint tool with a stub controller context.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-WORKFLOW-BOUNDED-RECOVERY-R1 - Added integration coverage: tool-level bounded recovery with autonomous denial and root-user message authorization plus replay rejection, terminal malformed hard-stop settlement, staged recovery persistence failure, and post-recovery final completion that still refuses skipped reviewers.]
// END_CHANGE_SUMMARY

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  EventMessagePartUpdated,
  OpencodeClient,
  SessionPromptErrors,
  SessionPromptResponses,
  TextPart,
  ToolPart,
  ToolStateError,
  ToolStateRunning,
} from "@opencode-ai/sdk";
import { resetVvocConfigForTests } from "../lib/config-layers.js";
import type { OrchestrationProfile } from "../lib/orchestration.js";
import { createDefaultVvocConfig, renderVvocConfig } from "../lib/vvoc-config.js";
import { WorkflowPlugin } from "./workflow/index.js";
import { deleteWorkflowSessionDir, getWorkflowSessionDir } from "./workflow/persistence.js";
import type { ParsedResultBlock } from "./workflow/protocol.js";

const ROOT_SESSION = "ses_delegated_root";
const previousConfigHome = process.env.XDG_CONFIG_HOME;
let previousDataHome: string | undefined;
let dataHome: string;

const cleanupPaths: string[] = [];

type StubSession = { parentID?: string };

type DelegatedSessionPromptCall = Parameters<OpencodeClient["session"]["prompt"]>[0];
type DelegatedSessionPromptResponse = SessionPromptResponses[keyof SessionPromptResponses];
type DelegatedSessionPromptError = SessionPromptErrors[keyof SessionPromptErrors];
type DelegatedSessionPromptResult =
  | { data: DelegatedSessionPromptResponse; error?: undefined }
  | { data?: undefined; error: DelegatedSessionPromptError };

function delegatedAssistantMessage(sessionID: string): AssistantMessage {
  return {
    id: `msg_${sessionID}`,
    sessionID,
    role: "assistant",
    time: { created: 1 },
    parentID: `msg_parent_${sessionID}`,
    modelID: "deepseek-flash",
    providerID: "deepseek",
    mode: "build",
    path: { cwd: "/tmp/project", root: "/tmp/project" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function delegatedTextPart(sessionID: string, text: string): TextPart {
  return {
    id: `part_${sessionID}`,
    sessionID,
    messageID: `msg_${sessionID}`,
    type: "text",
    text,
  };
}

function delegatedPromptResponse(sessionID: string, text: string): DelegatedSessionPromptResponse {
  return {
    info: delegatedAssistantMessage(sessionID),
    parts: [delegatedTextPart(sessionID, text)],
  };
}

interface DelegatedPluginHarness {
  plugin: Awaited<ReturnType<typeof WorkflowPlugin>>;
  logs: string[];
  workspaceRoot: string;
  planPath: string;
  sessions: Map<string, StubSession>;
  sessionGetFails: boolean;
  promptCalls: DelegatedSessionPromptCall[];
  promptResponses: string[];
  /** Identity/timing snapshots served by the SDK session.message stub. */
  userMessages: Map<string, DelegatedUserMessageStub>;
  messageLookups: string[];
}

/** Minimal SDK-shaped message snapshot served for authorization lookups. */
interface DelegatedUserMessageStub {
  role?: string;
  sessionID?: string;
  id?: string;
  timeCreatedMs?: number;
  /** Simulates an unreachable lookup instead of a missing message. */
  transportError?: boolean;
}

beforeEach(() => {
  resetVvocConfigForTests();
  previousDataHome = process.env.XDG_DATA_HOME;
  dataHome = `/tmp/vvoc-delegated-data-${process.pid}`;
  rmSync(dataHome, { recursive: true, force: true });
  mkdirSync(dataHome, { recursive: true });
  process.env.XDG_DATA_HOME = dataHome;
  process.env.XDG_CONFIG_HOME = `/tmp/vvoc-delegated-empty-config-${process.pid}`;
  rmSync(process.env.XDG_CONFIG_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  resetVvocConfigForTests();
  rmSync(`/tmp/vvoc-delegated-empty-config-${process.pid}`, { recursive: true, force: true });
  await deleteWorkflowSessionDir(ROOT_SESSION);
  if (previousDataHome !== undefined) {
    process.env.XDG_DATA_HOME = previousDataHome;
  } else {
    delete process.env.XDG_DATA_HOME;
  }
  if (previousConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

function writeProfile(profile: OrchestrationProfile): void {
  const configHome = process.env.XDG_CONFIG_HOME;
  if (!configHome) throw new Error("XDG_CONFIG_HOME required");
  const config = createDefaultVvocConfig();
  config.orchestration = { profile };
  const configDir = join(configHome, "vvoc");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "vvoc.json"), renderVvocConfig(config), "utf8");
}

function specXml(taskCount: number): string {
  return `<spec><status>approved</status><goal>Deliver ${taskCount} delegated tasks.</goal><architecture>Pipeline of independent tasks.</architecture><tech_stack>TypeScript.</tech_stack><components>
    <COMPONENT-TASK-PIPELINE>
      <name>Task Pipeline</name>
      <responsibility>Deliver ${taskCount} bounded delegated tasks.</responsibility>
      <depends_on></depends_on>
    </COMPONENT-TASK-PIPELINE>
  </components><data_flow>Tasks flow through the delegated loop.</data_flow><error_handling>Fail closed.</error_handling><testing><strategy>Unit tests per task.</strategy><coverage>All task files.</coverage></testing><non_goals><non_goal>No scheduler.</non_goal></non_goals></spec>`;
}

interface PlanTaskInput {
  index: number;
  wave: number;
}

function planXml(
  taskCount: number,
  checkpointWaves: number[],
  taskWave: (index: number) => number,
): string {
  const waves = new Map<number, number[]>();
  for (const task of Array.from(
    { length: taskCount },
    (_, index): PlanTaskInput => ({ index: index + 1, wave: taskWave(index + 1) }),
  )) {
    const bucket = waves.get(task.wave) ?? [];
    bucket.push(task.index);
    waves.set(task.wave, bucket);
  }
  const maxWave = Math.max(...checkpointWaves);
  const waveBlocks = [...waves.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([wave, indices]) => {
      const tasks = indices
        .map((index) => {
          const id = String(index).padStart(3, "0");
          return `      <TASK-T-${id}>
        <title>Task ${index}</title>
        <file>src/tasks/task-${id}.ts</file>
        <status>pending</status>
        <description>Deliver task ${index}.</description>
        <depends_on></depends_on>
        <acceptance>
          <criterion>Task ${index} test passes</criterion>
        </acceptance>
        <verification>
          <command>bun test src/tasks/task-${id}.test.ts</command>
        </verification>
        <write_scope>
          <file>src/tasks/task-${id}.ts</file>
          <file>src/tasks/task-${id}.test.ts</file>
        </write_scope>
      </TASK-T-${id}>`;
        })
        .join("\n");
      return `    <WAVE-${wave}>\n      <goal>Wave ${wave}.</goal>\n${tasks}\n    </WAVE-${wave}>`;
    })
    .join("\n");

  const allTaskIds = Array.from(
    { length: taskCount },
    (_, index) => `T-${String(index + 1).padStart(3, "0")}`,
  );
  const checkpoints: string[] = [];
  checkpointWaves.forEach((wave, index) => {
    const isFinal = wave === maxWave;
    const id = String(index + 1).padStart(3, "0");
    const coveredTasks = isFinal
      ? allTaskIds
      : allTaskIds.filter((taskId) => {
          const taskNumber = Number(taskId.slice("T-".length));
          return taskWave(taskNumber) <= wave;
        });
    const covers = coveredTasks
      .map((taskId) => `          <task_id>${taskId}</task_id>`)
      .join("\n");
    const scope = coveredTasks
      .flatMap((taskId) => {
        const taskNumber = Number(taskId.slice("T-".length));
        const id = String(taskNumber).padStart(3, "0");
        return [
          `          <file>src/tasks/task-${id}.ts</file>`,
          `          <file>src/tasks/task-${id}.test.ts</file>`,
        ];
      })
      .join("\n");
    const reviewers = isFinal ? ["spec", "code"] : ["code"];
    checkpoints.push(`      <CHECKPOINT-R-${id}>
        <kind>${isFinal ? "final" : "milestone"}</kind>
        <after_wave>WAVE-${wave}</after_wave>
        <covers>
${covers}
        </covers>
        <scope>
${scope}
        </scope>
        <reviewers>
${reviewers.map((reviewer) => `          <reviewer>${reviewer}</reviewer>`).join("\n")}
        </reviewers>
        <acceptance>
          <criterion>Checkpoint ${id} reviewed</criterion>
        </acceptance>
        <verification>
          <command>bun test</command>
        </verification>
      </CHECKPOINT-R-${id}>`);
  });

  return `<plan><spec>spec.xml</spec><created>2026-09-11</created><status>approved</status>
  <meta><summary>${taskCount} delegated tasks.</summary><waves>${maxWave}</waves><affected_modules>src/tasks</affected_modules><complexity>medium</complexity></meta>
  <architecture><COMPONENT-TASK-PIPELINE><name>Task Pipeline</name><purpose>Deliver tasks.</purpose><file><path>src/tasks</path><role>implementation</role></file><contract>deliver.</contract><depends_on></depends_on></COMPONENT-TASK-PIPELINE></architecture>
  <tasks>
${waveBlocks}
  </tasks>
  <execution><mode>delegated</mode>
    <review_checkpoints>
${checkpoints.join("\n")}
    </review_checkpoints>
  </execution>
</plan>`;
}

async function buildDelegatedWorkspace(
  taskCount: number,
  checkpointWaves: number[],
  taskWave: (index: number) => number,
): Promise<{ workspaceRoot: string; planPath: string }> {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "vvoc-delegated-ws-"));
  cleanupPaths.push(workspaceRoot);
  const pkgDir = join(workspaceRoot, ".vvoc", "specs", "2026-09-11-delegated");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "spec.xml"), specXml(taskCount), "utf8");
  writeFileSync(join(pkgDir, "plan.xml"), planXml(taskCount, checkpointWaves, taskWave), "utf8");
  mkdirSync(join(workspaceRoot, "src", "tasks"), { recursive: true });
  for (let index = 1; index <= taskCount; index++) {
    const id = String(index).padStart(3, "0");
    writeFileSync(
      join(workspaceRoot, "src", "tasks", `task-${id}.ts`),
      `export const task${index} = true;\n`,
      "utf8",
    );
    writeFileSync(
      join(workspaceRoot, "src", "tasks", `task-${id}.test.ts`),
      `test("task ${index}", () => {});\n`,
      "utf8",
    );
  }
  return { workspaceRoot, planPath: join(pkgDir, "plan.xml") };
}

function createStubToolContext(
  harness: DelegatedPluginHarness,
  sessionID: string,
  agent = "vv-controller",
) {
  return {
    sessionID,
    messageID: "message-1",
    agent,
    directory: harness.workspaceRoot,
    worktree: harness.workspaceRoot,
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

async function createDelegatedPluginHarness(
  workspaceRoot: string,
  profile: OrchestrationProfile = "delegated",
  options?: { promptResponses?: string[] },
): Promise<DelegatedPluginHarness> {
  resetVvocConfigForTests();
  writeProfile(profile);
  const logs: string[] = [];
  const sessions = new Map<string, StubSession>();
  const promptCalls: DelegatedSessionPromptCall[] = [];
  const promptResponses = [...(options?.promptResponses ?? [])];
  const userMessages = new Map<string, DelegatedUserMessageStub>();
  const messageLookups: string[] = [];
  const harness: DelegatedPluginHarness = {
    logs,
    workspaceRoot,
    planPath: "",
    sessions,
    sessionGetFails: false,
    promptCalls,
    promptResponses,
    userMessages,
    messageLookups,
    plugin: undefined as never,
  };
  const plugin = await WorkflowPlugin({
    client: {
      app: {
        log: async (payload: { body?: { message?: string } }) => {
          const message = payload.body?.message;
          if (typeof message === "string") logs.push(message);
        },
      },
      session: {
        get: async (options: { path: { id: string } }) => {
          if (harness.sessionGetFails) {
            throw new Error("session service unavailable");
          }
          const stub = sessions.get(options.path.id) ?? {};
          return { data: { id: options.path.id, parentID: stub.parentID, title: "stub" } };
        },
        prompt: async (call: DelegatedSessionPromptCall): Promise<DelegatedSessionPromptResult> => {
          promptCalls.push(call);
          const text = promptResponses.shift();
          if (text === undefined) {
            return {
              data: undefined,
              error: { name: "BadRequest", data: { message: "prompt unavailable" } },
            };
          }
          return { data: delegatedPromptResponse(call.path.id, text) };
        },
        message: async (options: { path: { id: string; messageID: string } }) => {
          const key = `${options.path.id}::${options.path.messageID}`;
          messageLookups.push(key);
          const stub = userMessages.get(key);
          if (!stub) {
            return {
              data: undefined,
              error: { name: "NotFound", data: { message: "message not found" } },
            };
          }
          if (stub.transportError) {
            throw new Error("session service unavailable");
          }
          return {
            data: {
              info: {
                role: stub.role ?? "user",
                sessionID: stub.sessionID ?? options.path.id,
                id: stub.id ?? options.path.messageID,
                time: { created: stub.timeCreatedMs ?? Date.now() },
              },
              parts: [],
            },
          };
        },
      },
    } as never,
    project: {} as never,
    directory: workspaceRoot,
    worktree: workspaceRoot,
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL("http://localhost"),
    $: {} as never,
  });
  harness.plugin = plugin;
  return harness;
}

function parseToolJson<T>(value: unknown): T {
  const text =
    typeof value === "string"
      ? value
      : value &&
          typeof value === "object" &&
          typeof (value as { output?: unknown }).output === "string"
        ? (value as { output: string }).output
        : "{}";
  return JSON.parse(text) as T;
}

async function registerPlan(
  harness: DelegatedPluginHarness,
  planPath: string,
  sessionID = ROOT_SESSION,
): Promise<string> {
  const registeredRaw = await harness.plugin.tool?.work_checkpoint?.execute(
    { action: "register", planPath } as never,
    createStubToolContext(harness, sessionID) as never,
  );
  const registered = parseToolJson<{ ok: boolean; runId?: string; message?: string }>(
    registeredRaw ?? "{}",
  );
  if (!registered.ok || !registered.runId) throw new Error(registered.message ?? "register failed");
  return registered.runId;
}

async function taskWorkItemId(
  harness: DelegatedPluginHarness,
  runId: string,
  taskId: string,
  sessionID = ROOT_SESSION,
): Promise<string> {
  const listedRaw = await harness.plugin.tool?.work_item_list?.execute(
    { includeClosed: true },
    createStubToolContext(harness, sessionID) as never,
  );
  const listed = parseToolJson<{
    planRuns?: Array<{ runId: string; tasks: Array<{ taskId: string; workItemId: string }> }>;
  }>(listedRaw ?? "{}");
  const run = listed.planRuns?.find((entry) => entry.runId === runId);
  const binding = run?.tasks.find((task) => task.taskId === taskId);
  if (!binding) throw new Error(`missing binding for ${taskId}`);
  return binding.workItemId;
}

async function launchTask(
  harness: DelegatedPluginHarness,
  sessionID: string,
  callId: string,
  subagentType: "vv-implementer" | "vv-spec-reviewer" | "vv-code-reviewer",
  workItemId: string,
): Promise<void> {
  await harness.plugin["tool.execute.before"]?.(
    { tool: "task", sessionID, callID: callId } as never,
    {
      args: {
        subagent_type: subagentType,
        prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\n<assignment>Run tracked task</assignment>`,
      },
    } as never,
  );
}

async function launchTaskWithArgs(
  harness: DelegatedPluginHarness,
  sessionID: string,
  callId: string,
  subagentType: string,
  prompt: string,
  extraArgs: Record<string, unknown>,
): Promise<void> {
  await harness.plugin["tool.execute.before"]?.(
    { tool: "task", sessionID, callID: callId } as never,
    { args: { subagent_type: subagentType, prompt, ...extraArgs } } as never,
  );
}

function runningState(metadata: Record<string, unknown>, start = 1): ToolStateRunning {
  return { status: "running", input: {}, metadata, time: { start } };
}

function errorState(error: string, metadata: Record<string, unknown>): ToolStateError {
  return { status: "error", input: {}, error, metadata, time: { start: 1, end: 2 } };
}

function taskToolPart(
  parentSessionId: string,
  callId: string,
  state: ToolStateRunning | ToolStateError,
): ToolPart {
  return {
    id: `part-${callId}`,
    sessionID: parentSessionId,
    messageID: "message-1",
    type: "tool",
    callID: callId,
    tool: "task",
    state,
  };
}

function taskPartUpdated(part: ToolPart): EventMessagePartUpdated {
  return { type: "message.part.updated", properties: { part } };
}

async function emitPart(harness: DelegatedPluginHarness, part: ToolPart): Promise<void> {
  await harness.plugin.event?.({ event: taskPartUpdated(part) } as never);
}

async function listItems(harness: DelegatedPluginHarness) {
  return parseToolJson<{
    items: Array<{
      workItemId: string;
      state: string;
      delegated?: {
        attempts: number;
        inFlightAttempt: boolean;
        accepted: boolean;
        attemptBudget?: number;
        remainingAttempts?: number;
        recoveryCount?: number;
        autonomousGrantConsumed?: boolean;
        reportRejectionCount?: number;
        nextAction?: string;
      };
    }>;
    planRuns?: Array<{
      runId: string;
      checkpoints: Array<{
        checkpointId: string;
        status: string;
        attempts: number;
        generationBudget?: number;
        remainingGenerations?: number;
        recoveryCount?: number;
        nextAction?: string;
        lastOutcome?: string;
      }>;
    }>;
  }>(
    (await harness.plugin.tool?.work_item_list?.execute(
      { includeClosed: true },
      createStubToolContext(harness, ROOT_SESSION) as never,
    )) ?? "{}",
  );
}

async function checkpointCall(
  harness: DelegatedPluginHarness,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const raw = await harness.plugin.tool?.work_checkpoint?.execute(
    args as never,
    createStubToolContext(harness, ROOT_SESSION) as never,
  );
  return parseToolJson<Record<string, unknown>>(raw ?? "{}");
}

async function finishTask(
  harness: DelegatedPluginHarness,
  sessionID: string,
  callId: string,
  subagentType: "vv-implementer" | "vv-spec-reviewer" | "vv-code-reviewer",
  workItemId: string,
  status: ParsedResultBlock["status"],
  body = "Done.",
): Promise<void> {
  const route = subagentType === "vv-implementer" ? "\nVVOC_ROUTE: change_with_review" : "";
  await harness.plugin["tool.execute.after"]?.(
    {
      tool: "task",
      sessionID,
      callID: callId,
      args: {
        subagent_type: subagentType,
        prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\n<assignment>Run tracked task</assignment>`,
      },
    } as never,
    {
      title: "task",
      output: `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: ${status}${route}\n\n${body}`,
      metadata: {},
    } as never,
  );
}

async function finishTaskWithRawOutput(
  harness: DelegatedPluginHarness,
  sessionID: string,
  callId: string,
  subagentType: "vv-implementer" | "vv-spec-reviewer" | "vv-code-reviewer",
  workItemId: string,
  output: string,
): Promise<void> {
  await harness.plugin["tool.execute.after"]?.(
    {
      tool: "task",
      sessionID,
      callID: callId,
      args: {
        subagent_type: subagentType,
        prompt: `VVOC_WORK_ITEM_ID: ${workItemId}\n<assignment>Run tracked task</assignment>`,
      },
    } as never,
    { title: "task", output, metadata: {} } as never,
  );
}

function wrapTaskResult(taskId: string, innerResult: string): string {
  return [
    `task_id: ${taskId} (for resuming to continue this task if needed)`,
    "",
    "<task_result>",
    innerResult,
    "</task_result>",
  ].join("\n");
}

async function decide(
  harness: DelegatedPluginHarness,
  input: {
    workItemId: string;
    attempt: number;
    decision: "accept" | "request_changes" | "rework" | "recover";
    rationale?: string;
    evidence?: string[];
    concernsDisposition?: string;
    runId?: string;
    checkpointId?: string;
    diagnosis?: string;
    changedCondition?: string;
    verification?: string[];
    recoveryId?: string;
    userMessageId?: string;
  },
  sessionID = ROOT_SESSION,
  agent = "vv-controller",
): Promise<Record<string, unknown>> {
  const raw = await harness.plugin.tool?.work_item_decide?.execute(
    {
      rationale: "",
      evidence: [],
      ...input,
    } as never,
    createStubToolContext(harness, sessionID, agent) as never,
  );
  return parseToolJson<Record<string, unknown>>(raw ?? "{}");
}

async function driveAcceptedTask(
  harness: DelegatedPluginHarness,
  runId: string,
  taskId: string,
  sessionID = ROOT_SESSION,
): Promise<void> {
  const workItemId = await taskWorkItemId(harness, runId, taskId, sessionID);
  await launchTask(harness, sessionID, `call-${taskId}-launch`, "vv-implementer", workItemId);
  await finishTask(
    harness,
    sessionID,
    `call-${taskId}-launch`,
    "vv-implementer",
    workItemId,
    "DONE",
  );
  const accepted = await decide(harness, {
    workItemId,
    attempt: 1,
    decision: "accept",
    rationale: "Diff matches the task contract.",
    evidence: ["src/tasks"],
  });
  if (accepted.ok !== true) throw new Error(String(accepted.message ?? "accept failed"));
}

// START_BLOCK_AUTHORIZATION_TESTS
describe("delegated control-tool authorization", () => {
  test("registers control tools independent of profile with root authorization", async () => {
    const { workspaceRoot } = await buildDelegatedWorkspace(1, [1], () => 1);
    const delegatedHarness = await createDelegatedPluginHarness(workspaceRoot, "delegated");
    expect(delegatedHarness.plugin.tool?.work_item_decide).toBeDefined();
    expect(delegatedHarness.plugin.tool?.work_checkpoint).toBeDefined();

    const balancedHarness = await createDelegatedPluginHarness(workspaceRoot, "balanced");
    expect(balancedHarness.plugin.tool?.work_item_decide).toBeDefined();
    expect(balancedHarness.plugin.tool?.work_checkpoint).toBeDefined();
    expect(balancedHarness.plugin.tool?.work_item_open).toBeDefined();
  });

  test("generic registration succeeds as the first workflow call of a fresh session", async () => {
    const { workspaceRoot } = await buildDelegatedWorkspace(1, [1], () => 1);
    const harness = await createDelegatedPluginHarness(workspaceRoot, "balanced");
    const raw = await harness.plugin.tool?.work_item_open?.execute(
      {
        items: [
          {
            key: "generic-first",
            title: "Generic first task",
            mode: "delegated",
            requiredReviewers: [],
            taskId: "T-100",
            writeScope: ["src/tasks"],
            acceptanceCriteria: ["Task works."],
          },
        ],
        execution: {
          executionKey: "generic-first",
          source: { kind: "conversation-scoped" },
          goal: "Register a generic execution first.",
          boundary: { files: ["src/tasks"], directories: [] },
        },
      } as never,
      createStubToolContext(harness, ROOT_SESSION) as never,
    );
    const parsed = parseToolJson<{ ok: boolean; runId?: string; message?: string }>(raw ?? "{}");
    expect(parsed.ok).toBe(true);
    expect(parsed.runId).toBeTruthy();
  });

  test("denies self-acceptance, child sessions, unknown session data, and untrusted workspaces", async () => {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(1, [1], () => 1);
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(harness, planPath);
    const workItemId = await taskWorkItemId(harness, runId, "T-001");
    await launchTask(harness, ROOT_SESSION, "call-auth-1", "vv-implementer", workItemId);
    await finishTask(harness, ROOT_SESSION, "call-auth-1", "vv-implementer", workItemId, "DONE");

    const selfAcceptance = await harness.plugin.tool?.work_item_decide
      ?.execute(
        {
          workItemId,
          attempt: 1,
          decision: "accept",
          rationale: "Self acceptance from the worker session.",
          evidence: ["diff"],
        } as never,
        createStubToolContext(harness, ROOT_SESSION, "vv-implementer") as never,
      )
      .catch((error: Error) => error.message);
    expect(String(selfAcceptance)).toContain("CONTROL_DENIED");

    harness.sessions.set(ROOT_SESSION, { parentID: "ses_parent" });
    const deniedChild = await harness.plugin.tool?.work_item_decide
      ?.execute(
        {
          workItemId,
          attempt: 1,
          decision: "accept",
          rationale: "Child controller attempt.",
          evidence: ["diff"],
        } as never,
        createStubToolContext(harness, ROOT_SESSION, "vv-controller") as never,
      )
      .catch((error: Error) => error.message);
    expect(String(deniedChild)).toContain("root session");
    harness.sessions.delete(ROOT_SESSION);

    harness.sessionGetFails = true;
    const unknownSession = await harness.plugin.tool?.work_item_decide
      ?.execute(
        {
          workItemId,
          attempt: 1,
          decision: "accept",
          rationale: "Unknown identity.",
          evidence: ["diff"],
        } as never,
        createStubToolContext(harness, ROOT_SESSION) as never,
      )
      .catch((error: Error) => error.message);
    expect(String(unknownSession)).toContain("could not be verified");
    harness.sessionGetFails = false;

    const untrusted = {
      ...createStubToolContext(harness, ROOT_SESSION),
      worktree: "/tmp/untrusted-workspace",
    };
    const deniedWorkspace = await harness.plugin.tool?.work_checkpoint
      ?.execute(
        { action: "start", runId, checkpointId: "CHECKPOINT-R-001" } as never,
        untrusted as never,
      )
      .catch((error: Error) => error.message);
    expect(String(deniedWorkspace)).toContain("does not match the trusted plugin workspace");
  });

  test("invalid persisted state denies new control mutations instead of resetting", async () => {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(1, [1], () => 1);
    const firstHarness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(firstHarness, planPath);
    expect(runId).toBeTruthy();

    // Corrupt the persisted snapshot on disk; a fresh plugin instance must fail
    // closed on control mutations instead of silently restarting the run.
    const statePath = join(dataHome, "vvoc", "workflow", ROOT_SESSION, "workflow-state.json");
    expect(existsSync(statePath)).toBe(true);
    writeFileSync(statePath, "{ not valid json", "utf8");

    const secondHarness = await createDelegatedPluginHarness(workspaceRoot);
    const denied = await secondHarness.plugin.tool?.work_checkpoint
      ?.execute(
        { action: "start", runId, checkpointId: "CHECKPOINT-R-001" } as never,
        createStubToolContext(secondHarness, ROOT_SESSION) as never,
      )
      .catch((error: Error) => error.message);
    expect(String(denied)).toContain("invalid");
  });
});
// END_BLOCK_AUTHORIZATION_TESTS

// START_BLOCK_DELEGATED_FLOW_TESTS
describe("delegated attempt flow through plugin hooks", () => {
  test("DONE waits for acceptance, stale callbacks fail, and accept closes the loop", async () => {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(1, [1], () => 1);
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(harness, planPath);
    const workItemId = await taskWorkItemId(harness, runId, "T-001");

    await launchTask(harness, ROOT_SESSION, "call-flow-1", "vv-implementer", workItemId);

    const stale = finishTask(
      harness,
      ROOT_SESSION,
      "call-stale",
      "vv-implementer",
      workItemId,
      "DONE",
    ).catch((error: Error) => error.message);
    await expect(stale).resolves.toContain("STALE_CALLBACK");

    await finishTask(harness, ROOT_SESSION, "call-flow-1", "vv-implementer", workItemId, "DONE");
    const listedAfterDone = parseToolJson<{
      items: Array<{ state: string; delegated?: { accepted: boolean } }>;
    }>(
      (await harness.plugin.tool?.work_item_list?.execute(
        { includeClosed: false },
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(listedAfterDone.items[0]?.state).toBe("awaiting_acceptance");
    expect(listedAfterDone.items[0]?.delegated?.accepted).toBe(false);

    const closedBypass = await harness.plugin.tool?.work_item_close
      ?.execute({ workItemId } as never, createStubToolContext(harness, ROOT_SESSION) as never)
      .catch((error: unknown) => error);
    const closedParsed =
      typeof closedBypass === "string"
        ? parseToolJson<{ ok: boolean; message?: string }>(closedBypass)
        : closedBypass;
    expect(
      typeof closedParsed === "string" ? closedParsed : JSON.stringify(closedParsed),
    ).toContain("READY_TO_CLOSE_REQUIRED");

    const accepted = await decide(harness, {
      workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "Verified the implementation and tests.",
      evidence: ["src/tasks/task-001.ts"],
    });
    expect(accepted.ok).toBe(true);
    if (accepted.ok !== true) return;
    expect(accepted.state).toBe("ready_to_close");
  });

  test("a malformed wrapped result continues the same child once without a new attempt", async () => {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(1, [1], () => 1);
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(harness, planPath);
    const workItemId = await taskWorkItemId(harness, runId, "T-001");
    harness.promptResponses.push(
      `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: DONE\nVVOC_ROUTE: change_with_review\n\nFinished the original task after continuation.`,
    );

    await launchTask(harness, ROOT_SESSION, "call-continuation", "vv-implementer", workItemId);
    await finishTaskWithRawOutput(
      harness,
      ROOT_SESSION,
      "call-continuation",
      "vv-implementer",
      workItemId,
      wrapTaskResult("ses_delegated_continuation", "Plain progress without a protocol header."),
    );

    expect(harness.promptCalls).toHaveLength(1);
    const call = harness.promptCalls[0];
    expect(call?.path.id).toBe("ses_delegated_continuation");
    expect(call?.body?.agent).toBe("vv-implementer");
    expect(call?.body?.tools).toBeUndefined();
    expect(call?.body !== undefined && "tools" in call.body).toBe(false);

    const listed = await listItems(harness);
    const item = listed.items.find((entry) => entry.workItemId === workItemId);
    expect(item?.state).toBe("awaiting_acceptance");
    expect(item?.delegated?.attempts).toBe(1);
    expect(item?.delegated?.inFlightAttempt).toBe(false);

    // The continuation is bound to the original call identity, so the
    // controller accepts attempt 1 rather than a silent new attempt.
    const accepted = await decide(harness, {
      workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "Diff matches the task contract.",
      evidence: ["src/tasks"],
    });
    expect(accepted.ok).toBe(true);
  });

  test("barriers block dependent-wave launches until the milestone passes", async () => {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(2, [1, 2], (index) =>
      index === 1 ? 1 : 2,
    );
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(harness, planPath);
    const t1 = await taskWorkItemId(harness, runId, "T-001");
    const t2 = await taskWorkItemId(harness, runId, "T-002");

    const blocked = launchTask(harness, ROOT_SESSION, "call-t2-early", "vv-implementer", t2).catch(
      (error: Error) => error.message,
    );
    await expect(blocked).resolves.toContain("LAUNCH_REJECTED_CHECKPOINT_BARRIER");

    await launchTask(harness, ROOT_SESSION, "call-t1-1", "vv-implementer", t1);
    await finishTask(harness, ROOT_SESSION, "call-t1-1", "vv-implementer", t1, "DONE");
    await decide(harness, {
      workItemId: t1,
      attempt: 1,
      decision: "accept",
      rationale: "Wave 1 accepted.",
      evidence: ["src/tasks/task-001.ts"],
    });

    const startRaw = await harness.plugin.tool?.work_checkpoint?.execute(
      { action: "start", runId, checkpointId: "CHECKPOINT-R-001" } as never,
      createStubToolContext(harness, ROOT_SESSION) as never,
    );
    const started = parseToolJson<{
      ok: boolean;
      reviewWorkItemId?: string;
      reviewersToLaunch?: string[];
      message?: string;
    }>(startRaw ?? "{}");
    expect(started.ok).toBe(true);
    if (!started.ok || !started.reviewWorkItemId) return;
    expect(started.reviewersToLaunch).toEqual(["code"]);

    await launchTask(
      harness,
      ROOT_SESSION,
      "call-rv-code",
      "vv-code-reviewer",
      started.reviewWorkItemId,
    );
    await finishTask(
      harness,
      ROOT_SESSION,
      "call-rv-code",
      "vv-code-reviewer",
      started.reviewWorkItemId,
      "PASS",
    );

    const verifyRaw = await harness.plugin.tool?.work_checkpoint?.execute(
      { action: "verify", runId, checkpointId: "CHECKPOINT-R-001" } as never,
      createStubToolContext(harness, ROOT_SESSION) as never,
    );
    const verified = parseToolJson<{ ok: boolean; outcome?: string }>(verifyRaw ?? "{}");
    expect(verified.ok).toBe(true);
    if (verified.ok !== true) return;
    expect(verified.outcome).toBe("passed");

    await launchTask(harness, ROOT_SESSION, "call-t2-1", "vv-implementer", t2);
    const listed = parseToolJson<{ items: Array<{ workItemId: string; state: string }> }>(
      (await harness.plugin.tool?.work_item_list?.execute(
        { includeClosed: false },
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(listed.items.find((item) => item.workItemId === t2)?.state).toBe("awaiting_implementer");
  });

  test("mutated approved plan content is explicit drift at checkpoint verify", async () => {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(1, [1], () => 1);
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(harness, planPath);
    await driveAcceptedTask(harness, runId, "T-001");
    await harness.plugin.tool?.work_checkpoint?.execute(
      { action: "start", runId, checkpointId: "CHECKPOINT-R-001" } as never,
      createStubToolContext(harness, ROOT_SESSION) as never,
    );

    writeFileSync(
      planPath,
      readFileSync(planPath, "utf8").replace("<waves>1</waves>", "<waves>9</waves>"),
      "utf8",
    );
    const verifyRaw = await harness.plugin.tool?.work_checkpoint?.execute(
      { action: "verify", runId, checkpointId: "CHECKPOINT-R-001" } as never,
      createStubToolContext(harness, ROOT_SESSION) as never,
    );
    const verified = parseToolJson<{ ok: boolean; errorCode?: string; message?: string }>(
      verifyRaw ?? "{}",
    );
    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.errorCode).toBe("PLAN_DRIFT");
  });

  test("content changed during review makes the checkpoint stale instead of passing", async () => {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(2, [1, 2], (index) => index);
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(harness, planPath);
    await driveAcceptedTask(harness, runId, "T-001");

    const started = parseToolJson<{ ok: boolean; reviewWorkItemId?: string }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        { action: "start", runId, checkpointId: "CHECKPOINT-R-001" } as never,
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(started.ok).toBe(true);
    if (!started.ok || !started.reviewWorkItemId) return;
    await launchTask(
      harness,
      ROOT_SESSION,
      "rv-stale-code",
      "vv-code-reviewer",
      started.reviewWorkItemId,
    );

    writeFileSync(
      join(workspaceRoot, "src", "tasks", "task-001.ts"),
      "export const task1 = 'changed during review';\n",
      "utf8",
    );
    await finishTask(
      harness,
      ROOT_SESSION,
      "rv-stale-code",
      "vv-code-reviewer",
      started.reviewWorkItemId,
      "PASS",
    );

    const verified = parseToolJson<{ ok: boolean; outcome?: string }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        { action: "verify", runId, checkpointId: "CHECKPOINT-R-001" } as never,
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(verified.outcome).toBe("stale");
  });

  test("failed final checkpoint authorizes bounded rework and completion through the tools", async () => {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(2, [2], (index) => index);
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(harness, planPath);
    await driveAcceptedTask(harness, runId, "T-001");
    await driveAcceptedTask(harness, runId, "T-002");

    const started = parseToolJson<{ ok: boolean; reviewWorkItemId?: string }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        { action: "start", runId, checkpointId: "CHECKPOINT-R-001" } as never,
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(started.ok).toBe(true);
    if (!started.ok || !started.reviewWorkItemId) return;
    await launchTask(
      harness,
      ROOT_SESSION,
      "rv-fail-spec",
      "vv-spec-reviewer",
      started.reviewWorkItemId,
    );
    await launchTask(
      harness,
      ROOT_SESSION,
      "rv-fail-code",
      "vv-code-reviewer",
      started.reviewWorkItemId,
    );
    await finishTask(
      harness,
      ROOT_SESSION,
      "rv-fail-spec",
      "vv-spec-reviewer",
      started.reviewWorkItemId,
      "FAIL",
    );
    await finishTask(
      harness,
      ROOT_SESSION,
      "rv-fail-code",
      "vv-code-reviewer",
      started.reviewWorkItemId,
      "PASS",
    );

    const failed = parseToolJson<{ ok: boolean; outcome?: string }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        { action: "verify", runId, checkpointId: "CHECKPOINT-R-001" } as never,
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(failed.outcome).toBe("failed");

    // A closed review-only FAIL report never satisfies the completion gate.
    const closedReport = parseToolJson<{ ok: boolean }>(
      (await harness.plugin.tool?.work_item_close?.execute(
        { workItemId: started.reviewWorkItemId } as never,
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(closedReport.ok).toBe(true);
    const prematureComplete = parseToolJson<{ ok: boolean; errorCode?: string }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        { action: "verify", runId, checkpointId: "CHECKPOINT-R-001", complete: true } as never,
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(prematureComplete.ok).toBe(false);

    // Rework the covered accepted task, correct it, re-accept, and complete.
    const t2 = await taskWorkItemId(harness, runId, "T-002");
    const reworked = await decide(harness, {
      workItemId: t2,
      attempt: 1,
      decision: "rework",
      rationale: "Spec review found a missing branch.",
      evidence: ["review findings"],
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    expect(reworked.ok).toBe(true);

    await launchTask(harness, ROOT_SESSION, "call-t2-fix", "vv-implementer", t2);
    await finishTask(harness, ROOT_SESSION, "call-t2-fix", "vv-implementer", t2, "DONE");
    const corrected = await decide(harness, {
      workItemId: t2,
      attempt: 2,
      decision: "accept",
      rationale: "Correction verified.",
      evidence: ["src/tasks/task-002.ts"],
    });
    expect(corrected.ok).toBe(true);

    const restarted = parseToolJson<{ ok: boolean; reviewWorkItemId?: string }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        { action: "start", runId, checkpointId: "CHECKPOINT-R-001" } as never,
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(restarted.ok).toBe(true);
    if (!restarted.ok || !restarted.reviewWorkItemId) return;
    await launchTask(
      harness,
      ROOT_SESSION,
      "rv-fix-spec",
      "vv-spec-reviewer",
      restarted.reviewWorkItemId,
    );
    await launchTask(
      harness,
      ROOT_SESSION,
      "rv-fix-code",
      "vv-code-reviewer",
      restarted.reviewWorkItemId,
    );
    await finishTask(
      harness,
      ROOT_SESSION,
      "rv-fix-spec",
      "vv-spec-reviewer",
      restarted.reviewWorkItemId,
      "PASS",
    );
    await finishTask(
      harness,
      ROOT_SESSION,
      "rv-fix-code",
      "vv-code-reviewer",
      restarted.reviewWorkItemId,
      "PASS",
    );

    const sealed = parseToolJson<{ ok: boolean; sealedRun?: boolean }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        { action: "verify", runId, checkpointId: "CHECKPOINT-R-001", complete: true } as never,
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(sealed.sealedRun).toBe(true);
  });

  test("a fresh plugin instance resumes a hydrated unfinished run", async () => {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(1, [1], () => 1);
    const firstHarness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(firstHarness, planPath);
    await driveAcceptedTask(firstHarness, runId, "T-001");
    await firstHarness.plugin.tool?.work_checkpoint?.execute(
      { action: "start", runId, checkpointId: "CHECKPOINT-R-001" } as never,
      createStubToolContext(firstHarness, ROOT_SESSION) as never,
    );

    const secondHarness = await createDelegatedPluginHarness(workspaceRoot);
    const started = parseToolJson<{ ok: boolean; reviewWorkItemId?: string; errorCode?: string }>(
      (await secondHarness.plugin.tool?.work_checkpoint?.execute(
        { action: "start", runId, checkpointId: "CHECKPOINT-R-001" } as never,
        createStubToolContext(secondHarness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.errorCode).toBe("ALREADY_IN_REVIEW");
  });

  test("an attempt orphaned by a restart is reclaimed at hydration without consuming budget", async () => {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(1, [1], () => 1);
    const firstHarness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(firstHarness, planPath);
    const workItemId = await taskWorkItemId(firstHarness, runId, "T-001");
    await launchTask(firstHarness, ROOT_SESSION, "call-orphan", "vv-implementer", workItemId);

    // A fresh plugin instance simulates the restart: the persisted in-flight
    // attempt's host call can never arrive, so hydration reclaims it.
    const secondHarness = await createDelegatedPluginHarness(workspaceRoot);
    await launchTask(secondHarness, ROOT_SESSION, "call-reclaimed", "vv-implementer", workItemId);
    await finishTask(
      secondHarness,
      ROOT_SESSION,
      "call-reclaimed",
      "vv-implementer",
      workItemId,
      "DONE",
    );
    const accepted = await decide(secondHarness, {
      workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "Reclaimed attempt verified.",
      evidence: ["src/tasks/task-001.ts"],
    });
    expect(accepted.ok).toBe(true);

    const listed = parseToolJson<{
      items: Array<{ workItemId: string; delegated?: { attempts: number; accepted: boolean } }>;
    }>(
      (await secondHarness.plugin.tool?.work_item_list?.execute(
        { includeClosed: false },
        createStubToolContext(secondHarness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    const item = listed.items.find((entry) => entry.workItemId === workItemId);
    expect(item?.delegated?.attempts).toBe(1);
    expect(item?.delegated?.accepted).toBe(true);
  });
});
// END_BLOCK_DELEGATED_FLOW_TESTS

// START_BLOCK_DELEGATED_FAILURE_EVENTS
describe("confirmed host-terminal launch failures through the event hook", () => {
  const CHILD = "ses_delegated_child";

  async function harnessWithTask(): Promise<{
    harness: DelegatedPluginHarness;
    workItemId: string;
  }> {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(1, [1], () => 1);
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(harness, planPath);
    const workItemId = await taskWorkItemId(harness, runId, "T-001");
    return { harness, workItemId };
  }

  function foregroundMetadata(child = CHILD): Record<string, unknown> {
    return { parentSessionId: ROOT_SESSION, sessionId: child, model: {} };
  }

  test("records a failed attempt without an after hook and allows an explicit retry", async () => {
    const { harness, workItemId } = await harnessWithTask();
    await launchTask(harness, ROOT_SESSION, "call-ev-1", "vv-implementer", workItemId);

    const metadata = foregroundMetadata();
    await emitPart(harness, taskToolPart(ROOT_SESSION, "call-ev-1", runningState(metadata)));
    await emitPart(
      harness,
      taskToolPart(
        ROOT_SESSION,
        "call-ev-1",
        errorState(
          `Subagent failed (task_id: ${CHILD}): unknown provider for model deepseek-flash`,
          metadata,
        ),
      ),
    );

    const afterFailure = await listItems(harness);
    const failedItem = afterFailure.items.find((item) => item.workItemId === workItemId);
    expect(failedItem?.state).toBe("awaiting_implementer");
    expect(failedItem?.delegated?.inFlightAttempt).toBe(false);
    expect(failedItem?.delegated?.attempts).toBe(1);

    // The item is retryable without a process restart and consumes the second
    // attempt rather than resetting the budget.
    await launchTask(harness, ROOT_SESSION, "call-ev-2", "vv-implementer", workItemId);
    const afterRetry = await listItems(harness);
    const retriedItem = afterRetry.items.find((item) => item.workItemId === workItemId);
    expect(retriedItem?.delegated?.attempts).toBe(2);
    expect(retriedItem?.delegated?.inFlightAttempt).toBe(true);
  });

  test("a direct terminal error event carrying metadata is consumed", async () => {
    const { harness, workItemId } = await harnessWithTask();
    await launchTask(harness, ROOT_SESSION, "call-direct", "vv-implementer", workItemId);
    await emitPart(
      harness,
      taskToolPart(
        ROOT_SESSION,
        "call-direct",
        errorState(`Subagent failed (task_id: ${CHILD}): transport failure`, foregroundMetadata()),
      ),
    );

    const listed = await listItems(harness);
    const item = listed.items.find((entry) => entry.workItemId === workItemId);
    expect(item?.delegated?.inFlightAttempt).toBe(false);
    expect(item?.delegated?.attempts).toBe(1);
  });

  test("two failures exhaust the budget and do not authorize acceptance", async () => {
    const { harness, workItemId } = await harnessWithTask();
    for (const [index, child] of [CHILD, "ses_delegated_child_2"].entries()) {
      const callId = `call-budget-${index + 1}`;
      await launchTask(harness, ROOT_SESSION, callId, "vv-implementer", workItemId);
      await emitPart(
        harness,
        taskToolPart(
          ROOT_SESSION,
          callId,
          errorState(
            `Subagent failed (task_id: ${child}): provider error`,
            foregroundMetadata(child),
          ),
        ),
      );
    }

    const exhausted = await launchTask(
      harness,
      ROOT_SESSION,
      "call-budget-3",
      "vv-implementer",
      workItemId,
    ).catch((error: Error) => error.message);
    expect(String(exhausted)).toContain("ATTEMPTS_EXHAUSTED");

    const decision = await decide(harness, {
      workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "Cannot accept a failed attempt.",
      evidence: ["diff"],
    });
    expect(decision.ok).toBe(false);
  });

  test("mismatched parent, replaced child, and unknown callIDs never mutate", async () => {
    const { harness, workItemId } = await harnessWithTask();
    await launchTask(harness, ROOT_SESSION, "call-mismatch", "vv-implementer", workItemId);

    await emitPart(
      harness,
      taskToolPart(
        ROOT_SESSION,
        "call-mismatch",
        errorState(`Subagent failed (task_id: ${CHILD}): provider error`, {
          parentSessionId: "ses_other_parent",
          sessionId: CHILD,
        }),
      ),
    );
    let listed = await listItems(harness);
    expect(listed.items.find((i) => i.workItemId === workItemId)?.delegated?.inFlightAttempt).toBe(
      true,
    );

    // Bind one child, then a replacement child identity taints the binding.
    await emitPart(
      harness,
      taskToolPart(ROOT_SESSION, "call-mismatch", runningState(foregroundMetadata())),
    );
    await emitPart(
      harness,
      taskToolPart(
        ROOT_SESSION,
        "call-mismatch",
        errorState(
          "Subagent failed (task_id: ses_delegated_child_other): provider error",
          foregroundMetadata("ses_delegated_child_other"),
        ),
      ),
    );
    listed = await listItems(harness);
    expect(listed.items.find((i) => i.workItemId === workItemId)?.delegated?.inFlightAttempt).toBe(
      true,
    );

    // An unknown callID has no live binding and cannot affect the item.
    await emitPart(
      harness,
      taskToolPart(
        ROOT_SESSION,
        "call-unknown",
        errorState(`Subagent failed (task_id: ${CHILD}): provider error`, foregroundMetadata()),
      ),
    );
    listed = await listItems(harness);
    expect(listed.items.find((i) => i.workItemId === workItemId)?.delegated?.inFlightAttempt).toBe(
      true,
    );
  });

  test("after-hook entry, background, promotion, interruption, and resume all stay blocked", async () => {
    // After-hook entry before a protocol failure latches the ambiguous path.
    const afterHook = await harnessWithTask();
    await launchTask(
      afterHook.harness,
      ROOT_SESSION,
      "call-after",
      "vv-implementer",
      afterHook.workItemId,
    );
    await afterHook.harness.plugin["tool.execute.after"]?.(
      {
        tool: "task",
        sessionID: ROOT_SESSION,
        callID: "call-after",
        args: {
          subagent_type: "vv-implementer",
          prompt: `VVOC_WORK_ITEM_ID: ${afterHook.workItemId}`,
        },
      } as never,
      { title: "task", output: 42, metadata: {} } as never,
    ).catch(() => undefined);
    await emitPart(
      afterHook.harness,
      taskToolPart(
        ROOT_SESSION,
        "call-after",
        errorState(`Subagent failed (task_id: ${CHILD}): provider error`, foregroundMetadata()),
      ),
    );
    expect(
      (await listItems(afterHook.harness)).items.find((i) => i.workItemId === afterHook.workItemId)
        ?.delegated?.inFlightAttempt,
    ).toBe(true);

    // Requested background launch is ineligible from the start.
    const background = await harnessWithTask();
    await launchTaskWithArgs(
      background.harness,
      ROOT_SESSION,
      "call-bg",
      "vv-implementer",
      `VVOC_WORK_ITEM_ID: ${background.workItemId}`,
      { background: true },
    );
    await emitPart(
      background.harness,
      taskToolPart(
        ROOT_SESSION,
        "call-bg",
        errorState(`Subagent failed (task_id: ${CHILD}): provider error`, foregroundMetadata()),
      ),
    );
    expect(
      (await listItems(background.harness)).items.find(
        (i) => i.workItemId === background.workItemId,
      )?.delegated?.inFlightAttempt,
    ).toBe(true);

    // A host subtask launch always carries a command key (undefined here).
    const subtask = await harnessWithTask();
    await launchTaskWithArgs(
      subtask.harness,
      ROOT_SESSION,
      "call-subtask",
      "vv-implementer",
      `VVOC_WORK_ITEM_ID: ${subtask.workItemId}`,
      { command: undefined },
    );
    await emitPart(
      subtask.harness,
      taskToolPart(
        ROOT_SESSION,
        "call-subtask",
        errorState(`Subagent failed (task_id: ${CHILD}): provider error`, foregroundMetadata()),
      ),
    );
    expect(
      (await listItems(subtask.harness)).items.find((i) => i.workItemId === subtask.workItemId)
        ?.delegated?.inFlightAttempt,
    ).toBe(true);

    // Promotion metadata replacement taints a foreground launch.
    const promotion = await harnessWithTask();
    await launchTask(
      promotion.harness,
      ROOT_SESSION,
      "call-promote",
      "vv-implementer",
      promotion.workItemId,
    );
    await emitPart(
      promotion.harness,
      taskToolPart(
        ROOT_SESSION,
        "call-promote",
        runningState({
          parentSessionId: ROOT_SESSION,
          sessionId: CHILD,
          background: true,
          jobId: CHILD,
        }),
      ),
    );
    await emitPart(
      promotion.harness,
      taskToolPart(
        ROOT_SESSION,
        "call-promote",
        errorState(`Subagent failed (task_id: ${CHILD}): provider error`, foregroundMetadata()),
      ),
    );
    expect(
      (await listItems(promotion.harness)).items.find((i) => i.workItemId === promotion.workItemId)
        ?.delegated?.inFlightAttempt,
    ).toBe(true);

    // Interruption metadata taints a foreground launch.
    const interrupted = await harnessWithTask();
    await launchTask(
      interrupted.harness,
      ROOT_SESSION,
      "call-int",
      "vv-implementer",
      interrupted.workItemId,
    );
    await emitPart(
      interrupted.harness,
      taskToolPart(
        ROOT_SESSION,
        "call-int",
        runningState({
          parentSessionId: ROOT_SESSION,
          sessionId: CHILD,
          interrupted: true,
        }),
      ),
    );
    await emitPart(
      interrupted.harness,
      taskToolPart(
        ROOT_SESSION,
        "call-int",
        errorState(`Subagent failed (task_id: ${CHILD}): provider error`, foregroundMetadata()),
      ),
    );
    expect(
      (await listItems(interrupted.harness)).items.find(
        (i) => i.workItemId === interrupted.workItemId,
      )?.delegated?.inFlightAttempt,
    ).toBe(true);

    // A later task launch that resumes the same child invalidates exclusivity,
    // even when the resuming launch itself is untracked.
    const resumed = await harnessWithTask();
    await launchTask(
      resumed.harness,
      ROOT_SESSION,
      "call-resume",
      "vv-implementer",
      resumed.workItemId,
    );
    await emitPart(
      resumed.harness,
      taskToolPart(ROOT_SESSION, "call-resume", runningState(foregroundMetadata())),
    );
    await launchTaskWithArgs(
      resumed.harness,
      ROOT_SESSION,
      "call-resume-job",
      "explore",
      "resume child",
      { task_id: CHILD },
    );
    await emitPart(
      resumed.harness,
      taskToolPart(
        ROOT_SESSION,
        "call-resume",
        errorState(`Subagent failed (task_id: ${CHILD}): provider error`, foregroundMetadata()),
      ),
    );
    expect(
      (await listItems(resumed.harness)).items.find((i) => i.workItemId === resumed.workItemId)
        ?.delegated?.inFlightAttempt,
    ).toBe(true);
  });

  test("a second child prompt invalidates fresh-exclusive eligibility", async () => {
    const { harness, workItemId } = await harnessWithTask();
    await launchTask(harness, ROOT_SESSION, "call-reprompt", "vv-implementer", workItemId);
    await emitPart(
      harness,
      taskToolPart(ROOT_SESSION, "call-reprompt", runningState(foregroundMetadata())),
    );
    const userMessage = (id: string) => ({
      event: {
        type: "message.updated",
        properties: {
          info: { id, sessionID: CHILD, role: "user" },
        },
      },
    });
    await harness.plugin.event?.(userMessage("msg-child-1") as never);
    await harness.plugin.event?.(userMessage("msg-child-2") as never);
    await emitPart(
      harness,
      taskToolPart(
        ROOT_SESSION,
        "call-reprompt",
        errorState(`Subagent failed (task_id: ${CHILD}): provider error`, foregroundMetadata()),
      ),
    );
    expect(
      (await listItems(harness)).items.find((i) => i.workItemId === workItemId)?.delegated
        ?.inFlightAttempt,
    ).toBe(true);
  });

  test("a checked snapshot failure keeps the retry blocked until a later event succeeds", async () => {
    const { harness, workItemId } = await harnessWithTask();
    await launchTask(harness, ROOT_SESSION, "call-persist", "vv-implementer", workItemId);

    const statePath = join(getWorkflowSessionDir(ROOT_SESSION), "workflow-state.json");
    const metadata = foregroundMetadata();
    const errorEvent = taskToolPart(
      ROOT_SESSION,
      "call-persist",
      errorState(`Subagent failed (task_id: ${CHILD}): provider error`, metadata),
    );

    // Force the checked snapshot write to fail by occupying the state path.
    rmSync(statePath, { force: true });
    mkdirSync(statePath, { recursive: true });
    await emitPart(harness, errorEvent);
    let listed = await listItems(harness);
    expect(listed.items.find((i) => i.workItemId === workItemId)?.delegated?.inFlightAttempt).toBe(
      true,
    );

    // After I/O recovery the same authoritative event applies idempotently.
    rmSync(statePath, { recursive: true, force: true });
    await emitPart(harness, errorEvent);
    listed = await listItems(harness);
    const item = listed.items.find((i) => i.workItemId === workItemId);
    expect(item?.delegated?.inFlightAttempt).toBe(false);
    expect(item?.delegated?.attempts).toBe(1);
  });
});
// END_BLOCK_DELEGATED_FAILURE_EVENTS

// START_BLOCK_TWENTY_TASK_SCENARIO
describe("twenty tasks require four reviewer launches", () => {
  test("controller acceptance replaces per-task reviews and checkpoints use four reviewer dispatches", async () => {
    // Twenty tasks across four waves; milestones after waves 2 and 3 (code only),
    // and a final checkpoint after wave 4 (spec plus code).
    const taskCount = 20;
    const checkpointWaves = [2, 3, 4];
    const taskWave = (index: number): number => Math.min(4, Math.ceil(index / 5));
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(
      taskCount,
      checkpointWaves,
      taskWave,
    );
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(harness, planPath);

    let reviewerLaunches = 0;
    const originalBefore = harness.plugin["tool.execute.before"];
    expect(originalBefore).toBeDefined();
    if (!originalBefore) return;
    const countingBefore: typeof originalBefore = async (input, output) => {
      const args = output as { args?: { subagent_type?: string } };
      if (
        input.tool === "task" &&
        (args?.args?.subagent_type === "vv-spec-reviewer" ||
          args?.args?.subagent_type === "vv-code-reviewer")
      ) {
        reviewerLaunches += 1;
      }
      await originalBefore(input, output);
    };
    harness.plugin["tool.execute.before"] = countingBefore;

    // Ordinary tasks in waves 1 and 2: accept each without any reviewer dispatch.
    for (let index = 1; index <= 10; index++) {
      const taskId = `T-${String(index).padStart(3, "0")}`;
      await driveAcceptedTask(harness, runId, taskId);
    }
    expect(reviewerLaunches).toBe(0);

    // Milestone after wave 2: one code reviewer.
    const milestone2 = parseToolJson<{ ok: boolean; reviewWorkItemId?: string }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        { action: "start", runId, checkpointId: "CHECKPOINT-R-001" } as never,
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(milestone2.ok).toBe(true);
    if (!milestone2.ok || !milestone2.reviewWorkItemId) return;
    await launchTask(
      harness,
      ROOT_SESSION,
      "rv-m2-code",
      "vv-code-reviewer",
      milestone2.reviewWorkItemId,
    );
    await finishTask(
      harness,
      ROOT_SESSION,
      "rv-m2-code",
      "vv-code-reviewer",
      milestone2.reviewWorkItemId,
      "PASS",
    );
    const milestone2Verify = parseToolJson<{ ok: boolean; outcome?: string }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        { action: "verify", runId, checkpointId: "CHECKPOINT-R-001" } as never,
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(milestone2Verify.outcome).toBe("passed");

    // Wave 3 tasks become launchable only after the milestone barrier passed.
    for (let index = 11; index <= 15; index++) {
      const taskId = `T-${String(index).padStart(3, "0")}`;
      await driveAcceptedTask(harness, runId, taskId);
    }
    expect(reviewerLaunches).toBe(1);

    // Milestone after wave 3: one code reviewer.
    const milestone3 = parseToolJson<{ ok: boolean; reviewWorkItemId?: string }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        { action: "start", runId, checkpointId: "CHECKPOINT-R-002" } as never,
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(milestone3.ok).toBe(true);
    if (!milestone3.ok || !milestone3.reviewWorkItemId) return;
    await launchTask(
      harness,
      ROOT_SESSION,
      "rv-m3-code",
      "vv-code-reviewer",
      milestone3.reviewWorkItemId,
    );
    await finishTask(
      harness,
      ROOT_SESSION,
      "rv-m3-code",
      "vv-code-reviewer",
      milestone3.reviewWorkItemId,
      "PASS",
    );
    const milestone3Verify = parseToolJson<{ ok: boolean; outcome?: string }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        { action: "verify", runId, checkpointId: "CHECKPOINT-R-002" } as never,
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(milestone3Verify.outcome).toBe("passed");

    // Wave 4 tasks after the second milestone barrier.
    for (let index = 16; index <= 20; index++) {
      const taskId = `T-${String(index).padStart(3, "0")}`;
      await driveAcceptedTask(harness, runId, taskId);
    }
    expect(reviewerLaunches).toBe(2);

    // Final checkpoint: spec plus code reviewers, then complete.
    const finalStart = parseToolJson<{ ok: boolean; reviewWorkItemId?: string }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        { action: "start", runId, checkpointId: "CHECKPOINT-R-003" } as never,
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(finalStart.ok).toBe(true);
    if (!finalStart.ok || !finalStart.reviewWorkItemId) return;
    await launchTask(
      harness,
      ROOT_SESSION,
      "rv-final-spec",
      "vv-spec-reviewer",
      finalStart.reviewWorkItemId,
    );
    await launchTask(
      harness,
      ROOT_SESSION,
      "rv-final-code",
      "vv-code-reviewer",
      finalStart.reviewWorkItemId,
    );
    await finishTask(
      harness,
      ROOT_SESSION,
      "rv-final-spec",
      "vv-spec-reviewer",
      finalStart.reviewWorkItemId,
      "PASS",
    );
    await finishTask(
      harness,
      ROOT_SESSION,
      "rv-final-code",
      "vv-code-reviewer",
      finalStart.reviewWorkItemId,
      "PASS",
    );

    const sealed = parseToolJson<{ ok: boolean; outcome?: string; sealedRun?: boolean }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        { action: "verify", runId, checkpointId: "CHECKPOINT-R-003", complete: true } as never,
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(sealed.sealedRun).toBe(true);

    // Two milestones used one reviewer each; the final used two: exactly four.
    expect(reviewerLaunches).toBe(4);

    // A failed or stale checkpoint cannot be reported as passing after sealing.
    const reverify = parseToolJson<{ ok: boolean; outcome?: string }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        { action: "verify", runId, checkpointId: "CHECKPOINT-R-003" } as never,
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(reverify.outcome).toBe("already-passed");
  });
});
// END_BLOCK_TWENTY_TASK_SCENARIO

// START_BLOCK_RECOVERY_INTEGRATION_TESTS
describe("bounded recovery through the delegated control tools", () => {
  test("two rejected attempts block a third, autonomous recovery grants one, and a user message extends exactly once", async () => {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(1, [1], () => 1);
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(harness, planPath);
    const workItemId = await taskWorkItemId(harness, runId, "T-001");

    for (const callId of ["call-rc-1", "call-rc-2"]) {
      await launchTask(harness, ROOT_SESSION, callId, "vv-implementer", workItemId);
      await finishTask(harness, ROOT_SESSION, callId, "vv-implementer", workItemId, "DONE");
      const attempt = callId.endsWith("1") ? 1 : 2;
      const rejected = await decide(harness, {
        workItemId,
        attempt,
        decision: "request_changes",
        rationale: "Implementation misses the declared branch.",
        evidence: ["src/tasks/task-001.ts"],
      });
      expect(rejected.ok).toBe(true);
    }

    const blocked = await launchTask(
      harness,
      ROOT_SESSION,
      "call-rc-3",
      "vv-implementer",
      workItemId,
    ).catch((error: Error) => error.message);
    expect(String(blocked)).toContain("ATTEMPTS_EXHAUSTED");

    let listed = await listItems(harness);
    let item = listed.items.find((entry) => entry.workItemId === workItemId);
    expect(item?.delegated?.attemptBudget).toBe(2);
    expect(item?.delegated?.remainingAttempts).toBe(0);
    expect(item?.delegated?.nextAction).toBe("recover");

    const recovered = await decide(harness, {
      workItemId,
      attempt: 2,
      decision: "recover",
      diagnosis: "Both attempts missed the same untested branch.",
      changedCondition: "Branch inputs pinned in the task packet.",
      verification: ["src/tasks/task-001.test.ts"],
      recoveryId: "rec-tool-1",
    });
    expect(recovered.ok).toBe(true);
    if (recovered.ok !== true) return;
    expect(recovered.kind).toBe("autonomous_grant");
    expect(recovered.attemptBudget).toBe(3);

    await launchTask(harness, ROOT_SESSION, "call-rc-3", "vv-implementer", workItemId);
    await finishTask(
      harness,
      ROOT_SESSION,
      "call-rc-3",
      "vv-implementer",
      workItemId,
      "BLOCKED",
    ).catch(() => "expected hard stop");
    listed = await listItems(harness);
    item = listed.items.find((entry) => entry.workItemId === workItemId);
    expect(item?.state).toBe("blocked");
    expect(item?.delegated?.nextAction).toBe("recover_with_user_authorization");

    // A second autonomous grant is denied even under a new recoveryId.
    const denied = await decide(harness, {
      workItemId,
      attempt: 3,
      decision: "recover",
      diagnosis: "Third attempt also stopped.",
      changedCondition: "Another retry.",
      verification: ["src/tasks/task-001.test.ts"],
      recoveryId: "rec-tool-2",
    });
    expect(denied.ok).toBe(false);
    if (denied.ok !== true) {
      expect(denied.errorCode).toBe("AUTONOMOUS_GRANT_EXHAUSTED");
    }

    // A fresh root-user message authorizes exactly one further unit.
    const messageKey = `${ROOT_SESSION}::msg_user_ext_1`;
    harness.userMessages.set(messageKey, {
      role: "user",
      sessionID: ROOT_SESSION,
      id: "msg_user_ext_1",
      timeCreatedMs: Date.now(),
    });
    const authorized = await decide(harness, {
      workItemId,
      attempt: 3,
      decision: "recover",
      diagnosis: "Autonomous allowance consumed by a real stop.",
      changedCondition: "User authorized one final bounded attempt.",
      verification: ["src/tasks/task-001.test.ts"],
      recoveryId: "rec-tool-3",
      userMessageId: "msg_user_ext_1",
    });
    expect(authorized.ok).toBe(true);
    if (authorized.ok !== true) return;
    expect(authorized.kind).toBe("user_grant");
    expect(harness.messageLookups).toContain(messageKey);

    await launchTask(harness, ROOT_SESSION, "call-rc-4", "vv-implementer", workItemId);
    await finishTask(
      harness,
      ROOT_SESSION,
      "call-rc-4",
      "vv-implementer",
      workItemId,
      "BLOCKED",
    ).catch(() => "expected hard stop");
    const replayed = await decide(harness, {
      workItemId,
      attempt: 4,
      decision: "recover",
      diagnosis: "Another stop after the granted attempt.",
      changedCondition: "Nothing changed without a new authorization.",
      verification: ["src/tasks/task-001.test.ts"],
      recoveryId: "rec-tool-4",
      userMessageId: "msg_user_ext_1",
    });
    expect(replayed.ok).toBe(false);
    if (replayed.ok !== true) {
      expect(replayed.errorCode).toBe("AUTHORIZATION_REUSED");
    }

    // A distinct fresh message is required for any further unit.
    const secondMessage = await decide(harness, {
      workItemId,
      attempt: 4,
      decision: "recover",
      diagnosis: "Seeking one more unit.",
      changedCondition: "Second user decision.",
      verification: ["src/tasks/task-001.test.ts"],
      recoveryId: "rec-tool-5",
      userMessageId: "msg_user_ext_2",
    });
    expect(secondMessage.ok).toBe(false);
    if (secondMessage.ok !== true) {
      expect(secondMessage.errorCode).toBe("AUTHORIZATION_NOT_FOUND");
    }
  });

  test("recovery survives a fresh plugin instance through persistence", async () => {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(1, [1], () => 1);
    const firstHarness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(firstHarness, planPath);
    const workItemId = await taskWorkItemId(firstHarness, runId, "T-001");
    for (const callId of ["call-persist-rec-1", "call-persist-rec-2"]) {
      await launchTask(firstHarness, ROOT_SESSION, callId, "vv-implementer", workItemId);
      await finishTask(firstHarness, ROOT_SESSION, callId, "vv-implementer", workItemId, "DONE");
      await decide(firstHarness, {
        workItemId,
        attempt: callId.endsWith("1") ? 1 : 2,
        decision: "request_changes",
        rationale: "Still incomplete.",
        evidence: ["src/tasks/task-001.ts"],
      });
    }
    const recovered = await decide(firstHarness, {
      workItemId,
      attempt: 2,
      decision: "recover",
      diagnosis: "Exhausted after two corrections.",
      changedCondition: "Packet clarified.",
      verification: ["src/tasks/task-001.test.ts"],
      recoveryId: "rec-persist-1",
    });
    expect(recovered.ok).toBe(true);

    const secondHarness = await createDelegatedPluginHarness(workspaceRoot);
    await launchTask(
      secondHarness,
      ROOT_SESSION,
      "call-persist-rec-3",
      "vv-implementer",
      workItemId,
    );
    const listed = await listItems(secondHarness);
    const item = listed.items.find((entry) => entry.workItemId === workItemId);
    expect(item?.delegated?.attempts).toBe(3);
    expect(item?.delegated?.inFlightAttempt).toBe(true);
    expect(item?.delegated?.attemptBudget).toBe(3);
  });

  test("a failed recovery persistence write rolls back and keeps the exhausted state blocked", async () => {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(1, [1], () => 1);
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(harness, planPath);
    const workItemId = await taskWorkItemId(harness, runId, "T-001");
    for (const callId of ["call-staged-1", "call-staged-2"]) {
      await launchTask(harness, ROOT_SESSION, callId, "vv-implementer", workItemId);
      await finishTask(harness, ROOT_SESSION, callId, "vv-implementer", workItemId, "DONE");
      await decide(harness, {
        workItemId,
        attempt: callId.endsWith("1") ? 1 : 2,
        decision: "request_changes",
        rationale: "Incomplete.",
        evidence: ["src/tasks/task-001.ts"],
      });
    }
    // Force the staged snapshot write to fail by occupying the state path.
    const statePath = join(getWorkflowSessionDir(ROOT_SESSION), "workflow-state.json");
    rmSync(statePath, { recursive: true, force: true });
    mkdirSync(statePath, { recursive: true });
    const failed = await decide(harness, {
      workItemId,
      attempt: 2,
      decision: "recover",
      diagnosis: "Exhausted with a failing disk.",
      changedCondition: "Recovery must wait for durable persistence.",
      verification: ["src/tasks/task-001.test.ts"],
      recoveryId: "rec-staged-1",
    }).catch((error: Error) => error.message);
    expect(String(failed)).toContain("PERSISTENCE_FAILED");

    // The live item is still exhausted: no unpersisted launch permission.
    const stillBlocked = await launchTask(
      harness,
      ROOT_SESSION,
      "call-staged-3",
      "vv-implementer",
      workItemId,
    ).catch((error: Error) => error.message);
    expect(String(stillBlocked)).toContain("ATTEMPTS_EXHAUSTED");
    let listed = await listItems(harness);
    let item = listed.items.find((entry) => entry.workItemId === workItemId);
    expect(item?.delegated?.recoveryCount).toBe(0);

    // After I/O recovery the same recovery applies durably.
    rmSync(statePath, { recursive: true, force: true });
    const retried = await decide(harness, {
      workItemId,
      attempt: 2,
      decision: "recover",
      diagnosis: "Exhausted; storage recovered.",
      changedCondition: "Recovery can now persist.",
      verification: ["src/tasks/task-001.test.ts"],
      recoveryId: "rec-staged-1",
    });
    expect(retried.ok).toBe(true);
    listed = await listItems(harness);
    item = listed.items.find((entry) => entry.workItemId === workItemId);
    expect(item?.delegated?.recoveryCount).toBe(1);
    expect(item?.delegated?.remainingAttempts).toBe(1);
  });
});

describe("terminal report rejection and checkpoint recovery integration", () => {
  test("a malformed hard-stop report settles as rejected without continuation and recovers", async () => {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(1, [1], () => 1);
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(harness, planPath);
    const workItemId = await taskWorkItemId(harness, runId, "T-001");

    await launchTask(harness, ROOT_SESSION, "call-hardstop", "vv-implementer", workItemId);
    const malformed = [
      `task_id: ses_hardstop_child (for resuming to continue this task if needed)`,
      "",
      "<task_result>",
      `VVOC_WORK_ITEM_ID: ${workItemId}`,
      "VVOC_STATUS: BLOCKED",
      "Missing approval decision; no route line follows.",
      "</task_result>",
    ].join("\n");
    const failure = finishTaskWithRawOutput(
      harness,
      ROOT_SESSION,
      "call-hardstop",
      "vv-implementer",
      workItemId,
      malformed,
    ).catch((error: Error) => error.message);
    const failureText = await failure;
    expect(failureText).toContain("RESULT_PROTOCOL_ERROR");
    expect(failureText).toContain("report_rejected");
    // The explicit hard stop suppressed the bounded continuation.
    expect(harness.promptCalls).toHaveLength(0);

    const listed = await listItems(harness);
    const item = listed.items.find((entry) => entry.workItemId === workItemId);
    expect(item?.state).toBe("blocked");
    expect(item?.delegated?.reportRejectionCount).toBe(1);
    expect(item?.delegated?.inFlightAttempt).toBe(false);
    expect(item?.delegated?.nextAction).toBe("recover");

    const recovered = await decide(harness, {
      workItemId,
      attempt: 1,
      decision: "recover",
      diagnosis: "Terminal report was protocol-invalid with an explicit stop.",
      changedCondition: "Worker packet pins the exact result format.",
      verification: ["src/tasks/task-001.ts"],
      recoveryId: "rec-hardstop-1",
    });
    expect(recovered.ok).toBe(true);
    if (recovered.ok !== true) return;
    expect(recovered.kind).toBe("resume");
    expect(recovered.state).toBe("awaiting_implementer");

    await launchTask(harness, ROOT_SESSION, "call-hardstop-2", "vv-implementer", workItemId);
    await finishTask(
      harness,
      ROOT_SESSION,
      "call-hardstop-2",
      "vv-implementer",
      workItemId,
      "DONE",
    );
    const accepted = await decide(harness, {
      workItemId,
      attempt: 2,
      decision: "accept",
      rationale: "Recovered attempt satisfies the contract.",
      evidence: ["src/tasks/task-001.ts"],
    });
    expect(accepted.ok).toBe(true);
  });

  test("checkpoint recovery through the tools still refuses skipped reviewers before completion", async () => {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(1, [1], () => 1);
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(harness, planPath);
    const workItemId = await taskWorkItemId(harness, runId, "T-001");
    await launchTask(harness, ROOT_SESSION, "call-cpr-launch", "vv-implementer", workItemId);
    await finishTask(
      harness,
      ROOT_SESSION,
      "call-cpr-launch",
      "vv-implementer",
      workItemId,
      "DONE",
    );
    await decide(harness, {
      workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "Task accepted before review.",
      evidence: ["src/tasks/task-001.ts"],
    });

    // Two failing final generations exhaust the ordinary budget.
    for (const generation of [1, 2]) {
      const started = await checkpointCall(harness, {
        action: "start",
        runId,
        checkpointId: "CHECKPOINT-R-001",
      });
      expect(started.ok).toBe(true);
      if (started.ok !== true) return;
      const reviewWorkItemId = String(started.reviewWorkItemId);
      await launchTask(
        harness,
        ROOT_SESSION,
        `call-cpr-spec-${generation}`,
        "vv-spec-reviewer",
        reviewWorkItemId,
      );
      await finishTask(
        harness,
        ROOT_SESSION,
        `call-cpr-spec-${generation}`,
        "vv-spec-reviewer",
        reviewWorkItemId,
        "FAIL",
      );
      await launchTask(
        harness,
        ROOT_SESSION,
        `call-cpr-code-${generation}`,
        "vv-code-reviewer",
        reviewWorkItemId,
      );
      await finishTask(
        harness,
        ROOT_SESSION,
        `call-cpr-code-${generation}`,
        "vv-code-reviewer",
        reviewWorkItemId,
        "PASS",
      );
      const verified = await checkpointCall(harness, {
        action: "verify",
        runId,
        checkpointId: "CHECKPOINT-R-001",
      });
      expect(verified.ok).toBe(true);
      if (verified.ok !== true) return;
      expect(verified.outcome).toBe("failed");
    }

    const blocked = await checkpointCall(harness, {
      action: "start",
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok !== true) expect(blocked.errorCode).toBe("ATTEMPTS_EXHAUSTED");

    let listed = await listItems(harness);
    const runView = listed.planRuns?.find((entry) => entry.runId === runId);
    const checkpointView = runView?.checkpoints.find(
      (entry) => entry.checkpointId === "CHECKPOINT-R-001",
    );
    expect(checkpointView?.generationBudget).toBe(2);
    expect(checkpointView?.remainingGenerations).toBe(0);
    expect(checkpointView?.nextAction).toBe("recover");

    const recovered = await checkpointCall(harness, {
      action: "recover",
      runId,
      checkpointId: "CHECKPOINT-R-001",
      diagnosis: "Both final generations failed on the same defect.",
      changedCondition: "Defect fixed and covered by the fixture tests.",
      verification: ["src/tasks/task-001.test.ts"],
      recoveryId: "rec-cpr-1",
    });
    expect(recovered.ok).toBe(true);
    if (recovered.ok !== true) return;
    expect(recovered.kind).toBe("autonomous_grant");
    expect(recovered.generationBudget).toBe(3);

    // Completion still requires the full declared reviewer set: a generation
    // with only the spec reviewer recorded cannot pass or seal.
    const thirdStart = await checkpointCall(harness, {
      action: "start",
      runId,
      checkpointId: "CHECKPOINT-R-001",
    });
    expect(thirdStart.ok).toBe(true);
    if (thirdStart.ok !== true) return;
    const thirdReview = String(thirdStart.reviewWorkItemId);
    await launchTask(harness, ROOT_SESSION, "call-cpr-spec-3", "vv-spec-reviewer", thirdReview);
    await finishTask(
      harness,
      ROOT_SESSION,
      "call-cpr-spec-3",
      "vv-spec-reviewer",
      thirdReview,
      "PASS",
    );
    const skipped = await checkpointCall(harness, {
      action: "verify",
      runId,
      checkpointId: "CHECKPOINT-R-001",
      complete: true,
    });
    expect(skipped.ok).toBe(true);
    if (skipped.ok !== true) return;
    expect(skipped.outcome).toBe("incomplete");

    // The skipped reviewer's FAIL-less absence is not fabricated: completing
    // the full declared set seals the run through the recovered generation.
    await launchTask(harness, ROOT_SESSION, "call-cpr-code-3", "vv-code-reviewer", thirdReview);
    await finishTask(
      harness,
      ROOT_SESSION,
      "call-cpr-code-3",
      "vv-code-reviewer",
      thirdReview,
      "PASS",
    );
    const sealed = await checkpointCall(harness, {
      action: "verify",
      runId,
      checkpointId: "CHECKPOINT-R-001",
      complete: true,
    });
    expect(sealed.ok).toBe(true);
    if (sealed.ok !== true) return;
    expect(sealed.outcome).toBe("passed");
    expect(sealed.sealedRun).toBe(true);

    listed = await listItems(harness);
    const sealedRun = listed.planRuns?.find((entry) => entry.runId === runId);
    expect(sealedRun?.checkpoints[0]?.status).toBe("passed");
  });

  test("recover accepts the documented minimal shape and reports the settled attempt for repeated rejections", async () => {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(1, [1], () => 1);
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(harness, planPath);
    const workItemId = await taskWorkItemId(harness, runId, "T-001");

    // Exhaust the ordinary budget with two rejected completions.
    for (const callId of ["call-doc-1", "call-doc-2"]) {
      await launchTask(harness, ROOT_SESSION, callId, "vv-implementer", workItemId);
      await finishTask(harness, ROOT_SESSION, callId, "vv-implementer", workItemId, "DONE");
      await decide(harness, {
        workItemId,
        attempt: callId.endsWith("1") ? 1 : 2,
        decision: "request_changes",
        rationale: "Incomplete.",
        evidence: ["src/tasks/task-001.ts"],
      });
    }

    // The documented recover shape carries no rationale or evidence; the tool
    // layer must accept it exactly as instructed.
    const recovered = await decide(harness, {
      workItemId,
      attempt: 2,
      decision: "recover",
      diagnosis: "Both attempts missed the same untested branch.",
      changedCondition: "Branch inputs pinned in the task packet.",
      verification: ["src/tasks/task-001.test.ts"],
      recoveryId: "rec-doc-1",
    });
    expect(recovered.ok).toBe(true);
    if (recovered.ok !== true) return;
    expect(recovered.kind).toBe("autonomous_grant");

    // First malformed hard-stop report settles attempt 3 and names it.
    await launchTask(harness, ROOT_SESSION, "call-doc-3", "vv-implementer", workItemId);
    const firstRejection = finishTaskWithRawOutput(
      harness,
      ROOT_SESSION,
      "call-doc-3",
      "vv-implementer",
      workItemId,
      wrapTaskResult(
        "ses_doc_child",
        `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: BLOCKED\nMissing approval decision with no route line.`,
      ),
    ).catch((error: Error) => error.message);
    const firstText = await firstRejection;
    expect(firstText).toContain("attempt 3 of");
    let listed = await listItems(harness);
    let item = listed.items.find((entry) => entry.workItemId === workItemId);
    expect(item?.state).toBe("blocked");
    expect(item?.delegated?.reportRejectionCount).toBe(1);
    expect(item?.delegated?.nextAction).toBe("recover_with_user_authorization");

    // A second rejection after recovery names the newly settled attempt, not
    // the first report_rejected attempt in the ledger.
    const messageKey = `${ROOT_SESSION}::msg_user_doc_1`;
    harness.userMessages.set(messageKey, {
      role: "user",
      sessionID: ROOT_SESSION,
      id: "msg_user_doc_1",
      timeCreatedMs: Date.now(),
    });
    await decide(harness, {
      workItemId,
      attempt: 3,
      decision: "recover",
      diagnosis: "Terminal rejection after the granted attempt.",
      changedCondition: "Result format pinned in the worker packet.",
      verification: ["src/tasks/task-001.test.ts"],
      recoveryId: "rec-doc-2",
      userMessageId: "msg_user_doc_1",
    });
    await launchTask(harness, ROOT_SESSION, "call-doc-4", "vv-implementer", workItemId);
    const secondRejection = finishTaskWithRawOutput(
      harness,
      ROOT_SESSION,
      "call-doc-4",
      "vv-implementer",
      workItemId,
      wrapTaskResult(
        "ses_doc_child",
        `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: NEEDS_CONTEXT\nMissing input with no route line.`,
      ),
    ).catch((error: Error) => error.message);
    const secondText = await secondRejection;
    expect(secondText).toContain("attempt 4 of");
    listed = await listItems(harness);
    item = listed.items.find((entry) => entry.workItemId === workItemId);
    expect(item?.state).toBe("needs_context");
    expect(item?.delegated?.reportRejectionCount).toBe(2);
    expect(item?.delegated?.nextAction).toBe("recover_with_user_authorization");
  });

  test("a stopping authorization lookup reports a lookup failure, not a missing message", async () => {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(1, [1], () => 1);
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(harness, planPath);
    const workItemId = await taskWorkItemId(harness, runId, "T-001");
    for (const callId of ["call-lkf-1", "call-lkf-2"]) {
      await launchTask(harness, ROOT_SESSION, callId, "vv-implementer", workItemId);
      await finishTask(harness, ROOT_SESSION, callId, "vv-implementer", workItemId, "DONE");
      await decide(harness, {
        workItemId,
        attempt: callId.endsWith("1") ? 1 : 2,
        decision: "request_changes",
        rationale: "Incomplete.",
        evidence: ["src/tasks/task-001.ts"],
      });
    }

    const messageKey = `${ROOT_SESSION}::msg_user_lkf_1`;
    harness.userMessages.set(messageKey, {
      role: "user",
      sessionID: ROOT_SESSION,
      id: "msg_user_lkf_1",
      timeCreatedMs: Date.now(),
      transportError: true,
    });
    const failed = await decide(harness, {
      workItemId,
      attempt: 2,
      decision: "recover",
      diagnosis: "Exhausted while the session service is unreachable.",
      changedCondition: "Retry after the lookup transport recovers.",
      verification: ["src/tasks/task-001.test.ts"],
      recoveryId: "rec-lkf-1",
      userMessageId: "msg_user_lkf_1",
    });
    expect(failed.ok).toBe(false);
    if (failed.ok !== true) {
      expect(failed.errorCode).toBe("AUTHORIZATION_LOOKUP_FAILED");
    }
    const listed = await listItems(harness);
    const item = listed.items.find((entry) => entry.workItemId === workItemId);
    expect(item?.delegated?.recoveryCount).toBe(0);
  });
});
// END_BLOCK_RECOVERY_INTEGRATION_TESTS
