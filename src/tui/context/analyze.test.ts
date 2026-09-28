// FILE: src/tui/context/analyze.test.ts
// VERSION: 2.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify native context analysis: context-occupancy usage with unknown-when-absent fields, variant-aware model matching, temporal compaction relation, separate catalog budget, non-guessing native tool ownership, and attachment/agent normalization effects.
//   SCOPE: Pure analyzer tests with native tagged message fixtures; no host or TUI renderer.
//   DEPENDS: [bun:test, src/tui/context/analyze.ts, src/tui/context/types.ts]
//   LINKS: [V-M-PLUGIN-CONTEXT-TUI, DF-CONTEXT-INSPECTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   LOCALS: assistantMessage, userMessage, toolRow, baseInput
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-008 attempt 2 - Added occupancy/total usage, absent-usage-unknown, variant mismatch, compaction relation, catalog-budget separation, and native built-in classification coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import {
  analyzeContext,
  classifyToolSource,
  compareToolUsage,
  createTokenMetric,
  findCompactionCutoff,
  sameModelRef,
} from "./analyze.js";
import { estimateTextTokens, estimateValueTokens } from "./estimate.js";
import type {
  ContextAnalysisInput,
  ContextContent,
  ContextMessage,
  ContextToolUsage,
} from "./types.js";
import type { ContextInspectionTool } from "../../runtime/context-inspection-contract.js";

function userMessage(id: string, text: string): ContextMessage {
  return { kind: "user", id, text, agent: "build" };
}

function assistantMessage(
  id: string,
  content: ContextContent[],
  overrides: Partial<Extract<ContextMessage, { kind: "assistant" }>> = {},
): ContextMessage {
  return {
    kind: "assistant",
    id,
    agent: "build",
    model: { providerID: "deepseek", modelID: "chat" },
    content,
    ...overrides,
  };
}

function toolRow(overrides: Partial<ContextInspectionTool> = {}): ContextInspectionTool {
  return {
    effectiveID: "read",
    name: "read",
    description: "Read a file",
    codeMode: false,
    status: "registered",
    inputJSONSchema: { type: "object", properties: { path: { type: "string" } } },
    ...overrides,
  };
}

function baseInput(overrides: Partial<ContextAnalysisInput> = {}): ContextAnalysisInput {
  return {
    sessionID: "ses_1",
    activeMessages: [],
    historyMessages: [],
    agents: [],
    skills: [],
    tools: [],
    toolCatalogStatus: "complete",
    mcpServers: [],
    ...overrides,
  };
}

describe("context analysis helpers", () => {
  test("derives metric percentages only from a positive finite context limit", () => {
    expect(createTokenMetric(100, 1000)).toEqual({ estimatedTokens: 100, percent: 10 });
    expect(createTokenMetric(100, undefined)).toEqual({ estimatedTokens: 100 });
    expect(createTokenMetric(100, 0)).toEqual({ estimatedTokens: 100 });
    expect(createTokenMetric(Number.NaN, 100)).toEqual({ estimatedTokens: 0, percent: 0 });
  });

  test("classifies native built-ins and vvoc tools and leaves unknown tools unattributed", () => {
    expect(classifyToolSource({ effectiveID: "shell", name: "shell" })).toEqual({
      kind: "builtin",
    });
    expect(classifyToolSource({ effectiveID: "subagent", name: "subagent" })).toEqual({
      kind: "builtin",
    });
    expect(classifyToolSource({ effectiveID: "websearch", name: "websearch" })).toEqual({
      kind: "builtin",
    });
    expect(classifyToolSource({ effectiveID: "web_fetch", name: "web_fetch" })).toEqual({
      kind: "vvoc",
    });
    expect(
      classifyToolSource({ effectiveID: "docs_search", name: "docs_search", namespace: "docs" }),
    ).toEqual({
      kind: "other",
      namespace: "docs",
    });
  });

  test("sorts tool detail by combined total descending with a stable ID tie-breaker", () => {
    const usage = (id: string, tokens: number): ContextToolUsage => ({
      id,
      source: { kind: "other" },
      codeMode: false,
      calls: 0,
      schemaKnown: true,
      schema: createTokenMetric(tokens, undefined),
      history: createTokenMetric(0, undefined),
      total: createTokenMetric(tokens, undefined),
    });
    const sorted = [usage("b", 10), usage("a", 10), usage("c", 5)].sort(compareToolUsage);
    expect(sorted.map((tool) => tool.id)).toEqual(["a", "b", "c"]);
  });

  test("compares models including variant", () => {
    expect(sameModelRef({ providerID: "p", modelID: "m" }, { providerID: "p", modelID: "m" })).toBe(
      true,
    );
    expect(
      sameModelRef(
        { providerID: "p", modelID: "m", variant: "fast" },
        { providerID: "p", modelID: "m" },
      ),
    ).toBe(false);
  });

  test("finds the latest completed compaction cutoff only", () => {
    const messages: ContextMessage[] = [
      { kind: "compaction", id: "c1", status: "completed", summary: "s", recent: "r" },
      userMessage("u1", "hi"),
      { kind: "compaction", id: "c2", status: "failed", summary: "s", recent: "r" },
    ];
    expect(findCompactionCutoff(messages)?.message.id).toBe("c1");
  });
});

describe("native context analysis", () => {
  test("measures the pinned native contextUsage sum of all five token fields", () => {
    // Exact controller counterexample: 100 input + 20 output + 30 reasoning +
    // 40 cache read + 50 cache write = 240 native total, remaining 760.
    const message = assistantMessage("a1", [{ type: "text", text: "hello" }], {
      tokens: { input: 100, output: 20, reasoning: 30, cacheRead: 40, cacheWrite: 50 },
    });
    const input = baseInput({
      activeMessages: [userMessage("u1", "prompt"), message],
      historyMessages: [userMessage("u1", "prompt"), message],
      selectedModel: { providerID: "deepseek", modelID: "chat", contextLimit: 1000 },
    });
    const analysis = analyzeContext(input);
    expect(analysis.measured?.usedTokens).toBe(240);
    expect(analysis.measured?.remainingTokens).toBe(760);
    expect(analysis.measured?.percentUsed).toBeCloseTo(24);
    expect(analysis.measured?.cacheWriteTokens).toBe(50);
    expect(analysis.measured?.outputTokens).toBe(20);
    expect(analysis.measured?.reasoningTokens).toBe(30);
    expect(analysis.measured?.matchesSelectedModel).toBe(true);
  });

  test("ignores a reported non-positive native total", () => {
    const message = assistantMessage("a1", [{ type: "text", text: "hello" }], {
      tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    });
    const analysis = analyzeContext(
      baseInput({
        activeMessages: [message],
        historyMessages: [message],
        selectedModel: { providerID: "deepseek", modelID: "chat", contextLimit: 1000 },
      }),
    );
    expect(analysis.measured).toBeUndefined();
  });

  test("keeps absent usage unknown instead of reporting zero", () => {
    const message = assistantMessage("a1", [{ type: "text", text: "hello" }]);
    const input = baseInput({
      activeMessages: [message],
      historyMessages: [message],
      selectedModel: { providerID: "deepseek", modelID: "chat", contextLimit: 1000 },
    });
    const analysis = analyzeContext(input);
    expect(analysis.measured).toBeUndefined();
  });

  test("keeps malformed/partial usage unknown field-by-field", () => {
    const message = assistantMessage("a1", [{ type: "text", text: "hello" }], {
      tokens: { output: 5 },
    });
    const input = baseInput({
      activeMessages: [message],
      historyMessages: [message],
      selectedModel: { providerID: "deepseek", modelID: "chat", contextLimit: 1000 },
    });
    const analysis = analyzeContext(input);
    expect(analysis.measured?.usedTokens).toBeUndefined();
    expect(analysis.measured?.outputTokens).toBe(5);
    expect(analysis.measured?.percentUsed).toBeUndefined();
  });

  test("rejects a different variant for the current-limit and occupancy claim", () => {
    const message = assistantMessage("a1", [{ type: "text", text: "hello" }], {
      model: { providerID: "deepseek", modelID: "chat", variant: "thinking" },
      tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    });
    const input = baseInput({
      activeMessages: [message],
      historyMessages: [message],
      selectedModel: {
        providerID: "deepseek",
        modelID: "chat",
        variant: "plain",
        contextLimit: 100,
      },
    });
    const analysis = analyzeContext(input);
    expect(analysis.measured?.matchesSelectedModel).toBe(false);
    expect(analysis.measured?.contextLimit).toBeUndefined();
    expect(analysis.measured?.percentUsed).toBeUndefined();
    expect(analysis.measured?.label).toContain("differs from the selected model");
  });

  test("distinguishes usage before and after the latest completed compaction", () => {
    const before = assistantMessage("a_before", [{ type: "text", text: "old" }], {
      tokens: { input: 999, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    const compaction: ContextMessage = {
      kind: "compaction",
      id: "c1",
      status: "completed",
      summary: "sum",
      recent: "rec",
      createdAt: 10,
    };
    const after = assistantMessage("a_after", [{ type: "text", text: "new" }], {
      tokens: { input: 5, output: 2, cacheRead: 1, cacheWrite: 1 },
      createdAt: 20,
    });
    const beforeInput = baseInput({
      activeMessages: [before, { ...compaction, createdAt: 30 }],
      historyMessages: [before, compaction],
      selectedModel: { providerID: "deepseek", modelID: "chat", contextLimit: 1000 },
    });
    expect(analyzeContext(beforeInput).measured?.compactionRelation).toBe("before");
    expect(analyzeContext(beforeInput).measured?.label).toContain(
      "before the most recent compaction",
    );

    const afterInput = baseInput({
      activeMessages: [compaction, after],
      historyMessages: [before, compaction, after],
      selectedModel: { providerID: "deepseek", modelID: "chat", contextLimit: 1000 },
    });
    expect(analyzeContext(afterInput).measured?.compactionRelation).toBe("after");
  });

  test("matches agent prompts by id, not display name", () => {
    const message = assistantMessage("a1", [{ type: "text", text: "hi" }]);
    const input = baseInput({
      activeMessages: [message],
      historyMessages: [message],
      agents: [{ id: "build", name: "Build", system: "system prompt" }],
    });
    const analysis = analyzeContext(input);
    const system = analysis.categories.find((category) => category.id === "system");
    expect(system?.estimatedTokens).toBe(estimateTextTokens("system prompt"));
  });

  test("counts native user attachments under files", () => {
    const input = baseInput({
      activeMessages: [
        {
          kind: "user",
          id: "u1",
          text: "see file",
          files: [
            {
              name: "a.png",
              mime: "image/png",
              sourceType: "uri",
              sourceURI: "https://x/a.png",
              byteLength: 100,
            },
          ],
        },
      ],
      historyMessages: [],
    });
    const analysis = analyzeContext(input);
    const files = analysis.categories.find((category) => category.id === "files");
    expect(files?.estimatedTokens).toBeGreaterThan(0);
  });

  test("keeps the registered catalog budget separate from observed context and provider residual", () => {
    const message = assistantMessage("a1", [{ type: "text", text: "short" }], {
      tokens: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    const withoutCatalog = analyzeContext(
      baseInput({
        activeMessages: [message],
        historyMessages: [message],
        selectedModel: { providerID: "deepseek", modelID: "chat", contextLimit: 1000 },
      }),
    );
    const withCatalog = analyzeContext(
      baseInput({
        activeMessages: [message],
        historyMessages: [message],
        selectedModel: { providerID: "deepseek", modelID: "chat", contextLimit: 1000 },
        tools: [
          toolRow({
            effectiveID: "huge",
            name: "huge",
            inputJSONSchema: {
              type: "object",
              properties: { blob: { type: "string", description: "y".repeat(4000) } },
            },
          }),
        ],
      }),
    );
    expect(withCatalog.estimatedKnownTokens).toBe(withoutCatalog.estimatedKnownTokens);
    expect(withCatalog.catalogSchemaBudget?.estimatedTokens).toBeGreaterThan(0);
    const residual = (analysis: typeof withoutCatalog) =>
      analysis.categories.find((category) => category.id === "provider-only")?.estimatedTokens ?? 0;
    expect(residual(withCatalog)).toBe(residual(withoutCatalog));
  });

  test("keeps known external rows known when another row fails conversion", () => {
    const input = baseInput({
      tools: [
        toolRow({ effectiveID: "docs_search", name: "docs_search", namespace: "docs" }),
        toolRow({
          effectiveID: "broken",
          name: "broken",
          namespace: "docs",
          status: "unavailable",
          inputJSONSchema: undefined,
        }),
      ],
      selectedModel: { providerID: "deepseek", modelID: "chat", contextLimit: 1000 },
    });
    const analysis = analyzeContext(input);
    const known = analysis.toolAttribution?.tools.find((tool) => tool.id === "docs_search");
    const broken = analysis.toolAttribution?.tools.find((tool) => tool.id === "broken");
    expect(known?.schemaKnown).toBe(true);
    expect(broken?.schemaKnown).toBe(false);
    expect(analysis.estimatedKnownTokens).toBe(0);
  });

  test("retains active tool history but marks an unavailable schema as unknown", () => {
    const message = assistantMessage("a1", [
      {
        type: "tool",
        id: "t1",
        name: "docs_search",
        state: "completed",
        input: { q: "x" },
        output: "result",
      },
    ]);
    const input = baseInput({
      activeMessages: [message],
      historyMessages: [message],
      tools: [
        toolRow({
          effectiveID: "docs_search",
          name: "docs_search",
          status: "unavailable",
          inputJSONSchema: undefined,
        }),
      ],
      selectedModel: { providerID: "deepseek", modelID: "chat", contextLimit: 1000 },
    });
    const analysis = analyzeContext(input);
    const tool = analysis.toolAttribution?.tools.find((entry) => entry.id === "docs_search");
    expect(tool?.calls).toBe(1);
    expect(tool?.schemaKnown).toBe(false);
    expect(tool?.history.estimatedTokens).toBeGreaterThan(0);
  });

  test("reports positive estimation drift instead of inventing a negative unknown category", () => {
    const message = assistantMessage("a1", [{ type: "text", text: "a".repeat(4000) }], {
      tokens: { input: 10, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    });
    const input = baseInput({
      activeMessages: [message],
      historyMessages: [message],
      selectedModel: { providerID: "deepseek", modelID: "chat", contextLimit: 10000 },
    });
    const analysis = analyzeContext(input);
    expect(analysis.estimatedKnownTokens).toBeGreaterThan(analysis.measured?.usedTokens ?? 0);
    expect(analysis.estimationDriftTokens).toBeGreaterThan(0);
    expect(analysis.categories.some((category) => category.id === "provider-only")).toBe(false);
  });

  test("estimates value tokens deterministically", () => {
    expect(estimateValueTokens({ a: "b" })).toBeGreaterThan(0);
  });
});
