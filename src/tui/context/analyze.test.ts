// FILE: src/tui/context/analyze.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify measured context usage, compaction cutoff, category estimates, tool grouping, and drift reporting.
//   SCOPE: Pure deterministic analyzer scenarios without a running OpenCode TUI.
//   DEPENDS: [bun:test, @opencode-ai/sdk/v2, src/tui/context/analyze.ts]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   context analyzer tests - Exercise provider baseline and observable category accounting.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-CONTEXT-TUI-PLUGIN - Added deterministic context analysis regression coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2";
import { analyzeContext, selectActiveMessages } from "./analyze.js";

describe("context analysis", () => {
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
