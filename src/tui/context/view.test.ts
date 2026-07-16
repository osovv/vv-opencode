// FILE: src/tui/context/view.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify host-owned /context composition, responsive tab rendering, keyboard navigation, bounded scrolling, and dialog-local cleanup.
//   SCOPE: Pure helpers plus deterministic OpenTUI test-renderer frames; no running OpenCode process.
//   DEPENDS: [bun:test, @opencode-ai/plugin/tui, @opentui/solid, src/tui/context/view.tsx]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   context dialog composition tests - Protect host ownership and replace-before-size ordering.
//   context tab helper tests - Verify deterministic cycling, direct selection, body bounds, and visual bar clamping.
//   context dialog rendering tests - Capture Overview, Tools, MCP, narrow, scrolling, cleanup, and reopen behavior.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-CONTEXT-TUI-DETAILED-ATTRIBUTION - Added deterministic tab, rendering, scroll, responsive-frame, and lifecycle coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { ContextAnalysis, ContextMcpUsage, ContextToolUsage } from "./types.js";

const solidPreload: string = "@opentui/solid/preload";
await import(solidPreload);
const { createComponent, testRender } = await import("@opentui/solid");
const {
  ContextDialogContent,
  calculateContextBodyHeight,
  openContextDialog,
  renderMetricBar,
  selectContextTabForKey,
} = await import("./view.js");

const THEME = {
  text: "#ffffff",
  textMuted: "#888888",
  primary: "#00ffff",
  warning: "#ffff00",
};

describe("context dialog composition", () => {
  test("renders context content directly in the host dialog before applying xlarge size", () => {
    let dialogReads = 0;
    let selectedSize: string | undefined;
    let render: (() => unknown) | undefined;
    const dialogEvents: string[] = [];

    const ui = {
      get Dialog() {
        dialogReads += 1;
        return () => null;
      },
      dialog: {
        setSize: (size: string) => {
          selectedSize = size;
          dialogEvents.push(`size:${size}`);
        },
        replace: (renderer: () => unknown) => {
          render = renderer;
          dialogEvents.push("replace");
        },
      },
    };
    const api = {
      theme: { current: THEME },
      ui,
    } as unknown as TuiPluginApi;

    openContextDialog(api, emptyAnalysis());

    expect(selectedSize).toBe("xlarge");
    expect(render).toBeFunction();
    expect(dialogReads).toBe(0);
    expect(dialogEvents).toEqual(["replace", "size:xlarge"]);
  });
});

describe("context tab helpers", () => {
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

  test("bounds body height and clamps bars without clamping numeric percentages", () => {
    expect(calculateContextBodyHeight(60)).toBe(24);
    expect(calculateContextBodyHeight(18)).toBe(6);
    expect(calculateContextBodyHeight(5)).toBe(1);
    expect(renderMetricBar(150, 10)).toBe("[██████████]");
    expect(renderMetricBar(undefined, 10)).toBe("[░░░░░░░░░░]");
  });
});

describe("context dialog rendering", () => {
  test("renders representative Overview, Tools, and MCP metrics and switches through both navigation forms", async () => {
    const setup = await renderDialog(detailedAnalysis(), 90, 28);

    const overview = setup.captureCharFrame();
    expect(overview).toContain("[1 Overview]");
    expect(overview).toContain("Built-in tool schemas");
    expect(overview).toContain("10.0%");
    expect(overview).toContain("150.0%");
    expect(overview).toContain("—");

    setup.mockInput.pressArrow("right");
    await setup.flush();
    const tools = setup.captureCharFrame();
    expect(tools).toContain("[2 Tools]");
    expect(tools).toContain("read");
    expect(tools).toContain("active calls 2");
    expect(tools).toContain("Built-in");

    setup.mockInput.pressKey("3");
    await setup.flush();
    const mcp = setup.captureCharFrame();
    expect(mcp).toContain("[3 MCP]");
    expect(mcp).toContain("docs server");
    expect(mcp).toContain("disabled");
    expect(mcp).toContain("schema 0 · 0.0%");
    expect(mcp).toContain("history 500 · 5.0%");
    expect(mcp).toContain("Other external/plugin");

    setup.mockInput.pressKey("1");
    await setup.flush();
    expect(setup.captureCharFrame()).toContain("[1 Overview]");
    setup.renderer.destroy();
  });

  test("keeps overflowing tool detail inside a focused bounded body and scrolls vertically", async () => {
    const analysis = detailedAnalysis();
    analysis.toolAttribution!.tools = Array.from({ length: 30 }, (_, index) =>
      toolUsage(`tool-${String(index).padStart(2, "0")}`, index + 1),
    );
    const setup = await renderDialog(analysis, 64, 18);
    setup.mockInput.pressKey("2");
    await setup.flush();

    const before = setup.captureCharFrame();
    expect(before.split("\n")).toHaveLength(19);
    expect(before).toContain("tool-00");
    expect(before).toContain("Measured = latest provider usage");

    for (let index = 0; index < 14; index += 1) setup.mockInput.pressArrow("down");
    await setup.flush();
    const after = setup.captureCharFrame();
    expect(after).not.toBe(before);
    expect(after).toMatch(/tool-0[2-9]|tool-1[0-9]/);
    expect(after).toContain("Measured = latest provider usage");
    setup.renderer.destroy();
  });

  test("renders essential values at narrow width without horizontal frame overflow", async () => {
    const setup = await renderDialog(detailedAnalysis(), 50, 20);
    setup.mockInput.pressKey("3");
    await setup.flush();
    const frame = setup.captureCharFrame();

    expect(frame).toContain("[3 MCP]");
    expect(frame).toContain("docs server");
    expect(frame).toContain("history 500 · 5.0%");
    expect(frame.split("\n").every((line) => line.length <= 50)).toBe(true);
    setup.renderer.destroy();
  });

  test("removes the dialog-local modal keymap and reopens with fresh Overview state", async () => {
    const keymap = createKeymapHarness();
    const first = await renderDialog(detailedAnalysis(), 80, 20, keymap.api);
    expect(keymap.layer?.mode).toBe("modal");
    expect(keymap.layer?.bindings.map((binding) => binding.key)).toEqual([
      "left",
      "right",
      "1",
      "2",
      "3",
    ]);
    keymap.run("vvoc.context.tab.mcp");
    await first.flush();
    expect(first.captureCharFrame()).toContain("[3 MCP]");
    first.renderer.destroy();
    expect(keymap.disposeCount()).toBe(1);

    const reopenedKeymap = createKeymapHarness();
    const reopened = await renderDialog(detailedAnalysis(), 80, 20, reopenedKeymap.api);
    expect(reopened.captureCharFrame()).toContain("[1 Overview]");
    reopened.renderer.destroy();
    expect(reopenedKeymap.disposeCount()).toBe(1);
  });
});

async function renderDialog(
  analysis: ContextAnalysis,
  width: number,
  height: number,
  keymap?: TuiPluginApi["keymap"],
) {
  const setup = await testRender(
    () => createComponent(ContextDialogContent, { analysis, keymap, theme: THEME }),
    { width, height },
  );
  await setup.flush();
  return setup;
}

type CapturedKeymapLayer = {
  mode?: string;
  commands: Array<{ name: string; run: () => unknown }>;
  bindings: Array<{ key: string; cmd: string }>;
};

function createKeymapHarness() {
  let layer: CapturedKeymapLayer | undefined;
  let disposals = 0;
  const api = {
    registerLayer(value: CapturedKeymapLayer) {
      layer = value;
      return () => {
        disposals += 1;
      };
    },
  } as unknown as TuiPluginApi["keymap"];
  return {
    api,
    get layer() {
      return layer;
    },
    run(name: string) {
      const command = layer?.commands.find((candidate) => candidate.name === name);
      if (!command) throw new Error(`Missing keymap command ${name}`);
      command.run();
    },
    disposeCount: () => disposals,
  };
}

function emptyAnalysis(): ContextAnalysis {
  return {
    sessionID: "session-1",
    categories: [],
    estimatedKnownTokens: 0,
    estimatedTotalTokens: 0,
    estimationDriftTokens: 0,
    compacted: false,
    activeMessageCount: 0,
    mcpServers: [],
    warnings: [],
  };
}

function detailedAnalysis(): ContextAnalysis {
  const read = toolUsage("read", 1_500, {
    source: { kind: "builtin" },
    calls: 2,
    schema: { estimatedTokens: 500, percent: 5 },
    history: { estimatedTokens: 1_000, percent: 10 },
  });
  const docsTool = toolUsage("docs_search", 500, {
    source: { kind: "mcp", server: "docs server" },
    calls: 1,
    schema: { estimatedTokens: 0, percent: 0 },
    history: { estimatedTokens: 500, percent: 5 },
  });
  const other = toolUsage("very_long_external_plugin_tool_name", 250, {
    calls: 1,
    schema: { estimatedTokens: 100, percent: 1 },
    history: { estimatedTokens: 150, percent: 1.5 },
  });
  const mcp: ContextMcpUsage = {
    name: "docs server",
    status: "disabled",
    toolCount: 0,
    schema: { estimatedTokens: 0, percent: 0 },
    history: { estimatedTokens: 500, percent: 5 },
    total: { estimatedTokens: 500, percent: 5 },
    tools: [docsTool],
  };
  return {
    sessionID: "session-1",
    agent: "vv-controller-with-a-long-name",
    model: {
      providerID: "provider-with-a-long-name",
      modelID: "model-with-a-long-name",
      contextLimit: 10_000,
    },
    measured: {
      usedTokens: 4_000,
      contextLimit: 10_000,
      remainingTokens: 6_000,
      percentUsed: 40,
      inputTokens: 3_000,
      cacheReadTokens: 500,
      outputTokens: 500,
    },
    categories: [
      {
        id: "builtin-tool-schemas",
        label: "Built-in tool schemas",
        estimatedTokens: 1_000,
        percent: 10,
        source: "estimated",
      },
      {
        id: "external-tool-schemas",
        label: "External/plugin/MCP schemas",
        estimatedTokens: 15_000,
        percent: 150,
        source: "estimated",
      },
      {
        id: "provider-only",
        label: "Unknown/provider-only",
        estimatedTokens: 500,
        source: "provider-residual",
      },
    ],
    estimatedKnownTokens: 16_000,
    estimatedTotalTokens: 16_500,
    estimationDriftTokens: 12_000,
    compacted: true,
    activeMessageCount: 6,
    mcpServers: [{ name: "docs server", status: "disabled" }],
    toolAttribution: {
      tools: [read, docsTool, other],
      mcpServers: [mcp],
      otherTools: [other],
      reconciliation: {
        schema: {
          builtin: { estimatedTokens: 500, percent: 5 },
          vvoc: { estimatedTokens: 0, percent: 0 },
          external: { estimatedTokens: 100, percent: 1 },
          total: { estimatedTokens: 600, percent: 6 },
        },
        history: {
          toolResults: { estimatedTokens: 1_650, percent: 16.5 },
          loadedSkills: { estimatedTokens: 0, percent: 0 },
          total: { estimatedTokens: 1_650, percent: 16.5 },
        },
      },
    },
    warnings: ["Attribution remains approximate."],
  };
}

function toolUsage(
  id: string,
  totalTokens: number,
  overrides: Partial<ContextToolUsage> = {},
): ContextToolUsage {
  const schema = overrides.schema ?? { estimatedTokens: totalTokens, percent: totalTokens / 100 };
  const history = overrides.history ?? { estimatedTokens: 0, percent: 0 };
  return {
    id,
    source: { kind: "other" },
    calls: 0,
    schema,
    history,
    total: overrides.total ?? {
      estimatedTokens: schema.estimatedTokens + history.estimatedTokens,
      percent: (schema.percent ?? 0) + (history.percent ?? 0),
    },
    ...overrides,
  };
}
