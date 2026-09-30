// FILE: src/plugins/workflow.delegated.integration.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify WorkflowPlugin delegated integration: control-tool registration and authorization, callID-bound attempts, checkpoint linkage through real hooks, bounded recovery, terminal report-rejection settlement, and legacy-profile isolation.
//   SCOPE: Native Plugin.setup fixtures over a fake native context: delegated-only tool registration, root/fork/workspace authorization denial, unauthorized self-acceptance, unknown root-session data, stale call callbacks, premature close bypass, checkpoint register/start/verify/recover through the tool wrapper with hook-driven reviewer results, barrier-blocked launches, invalid persisted state denial, native event-delivered host-terminal launch failures with sticky exclusions and persistence recovery, same-child malformed-result continuation through native session.prompt/wait/context, pre-checkpoint bounded recovery after exhaustion with autonomous denial and root-user message extension plus replay rejection, terminal malformed hard-stop settlement as a rejected report with a reachable recovery path, staged recovery persistence failure that keeps launches blocked, native background synthetic settlement, evidence-gated explicit cancellation recovery with historical timestamps, final completion refusing skipped reviewers after checkpoint recovery, and old-profile regressions.
//   DEPENDS: [bun:test, node:fs, node:fs/promises, node:os, node:path, src/lib/config-layers.ts, src/lib/vvoc-config.ts, src/plugins/workflow/index.ts, src/plugins/workflow/persistence.ts, src/plugins/workflow/protocol.ts]
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
//   taskToolPart - Builds a native-shaped parent task tool part for one parent task call.
//   taskPartUpdated - Wraps a task tool part in a message.part.updated event.
//   runningState - Builds a native-shaped running tool state with host metadata.
//   errorState - Builds a native-shaped error tool state with a host error.
//   emitPart - Delivers one message.part.updated event through the plugin event hook.
//   listItems - Reads the current work-item list through the real tool.
//   decide - Calls work_item_decide with a stub controller context.
//   driveAcceptedTask - Runs one delegated task from launch to controller acceptance through hooks and tools.
//   DelegatedUserMessageStub - Minimal SDK-shaped message snapshot served for authorization lookups.
//   checkpointCall - Calls the work_checkpoint tool with a stub controller context.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE wi-20 - Added cancellation-recovery regressions for the LIVE native root-interrupt parent shape: explicit recover settles the in-flight attempt with completedAt = max(parent tool-part end, child terminal completion), and a bare `Tool execution interrupted` without a subagent child session id still refuses with CANCELLATION_EVIDENCE_REQUIRED. seedCancellationEvidence now takes an optional pinned parent failure. Prior wi-7 attempt 2: staged-launch persistence coverage, a lazy-client-acquisition retry regression, and a foreground malformed-report regression (a client-acquisition failure during bounded continuation still settles report_rejected with the original excerpt, never in_flight/DONE).]
// END_CHANGE_SUMMARY

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
/** Native parent task part projection used by the delegated event fixtures. */
interface TaskToolPartState {
  readonly status: "running" | "error";
  readonly error?: string;
  readonly metadata?: Record<string, unknown>;
}
/** Native parent task tool part projection (id/session/state) used before the event is emitted. */
interface TaskToolPart {
  readonly id: string;
  readonly sessionID: string;
  readonly messageID: string;
  readonly type: "tool";
  readonly callID: string;
  readonly tool: string;
  readonly state: TaskToolPartState;
}
import { loadVvocConfig, resetVvocConfigForTests } from "../lib/config-layers.js";
import type { OrchestrationProfile } from "../lib/orchestration.js";
import { createDefaultVvocConfig, renderVvocConfig } from "../lib/vvoc-config.js";
import { createWorkflowPlugin } from "./workflow/index.js";
import {
  deleteWorkflowSessionDir,
  getWorkflowSessionDir,
  hydrateWorkflowStateChecked,
} from "./workflow/persistence.js";
import { validateWorkflowToolResult } from "./workflow/results.js";
import type { ParsedResultBlock } from "./workflow/protocol.js";

const ROOT_SESSION = "ses_delegated_root";
const previousConfigHome = process.env.XDG_CONFIG_HOME;
let previousDataHome: string | undefined;
let dataHome: string;

const cleanupPaths: string[] = [];

type StubSession = {
  parentID?: string;
  forkSessionID?: string;
  locationDirectory?: string;
  idle?: number;
  outcome?: string;
};

type DelegatedPromptCall = { sessionID: string; text: string };

// START_BLOCK_NATIVE_DELEGATED_FIXTURE
/** Native tool/hook handles captured from a real WorkflowPlugin.setup. */
type DelegatedHarnessPlugin = {
  tool: Record<
    string,
    { name: string; execute: (input: unknown, context: unknown) => Promise<unknown> } | undefined
  >;
  "tool.execute.before": (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: unknown },
  ) => Promise<void>;
  "tool.execute.after": (
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title?: string; output: unknown; metadata?: unknown },
  ) => Promise<void>;
  /** Deliver a native backgrounded subagent result (status running). */
  afterRunning: (input: {
    sessionID: string;
    callID: string;
    subagentType: string;
    workItemId: string;
    childSessionId: string;
  }) => Promise<void>;
};

class DelegatedEventQueue {
  private readonly events: unknown[] = [];
  private waiter: (() => void) | undefined;

  push(event: unknown): void {
    this.events.push(event);
    this.waiter?.();
    this.waiter = undefined;
  }

  drain(): AsyncIterable<unknown> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<unknown> => ({
        next: () => {
          const next = this.events.shift();
          if (next !== undefined) return Promise.resolve({ done: false as const, value: next });
          return new Promise((resolve) => {
            this.waiter = () => {
              const value = this.events.shift();
              resolve(
                value === undefined
                  ? { done: true as const, value: undefined }
                  : { done: false as const, value },
              );
            };
          });
        },
        return: () => Promise.resolve({ done: true as const, value: undefined }),
      }),
    };
  }
}
// END_BLOCK_NATIVE_DELEGATED_FIXTURE

interface DelegatedPluginHarness {
  plugin: DelegatedHarnessPlugin;
  logs: string[];
  workspaceRoot: string;
  planPath: string;
  sessions: Map<string, StubSession>;
  sessionGetFails: boolean;
  /** Simulates a transient failure acquiring the lazy authenticated full client. */
  clientAcquireFails: boolean;
  promptCalls: DelegatedPromptCall[];
  promptResponses: string[];
  /** Identity/timing snapshots served by the native session.context lookup. */
  userMessages: Map<string, DelegatedUserMessageStub>;
  messageLookups: string[];
  emit: (event: unknown) => void;
  /** Native session message lists, seedable by native cancellation/continuation tests. */
  sessionMessages: Map<string, unknown[]>;
  /** Sessions the fake full client reports as active (running). */
  activeSessions: Set<string>;
  /** Pending inbox items per session for quiescence checks. */
  inboxItems: Map<string, unknown[]>;
}

/** Minimal SDK-shaped message snapshot served for authorization lookups. */
interface DelegatedUserMessageStub {
  role?: string;
  sessionID?: string;
  id?: string;
  timeCreatedMs?: number;
  ignored?: boolean;
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

type DelegatedNativeTool = {
  name: string;
  execute: (input: unknown, context: unknown) => Promise<unknown>;
};

type DelegatedFakeToolEditor = {
  list: () => DelegatedNativeTool[];
  get: (id: string) => DelegatedNativeTool | undefined;
  namespace: () => void;
  add: (tool: DelegatedNativeTool) => void;
  update: () => void;
  remove: (id: string) => void;
};

async function createDelegatedPluginHarness(
  workspaceRoot: string,
  profile: OrchestrationProfile = "delegated",
  options?: { promptResponses?: string[] },
): Promise<DelegatedPluginHarness> {
  resetVvocConfigForTests();
  writeProfile(profile);
  const logs: string[] = [];
  const sessions = new Map<string, StubSession>();
  const promptCalls: DelegatedPromptCall[] = [];
  const promptResponses = [...(options?.promptResponses ?? [])];
  let messageCounter = 0;
  const userMessages = new Map<string, DelegatedUserMessageStub>();
  const messageLookups: string[] = [];
  const sessionMessages = new Map<string, unknown[]>();
  const activeSessions = new Set<string>();
  const inboxItems = new Map<string, unknown[]>();
  const queue = new DelegatedEventQueue();
  const tools = new Map<
    string,
    { name: string; execute: (input: unknown, context: unknown) => Promise<unknown> }
  >();
  const beforeHooks: Array<(event: Record<string, unknown>) => unknown> = [];
  const afterHooks: Array<(event: Record<string, unknown>) => unknown> = [];
  const contextHooks: Array<(event: Record<string, unknown>) => unknown> = [];

  const harness: DelegatedPluginHarness = {
    logs,
    workspaceRoot,
    planPath: "",
    sessions,
    sessionGetFails: false,
    clientAcquireFails: false,
    promptCalls,
    promptResponses,
    userMessages,
    messageLookups,
    plugin: undefined as never,
    emit: (event) => queue.push(event),
    sessionMessages,
    activeSessions,
    inboxItems,
  };

  const editor = {
    list: () => [...tools.values()],
    get: (id: string) => tools.get(id),
    namespace: () => undefined,
    add: (tool: {
      name: string;
      execute: (input: unknown, context: unknown) => Promise<unknown>;
    }) => {
      tools.set(tool.name, tool);
    },
    update: () => undefined,
    remove: (id: string) => {
      tools.delete(id);
    },
  };

  const sessionInfo = (sessionID: string): Record<string, unknown> => {
    if (harness.sessionGetFails) {
      throw new Error("session service unavailable");
    }
    const stub = sessions.get(sessionID) ?? {};
    return {
      id: sessionID,
      parentID: stub.parentID,
      ...(stub.forkSessionID === undefined ? {} : { fork: { sessionID: stub.forkSessionID } }),
      location: { directory: stub.locationDirectory ?? workspaceRoot },
      time: { created: 1, ...(stub.idle === undefined ? {} : { idle: stub.idle }) },
      ...(stub.outcome === undefined ? {} : { outcome: stub.outcome }),
    };
  };

  const collectMessages = (sessionID: string): unknown[] => {
    const collected: unknown[] = [...(sessionMessages.get(sessionID) ?? [])];
    for (const [key, stub] of userMessages) {
      const [stubSession, messageId] = key.split("::");
      if (stubSession !== sessionID) continue;
      collected.push({
        id: stub.id ?? messageId,
        type: stub.role === "user" ? "user" : "assistant",
        text: "",
        ignored: stub.ignored === true,
        time: { created: stub.timeCreatedMs ?? 0 },
      });
    }
    return collected;
  };
  const messageTime = (message: unknown): number => {
    if (typeof message !== "object" || message === null) return 0;
    const time = (message as { time?: { created?: unknown } }).time;
    return typeof time?.created === "number" ? time.created : 0;
  };

  const fakeClient = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => sessionInfo(sessionID),
      context: async ({ sessionID }: { sessionID: string }) => collectMessages(sessionID),
      message: {
        get: async ({ sessionID, messageID }: { sessionID: string; messageID: string }) => {
          const key = `${sessionID}::${messageID}`;
          messageLookups.push(key);
          const stub = userMessages.get(key);
          if (stub) {
            if (stub.transportError) throw new Error("session service unavailable");
            return {
              id: stub.id ?? messageID,
              type: stub.role === "user" ? "user" : "assistant",
              text: "",
              ignored: stub.ignored === true,
              time: { created: stub.timeCreatedMs ?? 0 },
            };
          }
          return (sessionMessages.get(sessionID) ?? []).find(
            (message) =>
              typeof message === "object" &&
              message !== null &&
              (message as { id?: unknown }).id === messageID,
          );
        },
      },
      active: async () =>
        Object.fromEntries([...activeSessions].map((id) => [id, { type: "running" }])),
      inbox: {
        list: async ({ sessionID }: { sessionID: string }) => inboxItems.get(sessionID) ?? [],
      },
      prompt: async (input: { sessionID: string; text: string }) => {
        promptCalls.push({ sessionID: input.sessionID, text: input.text });
        const text = promptResponses.shift();
        if (text === undefined) {
          return { error: { name: "BadRequest", message: "prompt unavailable" } };
        }
        const created = Date.now();
        messageCounter += 1;
        sessionMessages.set(input.sessionID, [
          ...(sessionMessages.get(input.sessionID) ?? []),
          {
            id: `msg_cont_${messageCounter}`,
            type: "assistant",
            content: [{ type: "text", text }],
            time: { created: created + 1, completed: created + 2 },
          },
        ]);
        return {
          id: `msg_prompt_${input.sessionID}`,
          sessionID: input.sessionID,
          time: { created },
        };
      },
      wait: async () => undefined,
      interrupt: async () => undefined,
    },
    message: {
      list: async (input: {
        sessionID: string;
        order?: "asc" | "desc";
        limit?: number;
        type?: string;
      }) => {
        let data = collectMessages(input.sessionID);
        if (input.type !== undefined) {
          data = data.filter((message) => (message as { type?: unknown }).type === input.type);
        }
        data.sort((left, right) =>
          input.order === "desc"
            ? messageTime(right) - messageTime(left)
            : messageTime(left) - messageTime(right),
        );
        if (input.limit !== undefined) data = data.slice(0, input.limit);
        return { data, cursor: {} };
      },
    },
  };

  const loaded = await loadVvocConfig({ cwd: workspaceRoot });
  const defaultCapture = { vvoc: loaded.config };
  const fakeRuntime = {
    snapshots: {
      configFor: async () => defaultCapture,
      accept: async () => ({ status: "unbound" }),
    },
    client: async () => {
      if (harness.clientAcquireFails) {
        throw new Error("transient client acquisition failure");
      }
      return fakeClient;
    },
    effectiveConfig: () => ({ vvoc: loaded.config }),
    release: async () => undefined,
  };

  const ctx = {
    location: {
      directory: workspaceRoot,
      project: { id: "proj", directory: workspaceRoot, canonical: workspaceRoot },
    },
    tool: {
      transform: async (callback: (editor: DelegatedFakeToolEditor) => void) => {
        callback(editor);
        return { dispose: async () => undefined };
      },
      hook: async (name: string, callback: (event: Record<string, unknown>) => unknown) => {
        if (name === "execute.before") beforeHooks.push(callback);
        else if (name === "execute.after") afterHooks.push(callback);
        return { dispose: async () => undefined };
      },
      list: async () => [],
      reload: async () => undefined,
    },
    session: {
      hook: async (_name: string, callback: (event: Record<string, unknown>) => unknown) => {
        contextHooks.push(callback);
        return { dispose: async () => undefined };
      },
    },
    event: { subscribe: () => queue.drain() },
    rpc: { register: async () => ({ dispose: async () => undefined }) },
  };

  await createWorkflowPlugin({ acquireRuntime: async () => fakeRuntime as never }).setup(
    ctx as never,
  );

  const plugin: DelegatedHarnessPlugin = {
    tool: new Proxy(
      {},
      { get: (_target, property: string) => tools.get(property) },
    ) as DelegatedHarnessPlugin["tool"],
    "tool.execute.before": async (input, output) => {
      const args = (output.args ?? {}) as Record<string, unknown>;
      const event: Record<string, unknown> = {
        tool: "subagent",
        sessionID: input.sessionID,
        agent: "vv-controller",
        messageID: "message-1",
        id: input.callID,
        input: {
          agent: args.subagent_type,
          description: args.description,
          prompt: args.prompt,
          ...(args.task_id === undefined ? {} : { sessionID: args.task_id }),
          ...(args.sessionID === undefined ? {} : { sessionID: args.sessionID }),
          ...(args.background === undefined ? {} : { background: args.background }),
          ...(args.model === undefined ? {} : { model: args.model }),
        },
      };
      for (const hook of beforeHooks) await hook(event);
      output.args = event.input;
    },
    "tool.execute.after": async (input, output) => {
      const rawArgs = (input.args ?? {}) as Record<string, unknown>;
      const outputText = typeof output.output === "string" ? output.output : "";
      const childSessionId = deriveDelegatedChildId(outputText) ?? `ses_${input.callID}_child`;
      const event: Record<string, unknown> = {
        tool: "subagent",
        sessionID: input.sessionID,
        agent: "vv-controller",
        messageID: "message-1",
        id: input.callID,
        input: {
          agent: rawArgs.subagent_type,
          description: rawArgs.description,
          prompt: rawArgs.prompt,
          ...(rawArgs.task_id === undefined ? {} : { sessionID: rawArgs.task_id }),
        },
        status: "completed",
        result: {
          output: { sessionID: childSessionId, status: "completed", output: outputText },
          content: `<subagent sessionID="${childSessionId}" state="completed">\n${outputText}\n</subagent>`,
          metadata: output.metadata ?? {},
        },
      };
      for (const hook of afterHooks) await hook(event);
      const result = event.result as { output?: unknown; metadata?: unknown };
      // Native execute.after cannot fail; diagnostics rewrite the result.
      output.output = result.output;
      output.metadata = result.metadata;
    },
    afterRunning: async (input) => {
      const event: Record<string, unknown> = {
        tool: "subagent",
        sessionID: input.sessionID,
        agent: "vv-controller",
        messageID: "message-1",
        id: input.callID,
        input: {
          agent: input.subagentType,
          prompt: `VVOC_WORK_ITEM_ID: ${input.workItemId}\n<assignment>Run tracked task</assignment>`,
        },
        status: "completed",
        result: {
          output: {
            sessionID: input.childSessionId,
            status: "running",
            output: "running in background",
          },
          content: "running in background",
          metadata: { sessionID: input.childSessionId, status: "running" },
        },
      };
      for (const hook of afterHooks) await hook(event);
    },
  };

  harness.plugin = plugin;
  return harness;
}

function deriveDelegatedChildId(output: string): string | undefined {
  const element = /^<task\s+id="([^"]+)"/m.exec(output);
  if (element) return element[1];
  const header = /^task_id:\s+(\S+)/m.exec(output);
  if (header) return header[1];
  return undefined;
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
  expect(validateWorkflowToolResult("work_checkpoint", registered).ok).toBe(true);
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
  expect(validateWorkflowToolResult("work_item_list", listed).ok).toBe(true);
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

function runningState(metadata: Record<string, unknown>): TaskToolPartState {
  return { status: "running", metadata };
}

function errorState(error: string, metadata: Record<string, unknown>): TaskToolPartState {
  return { status: "error", error, metadata };
}

function taskToolPart(
  parentSessionId: string,
  callId: string,
  state: TaskToolPartState,
): TaskToolPart {
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

async function emitPart(harness: DelegatedPluginHarness, part: TaskToolPart): Promise<void> {
  if (part.tool !== "task") return;
  const state = part.state as { status?: string; error?: string; metadata?: unknown };
  if (state.status === "error") {
    harness.emit({
      type: "session.tool.failed",
      data: {
        sessionID: part.sessionID,
        id: part.callID,
        error: { type: "tool.execution", message: state.error },
        metadata: state.metadata,
      },
    });
  } else if (state.status === "running") {
    harness.emit({
      type: "session.tool.progress",
      data: { sessionID: part.sessionID, id: part.callID, metadata: state.metadata },
    });
  }
  // Let the native event pump process the queued event before assertions run.
  await new Promise((resolve) => setTimeout(resolve, 0));
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
  const parsed = parseToolJson<Record<string, unknown>>(raw ?? "{}");
  expect(validateWorkflowToolResult("work_checkpoint", parsed).ok).toBe(true);
  return parsed;
}

async function finishTask(
  harness: DelegatedPluginHarness,
  sessionID: string,
  callId: string,
  subagentType: "vv-implementer" | "vv-spec-reviewer" | "vv-code-reviewer",
  workItemId: string,
  status: ParsedResultBlock["status"],
  body = "Done.",
): Promise<string> {
  const route = subagentType === "vv-implementer" ? "\nVVOC_ROUTE: change_with_review" : "";
  return finishTaskWithRawOutput(
    harness,
    sessionID,
    callId,
    subagentType,
    workItemId,
    `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: ${status}${route}\n\n${body}`,
  );
}

async function finishTaskWithRawOutput(
  harness: DelegatedPluginHarness,
  sessionID: string,
  callId: string,
  subagentType: "vv-implementer" | "vv-spec-reviewer" | "vv-code-reviewer",
  workItemId: string,
  output: string,
): Promise<string> {
  const sink = { title: "task", output: output as unknown, metadata: {} as unknown };
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
    sink as never,
  );
  const final = sink.output;
  if (typeof final === "string") return final;
  if (final && typeof final === "object" && "output" in final) {
    const inner = (final as { output?: unknown }).output;
    if (typeof inner === "string") return inner;
  }
  return "";
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
  // Omit optional rationale/evidence unless the caller supplies them: a
  // supplied blank rationale is now rejected rather than treated as absent, so
  // the helper must not inject an empty default.
  const raw = await harness.plugin.tool?.work_item_decide?.execute(
    { ...input } as never,
    createStubToolContext(harness, sessionID, agent) as never,
  );
  const parsed = parseToolJson<Record<string, unknown>>(raw ?? "{}");
  expect(validateWorkflowToolResult("work_item_decide", parsed).ok).toBe(true);
  return parsed;
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

  test("rejects a launch whose generic task dependencies are unmet", async () => {
    const { workspaceRoot } = await buildDelegatedWorkspace(1, [1], () => 1);
    const harness = await createDelegatedPluginHarness(workspaceRoot, "balanced");
    const raw = await harness.plugin.tool?.work_item_open?.execute(
      {
        items: [
          {
            key: "dep-first",
            title: "First task",
            mode: "delegated",
            requiredReviewers: [],
            taskId: "T-100",
            writeScope: ["src/tasks"],
            acceptanceCriteria: ["First works."],
          },
          {
            key: "dep-second",
            title: "Second task",
            mode: "delegated",
            requiredReviewers: [],
            taskId: "T-200",
            writeScope: ["src/tasks"],
            acceptanceCriteria: ["Second works."],
            dependsOn: ["T-100"],
          },
        ],
        execution: {
          executionKey: "dep-gate",
          source: { kind: "conversation-scoped" },
          goal: "Gate dependent launches.",
          boundary: { files: ["src/tasks"], directories: [] },
        },
      } as never,
      createStubToolContext(harness, ROOT_SESSION) as never,
    );
    const opened = parseToolJson<{
      ok: boolean;
      execution?: { tasks: Array<{ taskId: string; workItemId: string }> };
    }>(raw ?? "{}");
    expect(opened.ok).toBe(true);
    const second = opened.execution?.tasks.find((task) => task.taskId === "T-200");
    expect(second?.workItemId).toBeTruthy();

    await expect(
      launchTask(harness, ROOT_SESSION, "call-dep-gate", "vv-implementer", second!.workItemId),
    ).rejects.toThrow(/LAUNCH_REJECTED_DEPENDENCY/);
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
      .then(() => undefined)
      .catch((error: Error) => error);
    expect(String(selfAcceptance)).toContain("CONTROL_DENIED");
    expect((selfAcceptance as { code?: string }).code).toBe("CONTROL_DENIED");
    expect((selfAcceptance as { category?: string }).category).toBe("authorization");

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
      .then(() => undefined)
      .catch((error: Error) => error);
    expect(String(deniedChild)).toContain("root session");
    expect((deniedChild as { code?: string }).code).toBe("CONTROL_DENIED");
    expect((deniedChild as { category?: string }).category).toBe("authorization");
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
      .then(() => undefined)
      .catch((error: Error) => error);
    expect(String(unknownSession)).toContain("could not be verified");
    expect((unknownSession as { code?: string }).code).toBe("HOST_CONTEXT_UNAVAILABLE");
    expect((unknownSession as { category?: string }).category).toBe("host_context");
    harness.sessionGetFails = false;

    const untrusted = {
      ...createStubToolContext(harness, ROOT_SESSION),
      worktree: "/tmp/untrusted-workspace",
    };
    harness.sessions.set(ROOT_SESSION, { locationDirectory: "/tmp/untrusted-workspace" });
    const deniedWorkspace = await harness.plugin.tool?.work_checkpoint
      ?.execute(
        { action: "start", runId, checkpointId: "CHECKPOINT-R-001" } as never,
        untrusted as never,
      )
      .then(() => undefined)
      .catch((error: Error) => error);
    expect(String(deniedWorkspace)).toContain("does not match the trusted plugin workspace");
    expect((deniedWorkspace as { code?: string }).code).toBe("CONTROL_DENIED");
    expect((deniedWorkspace as { category?: string }).category).toBe("authorization");
    harness.sessions.delete(ROOT_SESSION);
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
    const deniedError = await secondHarness.plugin.tool?.work_checkpoint
      ?.execute(
        { action: "start", runId, checkpointId: "CHECKPOINT-R-001" } as never,
        createStubToolContext(secondHarness, ROOT_SESSION) as never,
      )
      .then(() => undefined)
      .catch((error: Error) => error);
    expect(String(deniedError)).toContain("invalid");
    expect((deniedError as { code?: string }).code).toBe("PERSISTENCE_FAILED");
    expect((deniedError as { category?: string }).category).toBe("persistence");
  });
});
// END_BLOCK_AUTHORIZATION_TESTS

// START_BLOCK_NATIVE_ROUTING_CONTRACTS
describe("native and generic run routing through the registered wrapper", () => {
  test("generic-only actions on a native run and conflicting register routes are explicit rejections", async () => {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(1, [1], () => 1);
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(harness, planPath);
    expect(runId).toBeTruthy();

    const reviewNative = parseToolJson<{ ok: boolean; errorCode?: string; message?: string }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        { action: "review", runId, checkpointId: "CHECKPOINT-R-001" } as never,
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(reviewNative.ok).toBe(false);
    expect(reviewNative.errorCode).toBe("INVALID_INPUT");
    expect(String(reviewNative.message)).toContain("native-package run");
    expect(String(reviewNative.message)).toContain(runId);

    const completeNative = parseToolJson<{ ok: boolean; errorCode?: string; message?: string }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        { action: "complete", runId } as never,
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(completeNative.ok).toBe(false);
    expect(String(completeNative.message)).toContain("native-package run");

    // planPath and runId are mutually exclusive registration routes.
    const conflictingRegister = parseToolJson<{
      ok: boolean;
      errorCode?: string;
      message?: string;
    }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        { action: "register", planPath, runId } as never,
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(conflictingRegister.ok).toBe(false);
    expect(conflictingRegister.errorCode).toBe("INVALID_INPUT");
    expect(String(conflictingRegister.message)).toContain("runId");

    // Unknown run with a generic-only action is a lookup failure, not a
    // native-argument requirement.
    const unknownRun = parseToolJson<{ ok: boolean; errorCode?: string; message?: string }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        { action: "review", runId: "run-does-not-exist", checkpointId: "C-1" } as never,
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(unknownRun.ok).toBe(false);
    expect(unknownRun.errorCode).toBe("EXECUTION_NOT_FOUND");
    expect(String(unknownRun.message)).not.toContain("start and verify");
    expect(String(unknownRun.message)).not.toContain("planPath");

    // The native run itself stays registered after the rejected calls.
    const listed = parseToolJson<{
      planRuns?: Array<{ runId: string; tasks: Array<{ taskId: string }> }>;
    }>(
      (await harness.plugin.tool?.work_item_list?.execute(
        { includeClosed: true },
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    const nativeRun = listed.planRuns?.find((entry) => entry.runId === runId);
    expect(nativeRun).toBeDefined();
    expect(nativeRun?.tasks.map((entry) => entry.taskId)).toEqual(["T-001"]);
  });

  test("source-only fields reject after source lookup and unknown runs stay lookup failures", async () => {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(1, [1], () => 1);
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const nativeRunId = await registerPlan(harness, planPath);
    const context = createStubToolContext(harness, ROOT_SESSION);

    const nativeFingerprint = parseToolJson<{ ok: boolean; message?: string }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        {
          action: "start",
          runId: nativeRunId,
          checkpointId: "CHECKPOINT-R-001",
          startFingerprint: "abc",
        } as never,
        context as never,
      )) ?? "{}",
    );
    expect(nativeFingerprint.ok).toBe(false);
    expect(String(nativeFingerprint.message)).toContain("startFingerprint");

    const nativeReviewer = parseToolJson<{ ok: boolean; message?: string }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        {
          action: "verify",
          runId: nativeRunId,
          checkpointId: "CHECKPOINT-R-001",
          reviewer: "code",
        } as never,
        context as never,
      )) ?? "{}",
    );
    expect(nativeReviewer.ok).toBe(false);
    expect(String(nativeReviewer.message)).toContain("reviewer");

    const registered = parseToolJson<{ ok: boolean; runId?: string }>(
      (await harness.plugin.tool?.work_item_open?.execute(
        {
          items: [
            {
              key: "gen-src",
              title: "Generic",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/lib/a.ts"],
              taskId: "T-GEN",
            },
          ],
          execution: {
            executionKey: "gen-src",
            source: { kind: "conversation-scoped" },
            goal: "Exercise source-dependent fields.",
            boundary: { files: ["src/lib/a.ts"], directories: [] },
          },
        } as never,
        context as never,
      )) ?? "{}",
    );
    expect(registered.ok).toBe(true);
    const genericRunId = String(registered.runId);

    const genericComplete = parseToolJson<{ ok: boolean; message?: string }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        {
          action: "verify",
          runId: genericRunId,
          checkpointId: "review-T-GEN",
          complete: true,
        } as never,
        context as never,
      )) ?? "{}",
    );
    expect(genericComplete.ok).toBe(false);
    expect(String(genericComplete.message)).toContain("complete");

    const genericRecoverMessage = parseToolJson<{ ok: boolean; message?: string }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        {
          action: "recover",
          runId: genericRunId,
          checkpointId: "review-T-GEN",
          recoveryId: "rec-src",
          diagnosis: "Both generations failed.",
          changedCondition: "Narrowed coverage.",
          verification: ["src/lib/a.ts"],
          userMessageId: "msg-1",
        } as never,
        context as never,
      )) ?? "{}",
    );
    expect(genericRecoverMessage.ok).toBe(false);
    expect(String(genericRecoverMessage.message)).toContain("userMessageId");

    // An unknown run stays a lookup failure even when a native-only field is present.
    const unknownRun = parseToolJson<{ ok: boolean; message?: string }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        { action: "verify", runId: "run-unknown", checkpointId: "C-1", complete: true } as never,
        context as never,
      )) ?? "{}",
    );
    expect(unknownRun.ok).toBe(false);
    expect(String(unknownRun.message)).not.toContain("complete");
  });

  test("a foreign root session sees no source details for another session's run", async () => {
    const { workspaceRoot } = await buildDelegatedWorkspace(1, [1], () => 1);
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const ownerContext = createStubToolContext(harness, ROOT_SESSION);
    const registered = parseToolJson<{ ok: boolean; runId?: string }>(
      (await harness.plugin.tool?.work_item_open?.execute(
        {
          items: [
            {
              key: "owned-run",
              title: "Owned",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/lib/a.ts"],
              taskId: "T-OWNED",
            },
          ],
          execution: {
            executionKey: "owned-run",
            source: { kind: "conversation-scoped" },
            goal: "Owned by the registering session.",
            boundary: { files: ["src/lib/a.ts"], directories: [] },
          },
        } as never,
        ownerContext as never,
      )) ?? "{}",
    );
    expect(registered.ok).toBe(true);
    const runId = String(registered.runId);

    const foreignContext = createStubToolContext(harness, "ses_delegated_foreign");
    const foreignCalls: Array<Record<string, unknown>> = [
      { action: "verify", runId, checkpointId: "review-T-OWNED" },
      { action: "verify", runId, checkpointId: "review-T-OWNED", complete: true },
      { action: "verify", runId, checkpointId: "review-T-OWNED", complete: false },
      { action: "start", runId, checkpointId: "review-T-OWNED", startFingerprint: "abc" },
      {
        action: "recover",
        runId,
        checkpointId: "review-T-OWNED",
        recoveryId: "rec-foreign",
        diagnosis: "d",
        changedCondition: "c",
        verification: ["v"],
        userMessageId: "msg-1",
      },
    ];
    for (const args of foreignCalls) {
      const result = parseToolJson<{ ok: boolean; errorCode?: string; message?: string }>(
        (await harness.plugin.tool?.work_checkpoint?.execute(
          args as never,
          foreignContext as never,
        )) ?? "{}",
      );
      expect(result.ok).toBe(false);
      const message = String(result.message ?? "");
      expect(message).not.toContain("complete");
      expect(message).not.toContain("startFingerprint");
      expect(message).not.toContain("userMessageId");
      expect(message).not.toContain("generic");
      expect(message).not.toContain("native-package");
      expect(message).not.toContain(ROOT_SESSION);
    }
  });

  test("a whitespace-padded generic runId routes through the staged fail-closed transaction", async () => {
    const { workspaceRoot } = await buildDelegatedWorkspace(1, [1], () => 1);
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const context = createStubToolContext(harness, ROOT_SESSION);

    const registered = parseToolJson<{ ok: boolean; runId?: string }>(
      (await harness.plugin.tool?.work_item_open?.execute(
        {
          items: [
            {
              key: "gen-normalized",
              title: "Generic",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/lib/a.ts"],
              taskId: "T-NORM",
            },
          ],
          execution: {
            executionKey: "gen-normalized",
            source: { kind: "conversation-scoped" },
            goal: "Route by a normalized runId.",
            boundary: { files: ["src/lib/a.ts"], directories: [] },
          },
        } as never,
        context as never,
      )) ?? "{}",
    );
    expect(registered.ok).toBe(true);
    const runId = String(registered.runId);

    // Force the checked snapshot write to fail by occupying the state path.
    const statePath = join(getWorkflowSessionDir(ROOT_SESSION), "workflow-state.json");
    rmSync(statePath, { recursive: true, force: true });
    mkdirSync(statePath, { recursive: true });

    const failed = parseToolJson<{ ok: boolean; errorCode?: string; message?: string }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        {
          action: "amend",
          runId: ` ${runId} `,
          amendmentId: "amend-normalized",
          rationale: "Append after normalizing the runId.",
          tasks: [
            {
              key: "gen-normalized-2",
              title: "Generic 2",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/lib/a.ts"],
              taskId: "T-NORM-2",
            },
          ],
        } as never,
        context as never,
      )) ?? "{}",
    );
    expect(failed.ok).toBe(false);
    expect(failed.errorCode).toBe("PERSISTENCE_FAILED");

    // After I/O recovery the amendment applies as revision 2: the failed
    // padded call never published a partial live mutation.
    rmSync(statePath, { recursive: true, force: true });
    const retried = parseToolJson<{
      ok: boolean;
      execution?: { revision?: number };
    }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        {
          action: "amend",
          runId,
          amendmentId: "amend-normalized",
          rationale: "Append after normalizing the runId.",
          tasks: [
            {
              key: "gen-normalized-2",
              title: "Generic 2",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/lib/a.ts"],
              taskId: "T-NORM-2",
            },
          ],
        } as never,
        context as never,
      )) ?? "{}",
    );
    expect(retried.ok).toBe(true);
    expect(retried.execution?.revision).toBe(2);
  });
});
// END_BLOCK_NATIVE_ROUTING_CONTRACTS

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
    expect(call?.sessionID).toBe("ses_delegated_continuation");
    expect(Object.keys(call ?? {}).sort()).toEqual(["sessionID", "text"]);
    expect(call?.text).toContain("Plain progress without a protocol header.");

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
    expect(validateWorkflowToolResult("work_item_close", closedReport).ok).toBe(true);
    const prematureComplete = parseToolJson<{ ok: boolean; errorCode?: string }>(
      (await harness.plugin.tool?.work_checkpoint?.execute(
        { action: "verify", runId, checkpointId: "CHECKPOINT-R-001", complete: true } as never,
        createStubToolContext(harness, ROOT_SESSION) as never,
      )) ?? "{}",
    );
    expect(prematureComplete.ok).toBe(false);

    // Rework the covered accepted task, correct it, re-accept, and complete.
    const t2 = await taskWorkItemId(harness, runId, "T-002");
    // rework consumes only its failed checkpoint binding plus the bounded
    // reason; supplying evidence is a recognized-field conflict and is rejected.
    const reworked = await decide(harness, {
      workItemId: t2,
      attempt: 1,
      decision: "rework",
      rationale: "Spec review found a missing branch.",
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

  test("an attempt orphaned by a restart stays in-flight and preserves consumed budget", async () => {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(1, [1], () => 1);
    const firstHarness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(firstHarness, planPath);
    const workItemId = await taskWorkItemId(firstHarness, runId, "T-001");
    await launchTask(firstHarness, ROOT_SESSION, "call-orphan", "vv-implementer", workItemId);

    // A fresh plugin instance simulates the restart: hydration must NOT refund
    // the in-flight attempt or its consumed budget. It remains in-flight until
    // explicit, evidence-backed recovery settles it.
    const secondHarness = await createDelegatedPluginHarness(workspaceRoot);
    const listed = await listItems(secondHarness);
    const item = listed.items.find((entry) => entry.workItemId === workItemId);
    expect(item?.state).toBe("awaiting_implementer");
    expect(item?.delegated?.inFlightAttempt).toBe(true);
    expect(item?.delegated?.attempts).toBe(1);
    expect(item?.delegated?.remainingAttempts).toBe(1);
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
    return { sessionID: child, status: "running" };
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
          `Subagent failed (sessionID: ${CHILD}): unknown provider for model deepseek-flash`,
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
        errorState(
          `Subagent failed (sessionID: ${CHILD}): transport failure`,
          foregroundMetadata(),
        ),
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
            `Subagent failed (sessionID: ${child}): provider error`,
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
        "ses_other_parent",
        "call-mismatch",
        errorState(`Subagent failed (sessionID: ${CHILD}): provider error`, {
          sessionID: CHILD,
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
          "Subagent failed (sessionID: ses_delegated_child_other): provider error",
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
        errorState(`Subagent failed (sessionID: ${CHILD}): provider error`, foregroundMetadata()),
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
        errorState(`Subagent failed (sessionID: ${CHILD}): provider error`, foregroundMetadata()),
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
        errorState(`Subagent failed (sessionID: ${CHILD}): provider error`, foregroundMetadata()),
      ),
    );
    expect(
      (await listItems(background.harness)).items.find(
        (i) => i.workItemId === background.workItemId,
      )?.delegated?.inFlightAttempt,
    ).toBe(true);

    // A later native launch that resumes an existing child is ineligible.
    const subtask = await harnessWithTask();
    await launchTaskWithArgs(
      subtask.harness,
      ROOT_SESSION,
      "call-subtask",
      "vv-implementer",
      `VVOC_WORK_ITEM_ID: ${subtask.workItemId}`,
      { sessionID: "ses_existing_child" },
    );
    await emitPart(
      subtask.harness,
      taskToolPart(
        ROOT_SESSION,
        "call-subtask",
        errorState(`Subagent failed (sessionID: ${CHILD}): provider error`, foregroundMetadata()),
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
    await promotion.harness.plugin.afterRunning({
      sessionID: ROOT_SESSION,
      callID: "call-promote",
      subagentType: "vv-implementer",
      workItemId: promotion.workItemId,
      childSessionId: CHILD,
    });
    await emitPart(
      promotion.harness,
      taskToolPart(
        ROOT_SESSION,
        "call-promote",
        errorState(`Subagent failed (sessionID: ${CHILD}): provider error`, foregroundMetadata()),
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
      taskToolPart(ROOT_SESSION, "call-int", runningState({ sessionID: CHILD, status: "running" })),
    );
    await emitPart(
      interrupted.harness,
      taskToolPart(
        ROOT_SESSION,
        "call-int",
        errorState(
          `Tool execution interrupted: subagent (sessionID: ${CHILD})`,
          foregroundMetadata(),
        ),
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
        errorState(`Subagent failed (sessionID: ${CHILD}): provider error`, foregroundMetadata()),
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
      type: "session.inbox.enqueued",
      data: { sessionID: CHILD, inboxID: id, item: { type: "user" } },
    });
    harness.emit(userMessage("msg-child-1"));
    harness.emit(userMessage("msg-child-2"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await emitPart(
      harness,
      taskToolPart(
        ROOT_SESSION,
        "call-reprompt",
        errorState(`Subagent failed (sessionID: ${CHILD}): provider error`, foregroundMetadata()),
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
      errorState(`Subagent failed (sessionID: ${CHILD}): provider error`, metadata),
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

// START_BLOCK_LAUNCH_PERSISTENCE_TESTS
/**
 * A launch mutates live attempt/budget/reviewer state, so it must not proceed
 * unless that transition is durably persisted. Each launch family is staged,
 * persisted, then published; a failed write refuses before any child runs and
 * leaves the original state intact.
 */
describe("staged launch persistence", () => {
  function occupyStatePath(): string {
    const statePath = join(getWorkflowSessionDir(ROOT_SESSION), "workflow-state.json");
    rmSync(statePath, { recursive: true, force: true });
    mkdirSync(statePath, { recursive: true });
    return statePath;
  }

  test("a delegated launch refuses without a durable attempt and persists on success", async () => {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(1, [1], () => 1);
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(harness, planPath);
    const workItemId = await taskWorkItemId(harness, runId, "T-001");

    const statePath = occupyStatePath();
    const refused = await launchTask(
      harness,
      ROOT_SESSION,
      "call-persist-fail",
      "vv-implementer",
      workItemId,
    )
      .then(() => undefined)
      .catch((error: Error) => error.message);
    expect(String(refused)).toContain("LAUNCH_PERSISTENCE_FAILED");

    // No attempt is exposed and the live item did not advance.
    let item = (await listItems(harness)).items.find((entry) => entry.workItemId === workItemId);
    expect(item?.delegated?.inFlightAttempt).toBe(false);
    expect(item?.delegated?.attempts).toBe(0);
    expect(item?.state).toBe("open");

    // After I/O recovery the same launch persists the consumed attempt.
    rmSync(statePath, { recursive: true, force: true });
    await launchTask(harness, ROOT_SESSION, "call-persist-ok", "vv-implementer", workItemId);
    item = (await listItems(harness)).items.find((entry) => entry.workItemId === workItemId);
    expect(item?.delegated?.inFlightAttempt).toBe(true);
    expect(item?.delegated?.attempts).toBe(1);

    // A fresh plugin instance hydrates the persisted in-flight attempt.
    const rehydrated = await createDelegatedPluginHarness(workspaceRoot);
    const hydrated = (await listItems(rehydrated)).items.find(
      (entry) => entry.workItemId === workItemId,
    );
    expect(hydrated?.delegated?.inFlightAttempt).toBe(true);
    expect(hydrated?.delegated?.attempts).toBe(1);
  });

  test("a reviewer launch refuses without a durable in-flight reviewer", async () => {
    const { workspaceRoot } = await buildDelegatedWorkspace(1, [1], () => 1);
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const openedRaw = await harness.plugin.tool?.work_item_open?.execute(
      {
        items: [
          {
            key: "review-persist",
            title: "Review persistence",
            mode: "review_only",
            requiredReviewers: ["spec"],
          },
        ],
      } as never,
      createStubToolContext(harness, ROOT_SESSION) as never,
    );
    const opened = parseToolJson<{
      items?: Array<{ ok: boolean; workItemId?: string }>;
    }>(openedRaw ?? "{}");
    const openedItem = opened.items?.[0];
    expect(openedItem?.ok).toBe(true);
    const workItemId = openedItem?.workItemId ?? "";
    expect(workItemId).toBeTruthy();
    expect((await listItems(harness)).items.find((e) => e.workItemId === workItemId)?.state).toBe(
      "awaiting_reviews",
    );

    const statePath = occupyStatePath();
    const refused = await launchTask(
      harness,
      ROOT_SESSION,
      "call-reviewer-fail",
      "vv-spec-reviewer",
      workItemId,
    )
      .then(() => undefined)
      .catch((error: Error) => error.message);
    expect(String(refused)).toContain("LAUNCH_PERSISTENCE_FAILED");

    // The refused launch was not published: the same reviewer can still be
    // launched after I/O recovery (an in-memory in-flight mark would reject it).
    rmSync(statePath, { recursive: true, force: true });
    await launchTask(harness, ROOT_SESSION, "call-reviewer-ok", "vv-spec-reviewer", workItemId);
    const listed = await listItems(harness);
    const item = listed.items.find((entry) => entry.workItemId === workItemId);
    expect(item?.state).toBe("awaiting_reviews");
  });

  test("an ordinary tracked launch refuses without a durable transition", async () => {
    const { workspaceRoot } = await buildDelegatedWorkspace(1, [1], () => 1);
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const openedRaw = await harness.plugin.tool?.work_item_open?.execute(
      {
        items: [
          {
            key: "impl-persist",
            title: "Implementation persistence",
            mode: "implementation",
            requiredReviewers: ["code"],
          },
        ],
      } as never,
      createStubToolContext(harness, ROOT_SESSION) as never,
    );
    const opened = parseToolJson<{ items?: Array<{ ok: boolean; workItemId?: string }> }>(
      openedRaw ?? "{}",
    );
    const workItemId = opened.items?.[0]?.workItemId ?? "";
    expect(opened.items?.[0]?.ok).toBe(true);
    expect(workItemId).toBeTruthy();

    const statePath = occupyStatePath();
    const refused = await launchTask(
      harness,
      ROOT_SESSION,
      "call-impl-fail",
      "vv-implementer",
      workItemId,
    )
      .then(() => undefined)
      .catch((error: Error) => error.message);
    expect(String(refused)).toContain("LAUNCH_PERSISTENCE_FAILED");

    // After I/O recovery the ordinary launch proceeds.
    rmSync(statePath, { recursive: true, force: true });
    await launchTask(harness, ROOT_SESSION, "call-impl-ok", "vv-implementer", workItemId);
    const item = (await listItems(harness)).items.find((entry) => entry.workItemId === workItemId);
    expect(item?.state).toBe("open");
  });
});
// END_BLOCK_LAUNCH_PERSISTENCE_TESTS

// START_BLOCK_NATIVE_CANCELLATION_RECOVERY_TESTS
describe("native background settlement and explicit cancellation recovery", () => {
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

  test("a background subagent settles only on its native synthetic terminal delivery", async () => {
    const { harness, workItemId } = await harnessWithTask();
    await launchTaskWithArgs(
      harness,
      ROOT_SESSION,
      "call-bg-term",
      "vv-implementer",
      `VVOC_WORK_ITEM_ID: ${workItemId}`,
      { background: true },
    );
    await harness.plugin.afterRunning({
      sessionID: ROOT_SESSION,
      callID: "call-bg-term",
      subagentType: "vv-implementer",
      workItemId,
      childSessionId: "ses_bg_child",
    });
    harness.sessions.set("ses_bg_child", { parentID: ROOT_SESSION });

    let item = (await listItems(harness)).items.find((i) => i.workItemId === workItemId);
    expect(item?.delegated?.inFlightAttempt).toBe(true);

    harness.emit({
      type: "session.synthetic",
      data: {
        sessionID: ROOT_SESSION,
        text: `<subagent sessionID="ses_bg_child" state="completed" description="task">\nVVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: DONE\nVVOC_ROUTE: change_with_review\n\nBackground finished.\n</subagent>`,
        metadata: { source: "subagent", childID: "ses_bg_child", state: "completed" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    item = (await listItems(harness)).items.find((i) => i.workItemId === workItemId);
    expect(item?.state).toBe("awaiting_acceptance");
    expect(item?.delegated?.inFlightAttempt).toBe(false);
  });

  function seedCancellationEvidence(
    harness: DelegatedPluginHarness,
    callId: string,
    options: {
      parentCompleted: number;
      childCompleted: number;
      childIdle?: number;
      childError?: boolean;
      /**
       * Pinned parent subagent tool-part failure. Defaults to the child-cancelled
       * shape; interruption tests seed one of the pinned native interrupt shapes.
       */
      parentFailure?: { type?: string; message: string };
    },
  ): void {
    const childId = "ses_cancel_child";
    const parentFailure = options.parentFailure ?? {
      type: "tool.execution",
      message: `Subagent cancelled (sessionID: ${childId})`,
    };
    harness.sessionMessages.set(ROOT_SESSION, [
      {
        id: "msg_parent",
        type: "assistant",
        content: [
          {
            type: "tool",
            id: callId,
            name: "subagent",
            state: {
              status: "error",
              input: {},
              error: {
                type: parentFailure.type ?? "tool.execution",
                message: parentFailure.message,
              },
              metadata: { sessionID: childId, status: "running" },
            },
            // Native timing is beside `state`, on the assistant tool part.
            time: { created: 10, completed: options.parentCompleted },
          },
        ],
        time: { created: 10 },
      },
    ]);
    harness.sessions.set(childId, {
      parentID: ROOT_SESSION,
      ...(options.childIdle === undefined ? {} : { idle: options.childIdle }),
      outcome: options.childError === false ? "succeeded" : "interrupted",
    });
    harness.sessionMessages.set(childId, [
      {
        id: "msg_child",
        type: "assistant",
        content: [{ type: "text", text: "cancelled work" }],
        ...(options.childError === false
          ? {}
          : { error: { type: "aborted", message: "Interrupted by user" } }),
        time: { created: 11, completed: options.childCompleted },
      },
    ]);
  }

  function persistedRecord(workItemId: string) {
    const hydrated = hydrateWorkflowStateChecked(ROOT_SESSION);
    if (hydrated.status !== "valid") return undefined;
    for (const record of hydrated.data.records.values()) {
      if (record.workItemId === workItemId) return record;
    }
    return undefined;
  }

  function persistedAttempt(workItemId: string) {
    return persistedRecord(workItemId)?.delegated?.attempts[0];
  }

  test("explicit recovery settles a cancelled attempt with historical completion timestamps", async () => {
    const { harness, workItemId } = await harnessWithTask();
    await launchTask(harness, ROOT_SESSION, "call-cancel", "vv-implementer", workItemId);
    seedCancellationEvidence(harness, "call-cancel", {
      // Parent end is AFTER the child completion: max must select the parent.
      parentCompleted: 70,
      childCompleted: 55,
    });

    const recovered = await decide(harness, {
      workItemId,
      attempt: 1,
      decision: "recover",
      diagnosis: "The worker was cancelled by the host.",
      changedCondition: "Resume after explicit native cancellation evidence.",
      verification: ["src/tasks/task-001.test.ts"],
      recoveryId: "rec-cancel-1",
    });
    expect(recovered.ok).toBe(true);
    const item = (await listItems(harness)).items.find((i) => i.workItemId === workItemId);
    expect(item?.delegated?.inFlightAttempt).toBe(false);
    expect(item?.delegated?.attempts).toBe(1);
    const record = persistedRecord(workItemId);
    expect(record?.delegated?.recoveryHistory).toHaveLength(1);
    expect(record?.delegated?.recoveryHistory[0]?.kind).toBe("resume");
    const attempt = persistedAttempt(workItemId);
    expect(attempt?.status).toBe("failed");
    expect(attempt?.completedAt).toBe(new Date(70).toISOString());
  });

  test("explicit recovery settles a live root-interrupt attempt with the max historical completion timestamp", async () => {
    const { harness, workItemId } = await harnessWithTask();
    await launchTask(harness, ROOT_SESSION, "call-root-int", "vv-implementer", workItemId);
    seedCancellationEvidence(harness, "call-root-int", {
      // LIVE in-process root interrupt (step.ts TOOLS_INTERRUPTED composed by
      // publish-llm-event.ts failTool): the parent tool part carries
      // `Tool execution interrupted (sessionID: <child>)`, and the child's
      // terminal abort lands later, so max must select the child completion.
      parentCompleted: 40,
      childCompleted: 55,
      parentFailure: {
        type: "aborted",
        message: "Tool execution interrupted (sessionID: ses_cancel_child)",
      },
    });

    const recovered = await decide(harness, {
      workItemId,
      attempt: 1,
      decision: "recover",
      diagnosis: "The root session was interrupted while the worker was running.",
      changedCondition: "Resume after the explicit native root-interrupt evidence.",
      verification: ["src/tasks/task-001.test.ts"],
      recoveryId: "rec-root-int-1",
    });
    expect(recovered.ok).toBe(true);
    const item = (await listItems(harness)).items.find((i) => i.workItemId === workItemId);
    expect(item?.delegated?.inFlightAttempt).toBe(false);
    expect(item?.delegated?.attempts).toBe(1);
    const record = persistedRecord(workItemId);
    expect(record?.delegated?.recoveryHistory).toHaveLength(1);
    expect(record?.delegated?.recoveryHistory[0]?.kind).toBe("resume");
    const attempt = persistedAttempt(workItemId);
    expect(attempt?.status).toBe("failed");
    expect(attempt?.completedAt).toBe(new Date(55).toISOString());
  });

  test("a bare tool interrupt without a subagent child session id never settles recovery", async () => {
    const { harness, workItemId } = await harnessWithTask();
    await launchTask(harness, ROOT_SESSION, "call-bare-int", "vv-implementer", workItemId);
    seedCancellationEvidence(harness, "call-bare-int", {
      parentCompleted: 70,
      childCompleted: 55,
      // No child session id in the message: never parent-cancelled evidence,
      // even though the child itself aborted and is quiescent.
      parentFailure: { type: "aborted", message: "Tool execution interrupted" },
    });

    const refused = await decide(harness, {
      workItemId,
      attempt: 1,
      decision: "recover",
      diagnosis: "Attempted recovery on a bare interrupt without child evidence.",
      changedCondition: "Wait for authoritative cancellation evidence.",
      verification: ["src/tasks/task-001.test.ts"],
      recoveryId: "rec-bare-int",
    });
    expect(refused.ok).toBe(false);
    expect(refused.errorCode).toBe("CANCELLATION_EVIDENCE_REQUIRED");

    const item = (await listItems(harness)).items.find((i) => i.workItemId === workItemId);
    expect(item?.delegated?.inFlightAttempt).toBe(true);
    expect(item?.delegated?.attempts).toBe(1);
    expect(item?.delegated?.recoveryCount ?? 0).toBe(0);
    expect(persistedAttempt(workItemId)?.completedAt).toBeUndefined();
  });

  test("an active or incomplete cancellation child refuses recovery without changing budget", async () => {
    const { harness, workItemId } = await harnessWithTask();
    await launchTask(harness, ROOT_SESSION, "call-cancel-active", "vv-implementer", workItemId);
    seedCancellationEvidence(harness, "call-cancel-active", {
      parentCompleted: 70,
      childCompleted: 55,
    });
    // The child is still reported active, so evidence is not quiescent.
    harness.activeSessions.add("ses_cancel_child");

    const refused = await decide(harness, {
      workItemId,
      attempt: 1,
      decision: "recover",
      diagnosis: "Attempted recovery while the child may still be active.",
      changedCondition: "Wait for quiescence.",
      verification: ["src/tasks/task-001.test.ts"],
      recoveryId: "rec-cancel-active",
    });
    expect(refused.ok).toBe(false);
    expect(refused.errorCode).toBe("CANCELLATION_EVIDENCE_REQUIRED");

    const item = (await listItems(harness)).items.find((i) => i.workItemId === workItemId);
    expect(item?.delegated?.inFlightAttempt).toBe(true);
    expect(item?.delegated?.attempts).toBe(1);
    expect(item?.delegated?.recoveryCount ?? 0).toBe(0);

    // A non-cancellation parent failure is never evidence either.
    const generic = await harnessWithTask();
    await launchTask(
      generic.harness,
      ROOT_SESSION,
      "call-generic",
      "vv-implementer",
      generic.workItemId,
    );
    generic.harness.sessionMessages.set(ROOT_SESSION, [
      {
        id: "msg_parent_generic",
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "call-generic",
            name: "subagent",
            state: {
              status: "error",
              input: {},
              error: { type: "provider.transport", message: "provider transport failure" },
              metadata: { sessionID: "ses_cancel_child" },
            },
            time: { created: 10, completed: 70 },
          },
        ],
        time: { created: 10 },
      },
    ]);
    const refusedGeneric = await decide(generic.harness, {
      workItemId: generic.workItemId,
      attempt: 1,
      decision: "recover",
      diagnosis: "Generic transport failure is not cancellation evidence.",
      changedCondition: "None.",
      verification: ["src/tasks/task-001.test.ts"],
      recoveryId: "rec-cancel-generic",
    });
    expect(refusedGeneric.ok).toBe(false);
    expect(refusedGeneric.errorCode).toBe("CANCELLATION_EVIDENCE_REQUIRED");

    // A missing parent tool-part historical timestamp is not evidence.
    const missingTime = await harnessWithTask();
    await launchTask(
      missingTime.harness,
      ROOT_SESSION,
      "call-missing-time",
      "vv-implementer",
      missingTime.workItemId,
    );
    missingTime.harness.sessionMessages.set(ROOT_SESSION, [
      {
        id: "msg_parent_missing_time",
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "call-missing-time",
            name: "subagent",
            state: {
              status: "error",
              input: {},
              error: {
                type: "tool.execution",
                message: "Subagent cancelled (sessionID: ses_cancel_child)",
              },
              metadata: { sessionID: "ses_cancel_child" },
            },
            // No `time.completed` beside the state.
            time: { created: 10 },
          },
        ],
        time: { created: 10 },
      },
    ]);
    missingTime.harness.sessions.set("ses_cancel_child", { parentID: ROOT_SESSION, idle: 60 });
    missingTime.harness.sessionMessages.set("ses_cancel_child", [
      {
        id: "msg_child_missing_time",
        type: "assistant",
        content: [{ type: "text", text: "cancelled" }],
        error: { type: "aborted", message: "Interrupted by user" },
        time: { created: 11, completed: 55 },
      },
    ]);
    const refusedMissingTime = await decide(missingTime.harness, {
      workItemId: missingTime.workItemId,
      attempt: 1,
      decision: "recover",
      diagnosis: "Missing parent terminal timestamp.",
      changedCondition: "None.",
      verification: ["src/tasks/task-001.test.ts"],
      recoveryId: "rec-cancel-missing-time",
    });
    expect(refusedMissingTime.ok).toBe(false);
    expect(refusedMissingTime.errorCode).toBe("CANCELLATION_EVIDENCE_REQUIRED");
  });

  test("a fork session cannot run control mutations", async () => {
    const { harness, workItemId } = await harnessWithTask();
    await launchTask(harness, ROOT_SESSION, "call-fork", "vv-implementer", workItemId);
    harness.sessions.set(ROOT_SESSION, { forkSessionID: "ses_root_origin" });
    const denied = await decide(harness, {
      workItemId,
      attempt: 1,
      decision: "accept",
      rationale: "Fork controller attempt.",
      evidence: ["diff"],
    }).catch((error: Error) => error);
    expect(String(denied)).toContain("fork");
  });
});
// END_BLOCK_NATIVE_CANCELLATION_RECOVERY_TESTS

// START_BLOCK_LAZY_CLIENT_RETRY_TESTS
describe("lazy client acquisition recovery", () => {
  test("a rejected acquisition is retried instead of cached forever", async () => {
    const { workspaceRoot } = await buildDelegatedWorkspace(1, [1], () => 1);
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const decide = harness.plugin.tool?.work_item_decide;
    expect(decide).toBeDefined();
    const call = async () => {
      try {
        return await decide!.execute(
          {
            workItemId: "wi-missing",
            attempt: 1,
            decision: "accept",
            rationale: "retry probe",
            evidence: ["diff"],
          } as never,
          createStubToolContext(harness, ROOT_SESSION) as never,
        );
      } catch (error) {
        return error as { code?: string; errorCode?: string };
      }
    };

    harness.clientAcquireFails = true;
    const first = await call();
    expect((first as { code?: string }).code).toBe("HOST_CONTEXT_UNAVAILABLE");

    // The rejected acquisition must not be cached: a later lookup authenticates.
    harness.clientAcquireFails = false;
    const second = await call();
    expect(JSON.stringify(second)).toContain("WORK_ITEM_NOT_FOUND");
  });
});
// END_BLOCK_LAZY_CLIENT_RETRY_TESTS

// START_BLOCK_FOREGROUND_MALFORMED_SETTLEMENT_TESTS
/**
 * The foreground after hook parses a completed tracked report and may run one
 * bounded continuation. A client-acquisition failure there must be contained
 * locally so the attempt settles as a truthful report_rejected with the original
 * excerpt instead of throwing out of the hook and staying in_flight.
 */
describe("foreground malformed settlement under client failure", () => {
  test("a malformed report settles as report_rejected when client acquisition fails", async () => {
    const { workspaceRoot, planPath } = await buildDelegatedWorkspace(1, [1], () => 1);
    const harness = await createDelegatedPluginHarness(workspaceRoot);
    const runId = await registerPlan(harness, planPath);
    const workItemId = await taskWorkItemId(harness, runId, "T-001");
    await launchTask(harness, ROOT_SESSION, "call-malformed-client", "vv-implementer", workItemId);

    // The lazy client cannot be acquired exactly when the malformed report lands.
    harness.clientAcquireFails = true;
    const malformed = wrapTaskResult(
      "ses_malformed_child",
      `VVOC_WORK_ITEM_ID: ${workItemId}\nVVOC_STATUS: DONE`,
    );
    const finalText = await finishTaskWithRawOutput(
      harness,
      ROOT_SESSION,
      "call-malformed-client",
      "vv-implementer",
      workItemId,
      malformed,
    );
    // Settled through the original-output protocol path, never a forged DONE.
    expect(finalText).toContain("RESULT_PROTOCOL_ERROR");
    const item = (await listItems(harness)).items.find((entry) => entry.workItemId === workItemId);
    expect(item?.delegated?.inFlightAttempt).toBe(false);
    expect(item?.delegated?.reportRejectionCount).toBe(1);
    expect(item?.state).not.toBe("awaiting_acceptance");

    // A later acquisition succeeds because the rejected promise was not cached.
    harness.clientAcquireFails = false;
    const probe = await harness.plugin
      .tool!.work_item_decide!.execute(
        {
          workItemId,
          attempt: 1,
          decision: "accept",
          rationale: "probe",
          evidence: ["diff"],
        } as never,
        createStubToolContext(harness, ROOT_SESSION) as never,
      )
      .then((value) => value as { code?: string })
      .catch((error: { code?: string }) => error);
    expect(probe.code).not.toBe("HOST_CONTEXT_UNAVAILABLE");

    // Later pump events still process on the same live subscription: the
    // deletion removes this session's store so the item is no longer listed.
    harness.emit({ type: "session.deleted", data: { sessionID: ROOT_SESSION } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterDelete = await listItems(harness);
    expect(afterDelete.items.find((entry) => entry.workItemId === workItemId)).toBeUndefined();
  });
});
// END_BLOCK_FOREGROUND_MALFORMED_SETTLEMENT_TESTS
