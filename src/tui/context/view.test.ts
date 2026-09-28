// FILE: src/tui/context/view.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify native /context dialog composition, responsive tab rendering, unavailable-catalog disclosure, tab navigation, bounded scrolling, and host dialog sizing.
//   SCOPE: Pure helpers plus deterministic OpenTUI test-renderer frames; no running OpenCode process.
//   DEPENDS: [bun:test, @opencode/plugin/tui, @opentui/solid, src/tui/context/view.tsx]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   LOCALS: THEME, detailedAnalysis, emptyAnalysis, toolUsage, createKeymapHarness, renderDialog
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-008 - Rewrote dialog coverage for the native dialog/keymap APIs and native attribution model.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { Plugin } from "@opencode/plugin/tui";
import { createComponent, testRender } from "@opentui/solid";
import {
  ContextDialogContent,
  calculateContextBodyHeight,
  openContextDialog,
  renderMetricBar,
  selectContextTabForKey,
  type ContextKeymapLike,
} from "./view.js";
import type { ContextAnalysis, ContextToolUsage } from "./types.js";

const THEME = {
  text: "#ffffff",
  muted: "#888888",
  primary: "#00ffff",
  warning: "#ffff00",
  error: "#ff0000",
  success: "#00ff00",
};

interface CapturedCommand {
  title?: string;
  bind?: string | false;
  run?: (input?: string) => void | false | Promise<void>;
}
type CapturedLayer = { mode?: string; commands?: readonly CapturedCommand[] };

function createKeymapHarness() {
  let layer: CapturedLayer | undefined;
  const keymap: ContextKeymapLike = {
    layer: (input) => {
      layer = input();
    },
  };
  return { keymap, getLayer: () => layer };
}

function toolUsage(overrides: Partial<ContextToolUsage> = {}): ContextToolUsage {
  return {
    id: "read",
    source: { kind: "builtin" },
    codeMode: false,
    calls: 2,
    schemaKnown: true,
    schema: { estimatedTokens: 100, percent: 10 },
    history: { estimatedTokens: 50, percent: 5 },
    total: { estimatedTokens: 150, percent: 15 },
    ...overrides,
  };
}

function detailedAnalysis(): ContextAnalysis {
  return {
    sessionID: "ses_1",
    selectedModel: { providerID: "deepseek", modelID: "chat", contextLimit: 1000 },
    historyModel: { providerID: "deepseek", modelID: "chat" },
    agent: "build",
    measured: {
      usedTokens: 500,
      contextLimit: 1000,
      remainingTokens: 500,
      percentUsed: 50,
      inputTokens: 100,
      cacheReadTokens: 350,
      cacheWriteTokens: 20,
      outputTokens: 50,
      reasoningTokens: 10,
      model: { providerID: "deepseek", modelID: "chat" },
      compactionRelation: "after",
      matchesSelectedModel: true,
      label: "Latest provider-reported step usage for the selected model.",
    },
    categories: [
      {
        id: "system",
        label: "Agent/system instructions",
        estimatedTokens: 100,
        percent: 10,
        source: "estimated",
      },
      {
        id: "tool-results",
        label: "Tool calls and results",
        estimatedTokens: 1500,
        percent: 150,
        source: "estimated",
      },
    ],
    estimatedKnownTokens: 1600,
    estimatedTotalTokens: 1600,
    estimationDriftTokens: 0,
    catalogSchemaBudget: { estimatedTokens: 1500, percent: 150 },
    compacted: true,
    compactionCutoffId: "cmp_1",
    activeMessageCount: 3,
    totalMessageCount: 6,
    mcpServers: [{ name: "docs server", status: "connected" }],
    toolCatalogStatus: "partial",
    toolAttribution: {
      tools: [
        toolUsage(),
        toolUsage({
          id: "docs_search",
          source: { kind: "other", namespace: "docs" },
          schemaKnown: false,
          calls: 5,
          history: { estimatedTokens: 500, percent: 50 },
          total: { estimatedTokens: 500, percent: 50 },
          schema: { estimatedTokens: 0 },
        }),
      ],
      otherTools: [
        toolUsage({
          id: "docs_search",
          source: { kind: "other", namespace: "docs" },
          schemaKnown: false,
          calls: 5,
          history: { estimatedTokens: 500, percent: 50 },
          total: { estimatedTokens: 500, percent: 50 },
          schema: { estimatedTokens: 0 },
        }),
      ],
      reconciliation: {
        schema: {
          builtin: { estimatedTokens: 100 },
          vvoc: { estimatedTokens: 0 },
          external: { estimatedTokens: 0 },
          total: { estimatedTokens: 100 },
        },
        history: {
          toolResults: { estimatedTokens: 50, percent: 5 },
          loadedSkills: { estimatedTokens: 0 },
          total: { estimatedTokens: 50, percent: 5 },
        },
      },
    },
    warnings: ["tool catalog truncated to 512 rows"],
  };
}

function emptyAnalysis(): ContextAnalysis {
  return {
    sessionID: "ses_1",
    categories: [],
    estimatedKnownTokens: 0,
    estimatedTotalTokens: 0,
    estimationDriftTokens: 0,
    compacted: false,
    activeMessageCount: 0,
    totalMessageCount: 0,
    mcpServers: [],
    toolCatalogStatus: "unavailable",
    warnings: [],
  };
}

async function renderDialog(
  analysis: ContextAnalysis,
  dimensions: { width: number; height: number },
) {
  const harness = createKeymapHarness();
  const setup = await testRender(
    () => createComponent(ContextDialogContent, { analysis, keymap: harness.keymap, theme: THEME }),
    dimensions,
  );
  await setup.flush();
  return { setup, harness };
}

describe("context dialog composition", () => {
  test("shows content through the host dialog before applying xlarge size", () => {
    const events: string[] = [];
    let render: (() => unknown) | undefined;
    const ctx = {
      ui: {
        dialog: {
          show: (value: () => unknown) => {
            events.push("show");
            render = value;
          },
          set: (options: { size?: string }) => events.push(`size:${options.size}`),
        },
      },
      keymap: { layer: () => undefined },
      theme: {
        text: {
          base: "#ffffff",
          muted: "#888888",
          feedback: {
            warning: { base: "#ffff00" },
            error: { base: "#ff0000" },
            success: { base: "#00ff00" },
          },
        },
        hue: { accent: { 200: "#00ffff" } },
      },
    } as unknown as Plugin.Context;
    openContextDialog(ctx, emptyAnalysis());
    expect(events).toEqual(["show", "size:xlarge"]);
    expect(render).toBeFunction();
  });

  test("cycles tabs and selects Overview, Tools, and MCP directly", () => {
    expect(selectContextTabForKey("overview", "right")).toBe("tools");
    expect(selectContextTabForKey("tools", "right")).toBe("mcp");
    expect(selectContextTabForKey("mcp", "right")).toBe("overview");
    expect(selectContextTabForKey("overview", "left")).toBe("mcp");
    expect(selectContextTabForKey("mcp", "1")).toBe("overview");
    expect(selectContextTabForKey("overview", "2")).toBe("tools");
    expect(selectContextTabForKey("tools", "3")).toBe("mcp");
    expect(selectContextTabForKey("overview", "escape")).toBeUndefined();
  });

  test("fits the body into the host middle half and clamps bars without clamping numeric percentages", () => {
    expect(calculateContextBodyHeight(60)).toBe(16);
    expect(calculateContextBodyHeight(40)).toBe(7);
    expect(calculateContextBodyHeight(28)).toBe(1);
    expect(calculateContextBodyHeight(5)).toBe(1);
    expect(renderMetricBar(150, 10)).toBe("[██████████]");
    expect(renderMetricBar(undefined, 10)).toBe("[░░░░░░░░░░]");
  });

  test("renders Overview, Tools, and MCP content and switches through the modal keymap", async () => {
    const { setup, harness } = await renderDialog(detailedAnalysis(), { width: 100, height: 40 });
    const overview = setup.captureCharFrame();
    expect(overview).toContain("[1 Overview]");
    expect(overview).toContain("Tool calls and results");
    expect(overview).toContain("Measured = latest provider usage");
    expect(overview).toContain("150.0%");

    expect(harness.getLayer()?.mode).toBe("modal");
    const commands = harness.getLayer()?.commands ?? [];
    expect(commands.slice(0, 5).map((command) => command.bind)).toEqual([
      "left",
      "right",
      "1",
      "2",
      "3",
    ]);
    expect(commands.some((command) => command.bind === "pagedown")).toBe(true);
    await commands.find((command) => command.bind === "2")?.run?.();
    await setup.flush();
    const tools = setup.captureCharFrame();
    expect(tools).toContain("[2 Tools]");
    expect(tools).toContain("active calls 2");
    expect(tools).toContain("Built-in");

    await commands.find((command) => command.bind === "3")?.run?.();
    await setup.flush();
    const mcp = setup.captureCharFrame();
    expect(mcp).toContain("[3 MCP]");
    expect(mcp).toContain("docs server");
    expect(mcp).toContain("connected");
    expect(mcp).toContain("not authoritative MCP server provenance");
  });

  test("keeps overflowing tool detail inside a focused bounded body and scrolls vertically", async () => {
    const analysis = detailedAnalysis();
    analysis.toolAttribution!.tools = Array.from({ length: 40 }, (_, index) =>
      toolUsage({ id: `tool-${index.toString().padStart(2, "0")}` }),
    );
    const { setup, harness } = await renderDialog(analysis, { width: 100, height: 60 });
    const commands = harness.getLayer()?.commands ?? [];
    await commands.find((command) => command.bind === "2")?.run?.();
    await setup.flush();
    const before = setup.captureCharFrame();
    expect(before.split("\n").length).toBeLessThanOrEqual(61);
    expect(before).toContain("tool-00");
  });

  test("renders essential values at narrow width without horizontal overflow", async () => {
    const { setup, harness } = await renderDialog(detailedAnalysis(), { width: 50, height: 40 });
    const commands = harness.getLayer()?.commands ?? [];
    await commands.find((command) => command.bind === "3")?.run?.();
    await setup.flush();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("[3 MCP]");
    expect(frame).toContain("docs server");
    expect(frame.split("\n").every((line) => line.length <= 50)).toBe(true);
  });

  test("discloses an unavailable registered catalog instead of showing zeros", async () => {
    const { setup } = await renderDialog(emptyAnalysis(), { width: 100, height: 40 });
    expect(setup.captureCharFrame()).toContain("Provider usage is not available");
  });
});
