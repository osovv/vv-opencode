// FILE: src/tui/context/analyze.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify measured context usage, compaction cutoff, percentages, detailed tool/MCP attribution, reconciliation, and drift reporting.
//   SCOPE: Pure deterministic analyzer and attribution-helper scenarios without a running OpenCode TUI.
//   DEPENDS: [bun:test, @opencode-ai/sdk/v2, src/tui/context/analyze.ts]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   context analyzer tests - Exercise provider baseline, metric helpers, and observable category/detail accounting.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-CONTEXT-TUI-DETAILED-ATTRIBUTION - Added deterministic metric, source-classification, and sorting coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2";
import {
  analyzeContext,
  classifyToolSource,
  compareToolUsage,
  createTokenMetric,
  sanitizeMcpName,
  selectActiveMessages,
} from "./analyze.js";
import type { ContextToolUsage } from "./types.js";

describe("context analysis", () => {
  test("derives metric percentages only from a positive finite context limit", () => {
    expect(createTokenMetric(250, 1_000)).toEqual({ estimatedTokens: 250, percent: 25 });
    for (const contextLimit of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(createTokenMetric(250, contextLimit)).toEqual({ estimatedTokens: 250 });
    }
  });

  test("sanitizes MCP names and classifies unique longest prefixes without guessing collisions", () => {
    expect(sanitizeMcpName("docs.api/v1-beta")).toBe("docs_api_v1-beta");
    expect(classifyToolSource("read", [])).toEqual({ source: { kind: "builtin" } });
    expect(classifyToolSource("edit", [])).toEqual({ source: { kind: "vvoc" } });
    expect(
      classifyToolSource("docs_api_lookup", [
        { name: "docs", status: "connected" },
        { name: "docs api", status: "connected" },
      ]),
    ).toEqual({ source: { kind: "mcp", server: "docs api" } });
    expect(
      classifyToolSource("docs_api_lookup", [
        { name: "docs api", status: "connected" },
        { name: "docs.api", status: "disabled" },
      ]),
    ).toEqual({
      source: { kind: "other" },
      ambiguousServers: ["docs api", "docs.api"],
    });
    expect(classifyToolSource("remote_search", [])).toEqual({ source: { kind: "other" } });
  });

  test("sorts tool detail by combined total descending with a stable ID tie-breaker", () => {
    const tools = [toolUsage("zeta", 20), toolUsage("small", 5), toolUsage("alpha", 20)];
    expect(tools.sort(compareToolUsage).map((tool) => tool.id)).toEqual(["alpha", "zeta", "small"]);
  });

  test("uses latest provider input, cache read, and output as the measured baseline", () => {
    const messages = [
      userMessage("u1"),
      assistantMessage("a1", "u1", { input: 1_000, cacheRead: 200, output: 100 }),
    ];
    const analysis = analyzeContext({
      sessionID: "session-1",
      messages,
      parts: [textPart("u1", "hello"), textPart("a1", "world")],
      agents: [],
      skills: [],
      tools: [],
      mcpServers: [],
      model: { providerID: "openai", modelID: "gpt", contextLimit: 2_000 },
    });

    expect(analysis.measured?.usedTokens).toBe(1_300);
    expect(analysis.measured?.remainingTokens).toBe(700);
    expect(analysis.measured?.percentUsed).toBe(65);
    expect(
      analysis.categories.find((category) => category.id === "provider-only")?.estimatedTokens,
    ).toBeGreaterThan(0);
  });

  test("starts active context at the latest compaction summary", () => {
    const oldUser = userMessage("u-old");
    const oldAssistant = assistantMessage("a-old", "u-old");
    const summary = assistantMessage("a-summary", "u-old", {}, true);
    const newUser = userMessage("u-new");
    const latest = assistantMessage("a-new", "u-new");
    const messages = [oldUser, oldAssistant, summary, newUser, latest];

    expect(selectActiveMessages(messages).map((message) => message.id)).toEqual([
      "a-summary",
      "u-new",
      "a-new",
    ]);

    const analysis = analyzeContext({
      sessionID: "session-1",
      messages,
      parts: [
        textPart("u-old", "old content ".repeat(100)),
        textPart("a-summary", "compact summary"),
        textPart("u-new", "new question"),
        textPart("a-new", "new answer"),
      ],
      agents: [],
      skills: [],
      tools: [],
      mcpServers: [],
    });

    expect(analysis.compacted).toBe(true);
    expect(analysis.activeMessageCount).toBe(3);
    expect(
      analysis.categories.find((category) => category.id === "compacted-summary")?.estimatedTokens,
    ).toBeGreaterThan(0);
  });

  test("estimates system instructions and both sides of the visible conversation", () => {
    const user = { ...userMessage("u1"), system: "Follow the repository contract" };
    const assistant = assistantMessage("a1", "u1");
    const analysis = analyzeContext({
      sessionID: "session-1",
      messages: [user, assistant],
      parts: [textPart("u1", "user question"), textPart("a1", "assistant answer")],
      agents: [
        {
          name: "vv-controller",
          mode: "primary",
          permission: [],
          prompt: "You are the controller",
          options: {},
        },
      ],
      skills: [],
      tools: [],
      mcpServers: [],
    });

    for (const id of ["system", "user-messages", "assistant-messages"] as const) {
      expect(
        analysis.categories.find((category) => category.id === id)?.estimatedTokens,
      ).toBeGreaterThan(0);
    }
  });

  test("groups skills, vvoc tools, built-ins, external schemas, tool output, files, and MCP status", () => {
    const messages = [userMessage("u1"), assistantMessage("a1", "u1")];
    const parts: Part[] = [
      textPart("u1", "inspect"),
      filePart("u1", "src/app.ts", "export const app = true"),
      skillToolPart("a1"),
    ];
    const analysis = analyzeContext({
      sessionID: "session-1",
      messages,
      parts,
      agents: [],
      skills: [
        {
          name: "frontend-design",
          description: "Build polished interfaces",
          location: "/skills/frontend-design/SKILL.md",
          content: "full content is loaded only on demand",
        },
      ],
      tools: [
        { id: "read", description: "Read files", parameters: { type: "object" } },
        { id: "edit", description: "Edit with anchors", parameters: { type: "object" } },
        { id: "remote_search", description: "External search", parameters: { type: "object" } },
      ],
      mcpServers: [{ name: "docs", status: "connected" }],
    });

    for (const id of [
      "skill-catalog",
      "loaded-skills",
      "builtin-tool-schemas",
      "vvoc-tool-schemas",
      "external-tool-schemas",
      "files",
    ]) {
      expect(
        analysis.categories.find((category) => category.id === id)?.estimatedTokens,
      ).toBeGreaterThan(0);
    }
    expect(analysis.mcpServers).toEqual([{ name: "docs", status: "connected" }]);
  });

  test("aggregates current schemas and active tool history into reconciled tool and MCP detail", () => {
    const messages = [userMessage("u1"), assistantMessage("a1", "u1")];
    const attachment = filePart("a1", "result.txt", "attachment payload");
    const analysis = analyzeContext({
      sessionID: "session-1",
      messages,
      parts: [
        pendingToolPart("a1", "read", "read-1", { filePath: "draft.ts" }),
        completedToolPart("a1", "read", "read-1", { filePath: "final.ts" }, "final content", [
          attachment,
        ]),
        errorToolPart("a1", "read", "read-2", { filePath: "missing.ts" }, "not found"),
        pendingToolPart("a1", "read", "read-3", { filePath: "pending.ts" }),
        runningToolPart("a1", "read", "read-4", { filePath: "running.ts" }),
        completedToolPart("a1", "skill", "skill-1", { name: "frontend-design" }, "loaded"),
        completedToolPart("a1", "docs_search", "docs-1", { query: "api" }, "docs result"),
        completedToolPart("a1", "offline_fetch", "offline-1", { url: "/old" }, "cached result"),
      ],
      agents: [],
      skills: [],
      tools: [
        { id: "read", description: "Read files", parameters: { type: "object" } },
        { id: "skill", description: "Load skills", parameters: { type: "object" } },
        { id: "unused", description: "Unused plugin", parameters: { type: "object" } },
        { id: "docs_search", description: "Search docs", parameters: { type: "object" } },
        { id: "offline_fetch", description: "Fetch offline", parameters: { type: "object" } },
      ],
      mcpServers: [
        { name: "docs", status: "connected" },
        { name: "offline", status: "disabled" },
      ],
      model: { providerID: "openai", modelID: "gpt", contextLimit: 10_000 },
    });

    const attribution = analysis.toolAttribution!;
    const read = attribution.tools.find((tool) => tool.id === "read")!;
    const skill = attribution.tools.find((tool) => tool.id === "skill")!;
    const unused = attribution.tools.find((tool) => tool.id === "unused")!;
    const docs = attribution.mcpServers.find((server) => server.name === "docs")!;
    const offline = attribution.mcpServers.find((server) => server.name === "offline")!;

    expect(read.calls).toBe(4);
    expect(read.history.estimatedTokens).toBeGreaterThan(0);
    expect(read.total.estimatedTokens).toBe(
      read.schema.estimatedTokens + read.history.estimatedTokens,
    );
    expect(read.total.percent).toBeCloseTo((read.total.estimatedTokens / 10_000) * 100);
    expect(unused).toMatchObject({ calls: 0, history: { estimatedTokens: 0 } });
    expect(unused.schema.estimatedTokens).toBeGreaterThan(0);
    expect(skill.history.estimatedTokens).toBeGreaterThan(0);
    expect(docs.toolCount).toBe(1);
    expect(docs.schema.estimatedTokens).toBeGreaterThan(0);
    expect(docs.history.estimatedTokens).toBeGreaterThan(0);
    expect(offline.toolCount).toBe(0);
    expect(offline.schema.estimatedTokens).toBe(0);
    expect(offline.history.estimatedTokens).toBeGreaterThan(0);
    expect(offline.tools[0]?.schema.estimatedTokens).toBe(0);
    expect(attribution.otherTools.map((tool) => tool.id)).toContain("unused");

    expect(categoryTokens(analysis, "builtin-tool-schemas")).toBe(
      attribution.reconciliation.schema.builtin.estimatedTokens,
    );
    expect(categoryTokens(analysis, "external-tool-schemas")).toBe(
      attribution.reconciliation.schema.external.estimatedTokens,
    );
    expect(categoryTokens(analysis, "tool-results")).toBe(
      attribution.reconciliation.history.toolResults.estimatedTokens,
    );
    expect(categoryTokens(analysis, "loaded-skills")).toBe(
      attribution.reconciliation.history.loadedSkills.estimatedTokens,
    );
    expect(attribution.reconciliation.history.total.estimatedTokens).toBe(
      attribution.reconciliation.history.toolResults.estimatedTokens +
        attribution.reconciliation.history.loadedSkills.estimatedTokens,
    );
    expect(attribution.tools.reduce((total, tool) => total + tool.history.estimatedTokens, 0)).toBe(
      attribution.reconciliation.history.total.estimatedTokens,
    );
    expect(
      categoryTokens(analysis, "tool-results") + categoryTokens(analysis, "loaded-skills"),
    ).toBe(attribution.reconciliation.history.total.estimatedTokens);
    expect(
      analysis.categories.find((category) => category.id === "builtin-tool-schemas")?.percent,
    ).toBeCloseTo((categoryTokens(analysis, "builtin-tool-schemas") / 10_000) * 100);
    expect(categoryTokens(analysis, "files")).toBeGreaterThan(0);
  });

  test("leaves overview and detailed percentages undefined without a positive model limit", () => {
    const input = {
      sessionID: "session-1",
      messages: [userMessage("u1"), assistantMessage("a1", "u1")],
      parts: [completedToolPart("a1", "read", "read-1", { filePath: "a.ts" }, "content")],
      agents: [],
      skills: [],
      tools: [{ id: "read", description: "Read files", parameters: { type: "object" } }],
      mcpServers: [],
    } as const;

    for (const contextLimit of [undefined, 0, -1]) {
      const analysis = analyzeContext({
        ...input,
        model: { providerID: "openai", modelID: "gpt", contextLimit },
      });
      expect(analysis.categories.every((category) => category.percent === undefined)).toBe(true);
      expect(analysis.toolAttribution?.tools[0]?.schema.percent).toBeUndefined();
      expect(analysis.toolAttribution?.tools[0]?.history.percent).toBeUndefined();
      expect(analysis.toolAttribution?.tools[0]?.total.percent).toBeUndefined();
    }
  });

  test("excludes pre-compaction calls while retaining post-compaction calls and current schemas", () => {
    const oldUser = userMessage("u-old");
    const oldAssistant = assistantMessage("a-old", "u-old");
    const summary = assistantMessage("a-summary", "u-old", {}, true);
    const newUser = userMessage("u-new");
    const latest = assistantMessage("a-new", "u-new");
    const currentCall = completedToolPart(
      "a-new",
      "read",
      "new-call",
      { filePath: "new.ts" },
      "new",
    );
    const analysis = analyzeContext({
      sessionID: "session-1",
      messages: [oldUser, oldAssistant, summary, newUser, latest],
      parts: [
        completedToolPart("a-old", "read", "old-call", { filePath: "old.ts" }, "old ".repeat(100)),
        textPart("a-summary", "summary"),
        currentCall,
      ],
      agents: [],
      skills: [],
      tools: [{ id: "read", description: "Read files", parameters: { type: "object" } }],
      mcpServers: [],
    });
    const currentOnly = analyzeContext({
      sessionID: "session-1",
      messages: [summary, newUser, latest],
      parts: [textPart("a-summary", "summary"), currentCall],
      agents: [],
      skills: [],
      tools: [{ id: "read", description: "Read files", parameters: { type: "object" } }],
      mcpServers: [],
    });

    const read = analysis.toolAttribution?.tools.find((tool) => tool.id === "read");
    expect(read?.calls).toBe(1);
    expect(read?.schema.estimatedTokens).toBeGreaterThan(0);
    expect(read?.history.estimatedTokens).toBe(
      currentOnly.toolAttribution?.tools.find((tool) => tool.id === "read")?.history
        .estimatedTokens,
    );
  });

  test("retains active history but zeroes current schema for every disconnected MCP status", () => {
    const statuses = [
      { name: "disabled", status: "disabled" as const },
      { name: "failed", status: "failed" as const, error: "offline" },
      { name: "auth", status: "needs_auth" as const },
      {
        name: "register",
        status: "needs_client_registration" as const,
        error: "client id required",
      },
    ];
    const parts = statuses.map((server) =>
      completedToolPart(
        "a1",
        `${server.name}_run`,
        `${server.name}-call`,
        { value: 1 },
        "retained",
      ),
    );
    parts.push(completedToolPart("a1", "connected_run", "connected-call", { value: 1 }, "active"));
    const analysis = analyzeContext({
      sessionID: "session-1",
      messages: [userMessage("u1"), assistantMessage("a1", "u1")],
      parts,
      agents: [],
      skills: [],
      tools: [
        ...statuses.map((server) => ({
          id: `${server.name}_run`,
          description: "stale schema",
          parameters: { type: "object" },
        })),
        { id: "connected_run", description: "current schema", parameters: { type: "object" } },
      ],
      mcpServers: [
        { name: "connected", status: "connected" },
        ...statuses,
        { name: "alpha", status: "connected" },
        { name: "zeta", status: "connected" },
      ],
    });

    const servers = analysis.toolAttribution!.mcpServers;
    for (const status of statuses) {
      const server = servers.find((candidate) => candidate.name === status.name)!;
      expect(server.toolCount).toBe(0);
      expect(server.schema.estimatedTokens).toBe(0);
      expect(server.history.estimatedTokens).toBeGreaterThan(0);
      expect(server.tools[0]?.history.estimatedTokens).toBeGreaterThan(0);
    }
    const connected = servers.find((server) => server.name === "connected")!;
    expect(connected.toolCount).toBe(1);
    expect(connected.schema.estimatedTokens).toBeGreaterThan(0);
    expect(
      servers.filter((server) => server.total.estimatedTokens === 0).map((server) => server.name),
    ).toEqual(["alpha", "zeta"]);
  });

  test("uses longest MCP prefixes and bounds collision warnings while falling back to Other", () => {
    const ambiguousIDs = ["docs_api_alpha", "docs_api_bravo", "docs_api_charlie", "docs_api_delta"];
    const analysis = analyzeContext({
      sessionID: "session-1",
      messages: [userMessage("u1"), assistantMessage("a1", "u1")],
      parts: [completedToolPart("a1", "docs_api_lookup", "unique", {}, "result")],
      agents: [],
      skills: [],
      tools: [
        { id: "docs_api_lookup", description: "longest", parameters: { type: "object" } },
        ...ambiguousIDs.map((id) => ({
          id,
          description: "ambiguous",
          parameters: { type: "object" },
        })),
        { id: "plain_plugin", description: "other", parameters: { type: "object" } },
      ],
      mcpServers: [
        { name: "docs", status: "connected" },
        { name: "docs api", status: "connected" },
        { name: "docs.api", status: "connected" },
      ],
    });

    const tools = analysis.toolAttribution!.tools;
    expect(tools.find((tool) => tool.id === "docs_api_lookup")?.source).toEqual({ kind: "other" });
    expect(analysis.toolAttribution!.otherTools.map((tool) => tool.id)).toEqual(
      expect.arrayContaining([...ambiguousIDs, "docs_api_lookup", "plain_plugin"]),
    );
    expect(analysis.warnings).toHaveLength(3);
    expect(analysis.warnings.at(-1)).toContain("additional tool IDs");

    const unique = analyzeContext({
      sessionID: "session-1",
      messages: [userMessage("u1"), assistantMessage("a1", "u1")],
      parts: [],
      agents: [],
      skills: [],
      tools: [{ id: "docs_api_lookup", description: "longest", parameters: { type: "object" } }],
      mcpServers: [
        { name: "docs", status: "connected" },
        { name: "docs api", status: "connected" },
      ],
    });
    expect(unique.toolAttribution?.tools[0]?.source).toEqual({ kind: "mcp", server: "docs api" });
  });

  test("reports positive estimation drift instead of inventing a negative unknown category", () => {
    const messages = [userMessage("u1"), assistantMessage("a1", "u1", { input: 1, output: 1 })];
    const analysis = analyzeContext({
      sessionID: "session-1",
      messages,
      parts: [textPart("u1", "large visible prompt ".repeat(100))],
      agents: [],
      skills: [],
      tools: [],
      mcpServers: [],
    });

    expect(analysis.estimationDriftTokens).toBeGreaterThan(0);
    expect(analysis.categories.some((category) => category.id === "provider-only")).toBe(false);
  });
});

function toolUsage(id: string, total: number): ContextToolUsage {
  return {
    id,
    source: { kind: "other" },
    calls: 0,
    schema: { estimatedTokens: total },
    history: { estimatedTokens: 0 },
    total: { estimatedTokens: total },
  };
}

function categoryTokens(analysis: ReturnType<typeof analyzeContext>, id: string): number {
  return analysis.categories.find((category) => category.id === id)?.estimatedTokens ?? 0;
}

function userMessage(id: string): UserMessage {
  return {
    id,
    sessionID: "session-1",
    role: "user",
    time: { created: 1 },
    agent: "vv-controller",
    model: { providerID: "openai", modelID: "gpt" },
  };
}

function assistantMessage(
  id: string,
  parentID: string,
  tokens: { input?: number; cacheRead?: number; output?: number } = {},
  summary = false,
): AssistantMessage {
  return {
    id,
    sessionID: "session-1",
    role: "assistant",
    time: { created: 2, completed: 3 },
    parentID,
    modelID: "gpt",
    providerID: "openai",
    mode: "build",
    agent: "vv-controller",
    path: { cwd: "/tmp/project", root: "/tmp/project" },
    summary: summary || undefined,
    cost: 0,
    tokens: {
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      reasoning: 0,
      cache: { read: tokens.cacheRead ?? 0, write: 0 },
    },
  };
}

function textPart(messageID: string, text: string): Extract<Part, { type: "text" }> {
  return { id: `${messageID}-text`, sessionID: "session-1", messageID, type: "text", text };
}

function filePart(
  messageID: string,
  filename: string,
  value: string,
): Extract<Part, { type: "file" }> {
  return {
    id: `${messageID}-file`,
    sessionID: "session-1",
    messageID,
    type: "file",
    mime: "text/plain",
    filename,
    url: `file://${filename}`,
    source: { type: "file", path: filename, text: { value, start: 0, end: value.length } },
  };
}

function skillToolPart(messageID: string): Extract<Part, { type: "tool" }> {
  return {
    id: `${messageID}-skill`,
    sessionID: "session-1",
    messageID,
    type: "tool",
    callID: "call-1",
    tool: "skill",
    state: {
      status: "completed",
      input: { name: "frontend-design" },
      output: "Loaded skill instructions",
      title: "frontend-design",
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}

function pendingToolPart(
  messageID: string,
  tool: string,
  callID: string,
  input: Record<string, unknown>,
): Extract<Part, { type: "tool" }> {
  return {
    id: `${messageID}-${callID}-pending`,
    sessionID: "session-1",
    messageID,
    type: "tool",
    callID,
    tool,
    state: { status: "pending", input, raw: JSON.stringify(input) },
  };
}

function runningToolPart(
  messageID: string,
  tool: string,
  callID: string,
  input: Record<string, unknown>,
): Extract<Part, { type: "tool" }> {
  return {
    id: `${messageID}-${callID}-running`,
    sessionID: "session-1",
    messageID,
    type: "tool",
    callID,
    tool,
    state: { status: "running", input, title: tool, metadata: {}, time: { start: 1 } },
  };
}

function completedToolPart(
  messageID: string,
  tool: string,
  callID: string,
  input: Record<string, unknown>,
  output: string,
  attachments?: Array<Extract<Part, { type: "file" }>>,
): Extract<Part, { type: "tool" }> {
  return {
    id: `${messageID}-${callID}-completed`,
    sessionID: "session-1",
    messageID,
    type: "tool",
    callID,
    tool,
    state: {
      status: "completed",
      input,
      output,
      title: tool,
      metadata: {},
      time: { start: 1, end: 2 },
      attachments,
    },
  };
}

function errorToolPart(
  messageID: string,
  tool: string,
  callID: string,
  input: Record<string, unknown>,
  error: string,
): Extract<Part, { type: "tool" }> {
  return {
    id: `${messageID}-${callID}-error`,
    sessionID: "session-1",
    messageID,
    type: "tool",
    callID,
    tool,
    state: {
      status: "error",
      input,
      error,
      metadata: {},
      time: { start: 1, end: 2 },
    },
  };
}
