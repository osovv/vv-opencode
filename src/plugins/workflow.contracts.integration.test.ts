// FILE: src/plugins/workflow.contracts.integration.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Registered-workflow integration coverage for the public result contract: real schemas, before hooks, execute wrappers, and serialization with pinned SDK-shaped context; early thrown diagnostics agreeing with direct handler failures; host-context separation; foreign-session non-disclosure; staged persistence-failure isolation; and producer validation of committed outputs.
//   SCOPE: One isolated plugin instance per case over a disposable config/data home; no live host process, no user database, no provider network.
//   DEPENDS: [bun:test, src/plugins/workflow/index.ts, src/plugins/workflow/results.ts, src/plugins/workflow/tooling.ts, src/plugins/workflow/persistence.ts, @opencode-ai/plugin]
//   LINKS: [M-WORKFLOW-TOOLING, M-AGENT-TOOL-CONTRACT, M-PLUGIN-WORKFLOW, V-M-PLUGIN-WORKFLOW]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ROOT_AGENT - Canonical controller agent for registered-tool calls.
//   previousConfigHome - Preserves the caller's config-home environment for cleanup.
//   previousDataHome - Preserves the caller's data-home environment for cleanup.
//   ContractsHarness - One isolated plugin instance plus its recorded logs.
//   createContractsHarness - Builds one isolated plugin plus its recorded logs.
//   parseToolJson - Parse a registered tool's JSON string or SDK result object.
//   createToolContext - Pinned SDK ToolContext shape for registered calls.
//   catchHookError - Invoke the before hook and return a thrown error instead of propagating.
//   usedSessions - Session ids already claimed by a harness, to keep sessions disjoint.
//   sessionId - Deterministic unique session id for one harness case.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-AGENT-TOOL-CONTRACTS T-003 - Registered-boundary result-contract coverage: hook/handler agreement, host-context and persistence classification, foreign-session non-disclosure, fail-closed owned staged guard through createRecoverySupport, truthful post-side-effect serialization outcome through the production serializer seam, producer schema validation, and bounded wire output for oversized caller-controlled error data.]
// END_CHANGE_SUMMARY

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ContractInputError } from "../lib/agent-tool-contract.js";
import { WorkflowPlugin } from "./workflow/index.js";
import { getWorkflowSessionDir, hydrateWorkflowStateChecked } from "./workflow/persistence.js";
import { createRecoverySupport } from "./workflow/recovery.js";
import { validateWorkflowToolResult, MAX_FAILURE_MESSAGE_CHARS } from "./workflow/results.js";
import { createWorkItemOpenTool } from "./workflow/tooling.js";
import { createWorkItemStore } from "./workflow/state.js";

const ROOT_AGENT = "vv-controller";
const previousConfigHome = process.env.XDG_CONFIG_HOME;
const previousDataHome = process.env.XDG_DATA_HOME;

type ContractsHarness = {
  plugin: Awaited<ReturnType<typeof WorkflowPlugin>>;
  logs: string[];
  parentBySession: Map<string, string | undefined>;
  sessionGetFails: { value: boolean };
};

async function createContractsHarness(): Promise<ContractsHarness> {
  const logs: string[] = [];
  const parentBySession = new Map<string, string | undefined>();
  const sessionGetFails = { value: false };
  const plugin = await WorkflowPlugin({
    client: {
      app: {
        log: async (payload: { body?: { message?: string } }) => {
          const message = payload.body?.message;
          if (typeof message === "string") logs.push(message);
        },
      },
      session: {
        get: async ({ path }: { path: { id: string } }) => {
          if (sessionGetFails.value) {
            throw new Error("upstream session lookup unavailable");
          }
          return { data: { sessionID: path.id, parentID: parentBySession.get(path.id) } };
        },
        prompt: async () => ({ data: undefined, error: { name: "BadRequest", data: {} } }),
        message: async () => ({ data: undefined, error: { name: "NotFound", data: {} } }),
      },
    } as never,
    project: {} as never,
    directory: "/tmp/project",
    worktree: "/tmp/project",
    experimental_workspace: { register: () => undefined },
    serverUrl: new URL("http://localhost"),
    $: {} as never,
  });
  return { plugin, logs, parentBySession, sessionGetFails };
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

function createToolContext(sessionID: string, agent = ROOT_AGENT) {
  return {
    sessionID,
    messageID: "message-1",
    agent,
    directory: "/tmp/project",
    worktree: "/tmp/project",
    abort: new AbortController().signal,
    metadata: () => undefined,
    ask: async () => undefined,
  };
}

async function catchHookError(
  plugin: Awaited<ReturnType<typeof WorkflowPlugin>>,
  tool: string,
  args: unknown,
  sessionID: string,
): Promise<unknown> {
  try {
    await plugin["tool.execute.before"]?.(
      { tool, sessionID, callID: `contracts-${tool}` } as never,
      { args } as never,
    );
    return undefined;
  } catch (error) {
    return error;
  }
}

const usedSessions = new Set<string>();

function sessionId(name: string): string {
  const id = `session-contracts-${name}`;
  usedSessions.add(id);
  return id;
}

beforeEach(() => {
  process.env.XDG_CONFIG_HOME = `/tmp/vvoc-contracts-config-${process.pid}`;
  process.env.XDG_DATA_HOME = `/tmp/vvoc-contracts-data-${process.pid}`;
  rmSync(process.env.XDG_CONFIG_HOME, { recursive: true, force: true });
  rmSync(process.env.XDG_DATA_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  rmSync(`/tmp/vvoc-contracts-config-${process.pid}`, { recursive: true, force: true });
  rmSync(`/tmp/vvoc-contracts-data-${process.pid}`, { recursive: true, force: true });
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousConfigHome;
  if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousDataHome;
  for (const id of usedSessions) {
    const dir = getWorkflowSessionDir(id);
    if (dir.startsWith("/tmp/")) rmSync(dir, { recursive: true, force: true });
  }
  usedSessions.clear();
});

// START_BLOCK_HOOK_HANDLER_AGREEMENT
describe("registered hook and handler diagnostics agree", () => {
  test("structural rejection carries the same code, category, and issues on both paths", async () => {
    const { plugin } = await createContractsHarness();
    const sessionID = sessionId("agreement");
    const invalidArgs = { items: [{ key: "k", title: "T" }] };

    const hookError = await catchHookError(plugin, "work_item_open", invalidArgs, sessionID);
    expect(hookError).toBeInstanceOf(ContractInputError);
    const inputError = hookError as ContractInputError;
    expect(inputError.category).toBe("input");
    expect(inputError.issues.some((issue) => issue.path === "items[0].mode")).toBe(true);

    const direct = parseToolJson<{
      errorCode: string;
      category: string;
      message: string;
      issues: Array<{ path: string }>;
    }>(
      await plugin.tool?.work_item_open?.execute(
        invalidArgs as never,
        createToolContext(sessionID) as never,
      ),
    );
    expect(direct.errorCode).toBe("INVALID_INPUT");
    expect(direct.category).toBe("input");
    expect(direct.issues.some((issue) => issue.path === "items[0].mode")).toBe(true);
    // The early thrown diagnostic and the direct handler response share the
    // bounded explanation instead of discarding the tokenized path into prose.
    expect(direct.message).toBe(inputError.message);
  });

  test("branch rejection for a misspelled reserved stop keeps the indexed path", async () => {
    const { plugin } = await createContractsHarness();
    const sessionID = sessionId("reserved-stop");
    const branch = await catchHookError(
      plugin,
      "work_checkpoint",
      {
        action: "authorize",
        runId: "run-1",
        authorityId: "auth-1",
        messageId: "msg-1",
        stages: ["implementation"],
        reservedStops: ["verificaton"],
      },
      sessionID,
    );
    expect(branch).toBeInstanceOf(ContractInputError);
    expect(String((branch as Error).message)).toContain("reservedStops[0]");
  });
});
// END_BLOCK_HOOK_HANDLER_AGREEMENT

// START_BLOCK_CONTEXT_SEPARATION
describe("caller input, host context, and foreign-session separation", () => {
  test("an invalid execution source is caller input and never mentions missing host context", async () => {
    const { plugin } = await createContractsHarness();
    const sessionID = sessionId("source-input");
    const parsed = parseToolJson<{ errorCode: string; category: string; message: string }>(
      await plugin.tool?.work_item_open?.execute(
        {
          items: [
            {
              key: "g",
              title: "G",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/lib/a.ts"],
            },
          ],
          execution: {
            executionKey: "run-1",
            source: { kind: "conversation" },
            goal: "Deliver.",
            boundary: { files: ["src/lib/a.ts"], directories: [] },
          },
        } as never,
        createToolContext(sessionID) as never,
      ),
    );
    expect(parsed.errorCode).toBe("INVALID_INPUT");
    expect(parsed.category).toBe("input");
    expect(parsed.message).not.toContain("workspace root");
  });

  test("missing trusted workspace context is host context, not caller input", async () => {
    const store = createWorkItemStore();
    const openTool = createWorkItemOpenTool(store);
    const result = openTool.execute(
      {
        items: [
          {
            key: "g",
            title: "G",
            mode: "delegated",
            requiredReviewers: [],
            writeScope: ["src/lib/a.ts"],
          },
        ],
        execution: {
          executionKey: "run-1",
          source: { kind: "conversation-scoped" },
          goal: "Deliver.",
          boundary: { files: ["src/lib/a.ts"], directories: [] },
        },
      },
      { sessionId: sessionId("host-context") },
    ) as Record<string, unknown>;
    expect(result.errorCode).toBe("HOST_CONTEXT_UNAVAILABLE");
    expect(result.category).toBe("host_context");
    expect(store.getStoreData().executions.size).toBe(0);
  });

  test("a run owned by another session is not disclosed and reports a lookup failure", async () => {
    const { plugin } = await createContractsHarness();
    const owner = sessionId("owner");
    const foreign = sessionId("foreign");
    const registered = parseToolJson<{ runId: string }>(
      await plugin.tool?.work_item_open?.execute(
        {
          items: [
            {
              key: "g",
              title: "G",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/lib/a.ts"],
            },
          ],
          execution: {
            executionKey: "run-foreign",
            source: { kind: "conversation-scoped" },
            goal: "Deliver.",
            boundary: { files: ["src/lib/a.ts"], directories: [] },
          },
        } as never,
        createToolContext(owner) as never,
      ),
    );
    const foreignResult = parseToolJson<{ ok: boolean; errorCode: string; message: string }>(
      await plugin.tool?.work_checkpoint?.execute(
        {
          action: "start",
          runId: registered.runId,
          checkpointId: "C-1",
        } as never,
        createToolContext(foreign) as never,
      ),
    );
    expect(foreignResult.ok).toBe(false);
    // Per-session stores make the foreign run an owned-lookup failure, never a
    // missing native-only argument and never a source disclosure.
    expect(foreignResult.errorCode).toBe("RUN_NOT_FOUND");
    expect(foreignResult.message).not.toContain("conversation-scoped");
    expect(foreignResult.message).not.toContain("native-package");
    // An unknown run is a lookup failure, never a missing native-only argument.
    expect(foreignResult.message).not.toContain("start and verify require runId and checkpointId");
  });
});
// END_BLOCK_CONTEXT_SEPARATION

// START_BLOCK_BOUNDED_WIRE_FAILURES
describe("oversized caller-controlled error data is bounded on the wire", () => {
  test("a huge unknown run id stays bounded with its code prefix intact", async () => {
    const { plugin } = await createContractsHarness();
    const sessionID = sessionId("bounded-run");
    const hugeRunId = "r".repeat(100_000);
    const parsed = parseToolJson<{ errorCode: string; category: string; message: string }>(
      await plugin.tool?.work_checkpoint?.execute(
        { action: "start", runId: hugeRunId, checkpointId: "C-1" } as never,
        createToolContext(sessionID) as never,
      ),
    );
    expect(parsed.errorCode).toBe("RUN_NOT_FOUND");
    expect(parsed.category).toBe("state");
    expect(parsed.message.length).toBeLessThanOrEqual(MAX_FAILURE_MESSAGE_CHARS);
    expect(parsed.message.startsWith("RUN_NOT_FOUND")).toBe(true);
  });
});
// END_BLOCK_BOUNDED_WIRE_FAILURES

// START_BLOCK_STAGED_ISOLATION
describe("staged persistence failure and producer validation", () => {
  test("a failed generic commit reports persistence and leaves live state unchanged", async () => {
    const { plugin } = await createContractsHarness();
    const sessionID = sessionId("persistence");
    const context = createToolContext(sessionID);
    const registered = parseToolJson<{ runId: string; ok: boolean }>(
      await plugin.tool?.work_item_open?.execute(
        {
          items: [
            {
              key: "g",
              title: "G",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/lib/a.ts"],
            },
          ],
          execution: {
            executionKey: "run-persist",
            source: { kind: "conversation-scoped" },
            goal: "Deliver.",
            boundary: { files: ["src/lib/a.ts"], directories: [] },
          },
        } as never,
        context as never,
      ),
    );
    expect(validateWorkflowToolResult("work_item_open", registered).ok).toBe(true);
    expect(registered.ok).toBe(true);

    // Force the checked snapshot write to fail by occupying the state path.
    const statePath = join(getWorkflowSessionDir(sessionID), "workflow-state.json");
    rmSync(statePath, { recursive: true, force: true });
    mkdirSync(statePath, { recursive: true });

    const failed = parseToolJson<{ ok: boolean; errorCode: string; category: string }>(
      await plugin.tool?.work_item_open?.execute(
        {
          items: [
            {
              key: "g2",
              title: "G2",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/lib/a.ts"],
            },
          ],
          runId: registered.runId,
          amendmentId: "amend-fail",
          rationale: "Must not persist.",
        } as never,
        context as never,
      ),
    );
    expect(failed.ok).toBe(false);
    expect(failed.errorCode).toBe("PERSISTENCE_FAILED");
    expect(failed.category).toBe("persistence");

    // The failed append never published: the live execution keeps revision 1.
    rmSync(statePath, { recursive: true, force: true });
    const listed = parseToolJson<{
      items: Array<{ workItemId: string }>;
    }>(
      await plugin.tool?.work_item_list?.execute(
        { includeClosed: false } as never,
        context as never,
      ),
    );
    expect(validateWorkflowToolResult("work_item_list", listed).ok).toBe(true);
    expect(listed.items).toHaveLength(1);
  });

  test("committed generic outputs validate against their closed schemas", async () => {
    const { plugin } = await createContractsHarness();
    const sessionID = sessionId("producer");
    const context = createToolContext(sessionID);
    const registered = parseToolJson<Record<string, unknown>>(
      await plugin.tool?.work_item_open?.execute(
        {
          items: [
            {
              key: "g",
              title: "G",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/lib/a.ts"],
            },
          ],
          execution: {
            executionKey: "run-producer",
            source: { kind: "conversation-scoped" },
            goal: "Deliver.",
            boundary: { files: ["src/lib/a.ts"], directories: [] },
          },
        } as never,
        context as never,
      ),
    );
    expect(validateWorkflowToolResult("work_item_open", registered).ok).toBe(true);
    const runId = registered.runId as string;

    const amended = parseToolJson<Record<string, unknown>>(
      await plugin.tool?.work_item_open?.execute(
        {
          items: [
            {
              key: "g2",
              title: "G2",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/lib/a.ts"],
            },
          ],
          runId,
          amendmentId: "amend-ok",
          rationale: "Append.",
        } as never,
        context as never,
      ),
    );
    expect(validateWorkflowToolResult("work_item_open", amended).ok).toBe(true);
    expect(amended.action).toBe("amend");
  });
});
// END_BLOCK_STAGED_ISOLATION

// START_BLOCK_OWNED_GUARD
describe("owned staged guard is fail-closed without an observed mutation", () => {
  const client = { app: { log: async () => undefined } };

  function makeSupport(sessionID: string) {
    const stores = new Map([[sessionID, createWorkItemStore()]]);
    const support = createRecoverySupport({
      client: client as never,
      stores,
      invalidHydrationSessions: new Set<string>(),
    });
    return { support, store: stores.get(sessionID)! };
  }

  test("a malformed success missing its tool identity is rejected without persisting", async () => {
    const sessionID = sessionId("guard-missing-tool");
    const { support, store } = makeSupport(sessionID);
    const before = store.getStoreData().records.size;
    const result = await support.commitGenericToolResult(sessionID, "work_item_open", () => ({
      ok: true,
      action: "register",
      runId: "run-x",
    }));
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("RESULT_CONTRACT_INVALID");
    expect(result.category).toBe("internal");
    expect(result.outcome).toBe("not_applied");
    expect(result.applied).toBe(false);
    expect(store.getStoreData().records.size).toBe(before);
  });

  test("a success tagged for another owned tool is rejected", async () => {
    const sessionID = sessionId("guard-wrong-tool");
    const { support, store } = makeSupport(sessionID);
    const result = await support.commitGenericToolResult(sessionID, "work_item_open", () => ({
      tool: "work_item_list",
      sessionId: sessionID,
      ok: true,
      includeClosed: false,
      items: [],
    }));
    expect(result.errorCode).toBe("RESULT_CONTRACT_INVALID");
    expect(result.outcome).toBe("not_applied");
    expect(store.getStoreData().executions.size).toBe(0);
  });

  test("a malformed nested success is rejected", async () => {
    const sessionID = sessionId("guard-malformed");
    const { support, store } = makeSupport(sessionID);
    const result = await support.commitGenericToolResult(sessionID, "work_item_open", () => ({
      tool: "work_item_open",
      sessionId: sessionID,
      ok: true,
      action: "register",
      runId: "run-x",
      reused: false,
      execution: { runId: "run-x" },
    }));
    expect(result.errorCode).toBe("RESULT_CONTRACT_INVALID");
    expect(store.getStoreData().executions.size).toBe(0);
  });

  test("a thrown guard failure is caught and reported as internal not_applied", async () => {
    const sessionID = sessionId("guard-throw");
    const { support, store } = makeSupport(sessionID);
    const result = await support.commitGenericToolResult(sessionID, "work_item_open", () => {
      const boom: Record<string, unknown> = { ok: true, action: "register", runId: "run-x" };
      Object.defineProperty(boom, "tool", {
        get() {
          throw new Error("injected identity failure");
        },
      });
      return boom;
    });
    expect(result.errorCode).toBe("RESULT_CONTRACT_INVALID");
    expect(result.outcome).toBe("not_applied");
    expect(store.getStoreData().executions.size).toBe(0);
  });
});
// END_BLOCK_OWNED_GUARD

// START_BLOCK_SERIALIZER_OUTCOME
describe("post-side-effect serialization failure is truthful", () => {
  test("a real committed mutation reports committed, never INVALID_INPUT", async () => {
    const { plugin } = await createContractsHarness();
    const sessionID = sessionId("serialize-committed");
    const context = createToolContext(sessionID);
    const registered = parseToolJson<{ runId: string }>(
      await plugin.tool?.work_item_open?.execute(
        {
          items: [
            {
              key: "g",
              title: "G",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/lib/a.ts"],
            },
          ],
          execution: {
            executionKey: "run-serialize",
            source: { kind: "conversation-scoped" },
            goal: "Deliver.",
            boundary: { files: ["src/lib/a.ts"], directories: [] },
          },
        } as never,
        context as never,
      ),
    );
    const amendArgs = {
      items: [
        {
          key: "g2",
          title: "G2",
          mode: "delegated",
          requiredReviewers: [],
          writeScope: ["src/lib/a.ts"],
        },
      ],
      runId: registered.runId,
      amendmentId: "amend-serialize",
      rationale: "Report after commit.",
    };

    // Induce a reporting failure through the production serializer seam while
    // the registered mutation actually commits.
    const realStringify = JSON.stringify;
    JSON.stringify = function (value: unknown, replacer?: unknown, space?: unknown): string {
      const candidate = value as { tool?: unknown; action?: unknown } | undefined;
      if (
        space === 2 &&
        candidate &&
        typeof candidate === "object" &&
        candidate.tool === "work_item_open" &&
        candidate.action === "amend"
      ) {
        throw new Error("injected reporting failure");
      }
      return realStringify(value, replacer as never, space as never);
    } as typeof JSON.stringify;

    let raw: unknown;
    try {
      raw = await plugin.tool?.work_item_open?.execute(amendArgs as never, context as never);
    } finally {
      JSON.stringify = realStringify;
    }
    const parsed = parseToolJson<{
      errorCode: string;
      category: string;
      outcome: string;
      applied?: boolean;
      retrySafe?: boolean;
      nextAction?: string;
    }>(raw);
    expect(parsed.errorCode).toBe("RESULT_SERIALIZATION_FAILED");
    expect(parsed.category).toBe("internal");
    expect(parsed.outcome).toBe("committed");
    expect(parsed.applied).toBe(true);
    expect(parsed.retrySafe).toBe(false);
    expect(parsed.errorCode).not.toBe("INVALID_INPUT");
    expect(String(parsed.nextAction)).toContain("inspect");

    // The mutation really committed before the reporting failure: persisted
    // state advanced to revision 2 even though the response could not render.
    const hydrated = hydrateWorkflowStateChecked(sessionID);
    expect(hydrated.status).toBe("valid");
    if (hydrated.status !== "valid") return;
    expect(hydrated.data.executions.get(registered.runId)?.revision).toBe(2);
  });
});
// END_BLOCK_SERIALIZER_OUTCOME

// START_BLOCK_CONTROL_DENIAL
describe("control denial diagnostics", () => {
  test("a failing SDK root/session lookup is host_context, not authorization", async () => {
    const { plugin, sessionGetFails } = await createContractsHarness();
    const sessionID = sessionId("host-lookup");
    sessionGetFails.value = true;
    let thrown: unknown;
    try {
      await plugin.tool?.work_item_decide?.execute(
        {
          workItemId: "wi-1",
          attempt: 1,
          decision: "accept",
          rationale: "Verified.",
          evidence: ["bun test"],
        } as never,
        createToolContext(sessionID) as never,
      );
    } catch (error) {
      thrown = error;
    }
    expect((thrown as { code?: string }).code).toBe("HOST_CONTEXT_UNAVAILABLE");
    expect((thrown as { category?: string }).category).toBe("host_context");
    expect(String(thrown)).toContain("could not be verified");
  });

  test("a child-session control mutation throws an authorization-categorized diagnostic", async () => {
    const { plugin, parentBySession } = await createContractsHarness();
    const sessionID = sessionId("child");
    parentBySession.set(sessionID, "parent-session");
    let thrown: unknown;
    try {
      await plugin.tool?.work_item_decide?.execute(
        {
          workItemId: "wi-1",
          attempt: 1,
          decision: "accept",
          rationale: "Verified.",
          evidence: ["bun test"],
        } as never,
        createToolContext(sessionID) as never,
      );
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toContain("CONTROL_DENIED");
    expect((thrown as { code?: string }).code).toBe("CONTROL_DENIED");
    expect((thrown as { category?: string }).category).toBe("authorization");
  });
});
// END_BLOCK_CONTROL_DENIAL

// START_BLOCK_REGISTERED_INSPECTION
// The registered work_item_list tool keeps returning the additive same-session
// inspection payload (items, generic executions, loaded contract identity) and
// never mutates the store on read.
describe("registered work_item_list inspection", () => {
  test("returns additive execution views and loaded identity without mutating state", async () => {
    const { plugin } = await createContractsHarness();
    const sessionID = sessionId("registered-inspection");
    const context = createToolContext(sessionID);
    const registered = parseToolJson<Record<string, unknown>>(
      await plugin.tool?.work_item_open?.execute(
        {
          items: [
            {
              key: "inspected",
              title: "Inspected",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/lib/a.ts"],
              taskId: "T-100",
            },
          ],
          execution: {
            executionKey: "inspection-run",
            source: { kind: "conversation-scoped" },
            goal: "Deliver.",
            boundary: { files: ["src/lib/a.ts"], directories: [] },
          },
        } as never,
        context as never,
      ),
    );
    expect(registered.ok).toBe(true);

    const first = parseToolJson<{
      items: Array<{ workItemId: string }>;
      executions?: Array<{ runId: string; sourceKind: string; tasks: Array<{ status: string }> }>;
      contract: { packageVersion: string; toolContractRevision: string; referencePath: string };
    }>(
      await plugin.tool?.work_item_list?.execute(
        { includeClosed: false } as never,
        context as never,
      ),
    );
    expect(validateWorkflowToolResult("work_item_list", first).ok).toBe(true);
    expect(first.contract.toolContractRevision).toBe("1");
    expect(first.contract.referencePath.endsWith("tool-contracts.md")).toBe(true);
    expect(first.executions).toHaveLength(1);
    expect(first.executions![0]!.sourceKind).toBe("conversation-scoped");

    const second = parseToolJson<Record<string, unknown>>(
      await plugin.tool?.work_item_list?.execute(
        { includeClosed: false } as never,
        context as never,
      ),
    );
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test("a dependency-blocked task reports launch_blocked in the list and the close failure", async () => {
    const { plugin } = await createContractsHarness();
    const sessionID = sessionId("registered-guidance-agree");
    const context = createToolContext(sessionID);
    const registered = parseToolJson<{
      ok: boolean;
      execution: { tasks: Array<{ taskId: string; workItemId: string }> };
    }>(
      await plugin.tool?.work_item_open?.execute(
        {
          items: [
            {
              key: "a",
              title: "A",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/lib/a.ts"],
              taskId: "T-100",
            },
            {
              key: "b",
              title: "B",
              mode: "delegated",
              requiredReviewers: [],
              writeScope: ["src/lib/b.ts"],
              taskId: "T-200",
              dependsOn: ["T-100"],
            },
          ],
          execution: {
            executionKey: "registered-guidance-agree",
            source: { kind: "conversation-scoped" },
            goal: "Deliver.",
            boundary: { files: ["src/lib/a.ts", "src/lib/b.ts"], directories: [] },
          },
        } as never,
        context as never,
      ),
    );
    expect(registered.ok).toBe(true);
    const blockedWorkItemId = registered.execution.tasks.find(
      (task) => task.taskId === "T-200",
    )!.workItemId;

    const listed = parseToolJson<{
      items: Array<{
        workItemId: string;
        delegated?: { nextAction: string; guidance?: { blockers: string[] } };
      }>;
    }>(
      await plugin.tool?.work_item_list?.execute(
        { includeClosed: false } as never,
        context as never,
      ),
    );
    const listedItem = listed.items.find((entry) => entry.workItemId === blockedWorkItemId)!;
    expect(listedItem.delegated?.nextAction).toBe("launch_blocked");
    expect(listedItem.delegated?.guidance?.blockers).toContain("DEPENDENCIES_UNMET:T-200");

    const failure = parseToolJson<{ ok: boolean; errorCode: string; nextAction?: string }>(
      await plugin.tool?.work_item_close?.execute(
        { workItemId: blockedWorkItemId } as never,
        context as never,
      ),
    );
    expect(failure.ok).toBe(false);
    expect(failure.errorCode).toBe("READY_TO_CLOSE_REQUIRED");
    expect(failure.nextAction).toBe("launch_blocked");
    expect(failure.nextAction).toBe(listedItem.delegated?.nextAction);
  });
});
// END_BLOCK_REGISTERED_INSPECTION
