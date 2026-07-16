// FILE: src/tui/context/view.tsx
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Render measured usage and detailed context attribution as a responsive host-owned tabbed dialog.
//   SCOPE: Overview, Tools, and MCP tabs; modal-scoped navigation; bounded scrolling; metric formatting; warnings; and host dialog sizing.
//   DEPENDS: [solid-js, @opencode-ai/plugin/tui, @opentui/core, @opentui/keymap, @opentui/solid, src/tui/context/types.ts]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, DF-CONTEXT-INSPECTION, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ContextTab - Stable Overview, Tools, and MCP tab identifiers.
//   openContextDialog - Replace the host dialog stack with the responsive context report before selecting xlarge size.
//   ContextDialogContent - Render measured usage plus component-local Overview, Tools, and MCP tabs.
//   selectContextTabForKey - Resolve left/right and direct-number tab navigation deterministically.
//   registerContextDialogKeymap - Register modal-only tab bindings and return their component-lifetime disposer.
//   calculateContextBodyHeight - Bound the focused scroll region relative to terminal height.
//   renderMetricBar - Render a percentage bar clamped visually at 100 percent.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [DIRECT-FIX - Sized context content to OpenCode's middle-half dialog region for visual vertical centering.]
// END_CHANGE_SUMMARY

import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { RGBA } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal, onCleanup } from "solid-js";
import type {
  ContextAnalysis,
  ContextMcpUsage,
  ContextTokenMetric,
  ContextToolSource,
  ContextToolUsage,
} from "./types.js";

type Color = RGBA | string;
type ContextTheme = {
  text: Color;
  textMuted: Color;
  primary: Color;
  warning: Color;
};

const CONTEXT_TABS = ["overview", "tools", "mcp"] as const;
const CONTEXT_DIALOG_MAX_BODY_HEIGHT = 16;
const CONTEXT_DIALOG_RESERVED_ROWS = 13;
export type ContextTab = (typeof CONTEXT_TABS)[number];

// START_BLOCK_CONTEXT_DIALOG
export function openContextDialog(api: TuiPluginApi, analysis: ContextAnalysis): void {
  const theme = api.theme.current;
  api.ui.dialog.replace(() => (
    <ContextDialogContent
      analysis={analysis}
      keymap={api.keymap}
      theme={{
        text: theme.text,
        textMuted: theme.textMuted,
        primary: theme.primary,
        warning: theme.warning,
      }}
    />
  ));
  api.ui.dialog.setSize("xlarge");
}

export function ContextDialogContent(props: {
  analysis: ContextAnalysis;
  keymap?: TuiPluginApi["keymap"];
  theme: ContextTheme;
}) {
  const [tab, setTab] = createSignal<ContextTab>("overview");
  const dimensions = useTerminalDimensions();
  const narrow = createMemo(() => dimensions().width < 72);
  const bodyHeight = createMemo(() => calculateContextBodyHeight(dimensions().height));
  const barWidth = createMemo(() => calculateMetricBarWidth(dimensions().width));

  if (props.keymap) {
    onCleanup(
      registerContextDialogKeymap(props.keymap, (keyName) => {
        const selected = selectContextTabForKey(tab(), keyName);
        if (selected !== undefined) setTab(selected);
      }),
    );
  } else {
    useKeyboard((event) => {
      const selected = selectContextTabForKey(tab(), event.name);
      if (selected === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      setTab(selected);
    });
  }

  return (
    <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={1}>
      <text fg={props.theme.text} wrapMode="word">
        {`Context usage\n${formatModel(props.analysis)}`}
      </text>

      <UsageSummary
        analysis={props.analysis}
        primary={props.theme.primary}
        muted={props.theme.textMuted}
        barWidth={barWidth()}
      />

      <TabBar tab={tab} theme={props.theme} />

      <scrollbox
        focused={true}
        height={bodyHeight()}
        scrollX={false}
        scrollY={true}
        viewportCulling={true}
      >
        <box flexDirection="column" gap={1} width="100%">
          {() =>
            tab() === "overview" ? (
              <OverviewTab
                analysis={props.analysis}
                theme={props.theme}
                narrow={narrow()}
                barWidth={barWidth()}
              />
            ) : tab() === "tools" ? (
              <ToolsTab analysis={props.analysis} theme={props.theme} narrow={narrow()} />
            ) : (
              <McpTab analysis={props.analysis} theme={props.theme} narrow={narrow()} />
            )
          }
        </box>
      </scrollbox>

      <text fg={props.theme.textMuted} wrapMode="word">
        Measured = latest provider usage. ~ = provider-neutral estimate. Percentages use only the
        current model context limit.
      </text>
    </box>
  );
}
// END_BLOCK_CONTEXT_DIALOG

// START_BLOCK_TAB_NAVIGATION
export function selectContextTabForKey(
  current: ContextTab,
  keyName: string,
): ContextTab | undefined {
  if (keyName === "1") return "overview";
  if (keyName === "2") return "tools";
  if (keyName === "3") return "mcp";
  if (keyName !== "left" && keyName !== "right") return undefined;

  const index = CONTEXT_TABS.indexOf(current);
  const delta = keyName === "left" ? -1 : 1;
  return CONTEXT_TABS[(index + delta + CONTEXT_TABS.length) % CONTEXT_TABS.length];
}

export function registerContextDialogKeymap(
  keymap: TuiPluginApi["keymap"],
  select: (keyName: string) => void,
): () => void {
  const commands = [
    { name: "vvoc.context.tab.left", key: "left", title: "Previous context tab" },
    { name: "vvoc.context.tab.right", key: "right", title: "Next context tab" },
    { name: "vvoc.context.tab.overview", key: "1", title: "Show context Overview" },
    { name: "vvoc.context.tab.tools", key: "2", title: "Show context Tools" },
    { name: "vvoc.context.tab.mcp", key: "3", title: "Show context MCP" },
  ] as const;

  return keymap.registerLayer({
    mode: "modal",
    commands: commands.map((command) => ({
      name: command.name,
      title: command.title,
      run() {
        select(command.key);
      },
    })),
    bindings: commands.map((command) => ({
      key: command.key,
      cmd: command.name,
      desc: command.title,
    })),
  });
}

export function calculateContextBodyHeight(terminalHeight: number): number {
  const normalized = Number.isFinite(terminalHeight) ? Math.floor(terminalHeight) : 34;
  const hostTopOffset = Math.floor(normalized / 4);
  const centeredPanelHeight = normalized - hostTopOffset * 2;
  const available = centeredPanelHeight - CONTEXT_DIALOG_RESERVED_ROWS;
  return Math.max(1, Math.min(CONTEXT_DIALOG_MAX_BODY_HEIGHT, available));
}

function calculateMetricBarWidth(terminalWidth: number): number {
  const normalized = Number.isFinite(terminalWidth) ? Math.floor(terminalWidth) : 80;
  return Math.max(8, Math.min(28, normalized - 34));
}
// END_BLOCK_TAB_NAVIGATION

// START_BLOCK_OVERVIEW_TAB
function OverviewTab(props: {
  analysis: ContextAnalysis;
  theme: ContextTheme;
  narrow: boolean;
  barWidth: number;
}) {
  return (
    <box flexDirection="column" gap={1}>
      <text fg={props.theme.text}>Approximate breakdown</text>
      {props.analysis.categories.map((category) => (
        <MetricRow
          label={category.source === "estimated" ? `~ ${category.label}` : category.label}
          metric={category}
          color={
            category.source === "provider-residual" ? props.theme.warning : props.theme.textMuted
          }
          valueColor={props.theme.text}
          barColor={
            category.source === "provider-residual" ? props.theme.warning : props.theme.primary
          }
          narrow={props.narrow}
          barWidth={props.barWidth}
        />
      ))}

      <box
        flexDirection={props.narrow ? "column" : "row"}
        justifyContent={props.narrow ? "flex-start" : "space-between"}
      >
        <text fg={props.theme.textMuted}>Active messages</text>
        <text fg={props.theme.text}>
          {props.analysis.activeMessageCount}
          {props.analysis.compacted ? " (after compaction)" : ""}
        </text>
      </box>

      {props.analysis.estimationDriftTokens > 0 ? (
        <text fg={props.theme.warning} wrapMode="word">
          Estimate drift: +{formatTokens(props.analysis.estimationDriftTokens)} above provider usage
        </text>
      ) : null}

      {props.analysis.warnings.slice(0, 3).map((warning) => (
        <text fg={props.theme.warning} wrapMode="word">
          Warning: {warning}
        </text>
      ))}
    </box>
  );
}

function MetricRow(props: {
  label: string;
  metric: ContextTokenMetric;
  color: Color;
  valueColor: Color;
  barColor: Color;
  narrow: boolean;
  barWidth: number;
}) {
  return (
    <box flexDirection="column">
      <box
        flexDirection={props.narrow ? "column" : "row"}
        justifyContent={props.narrow ? "flex-start" : "space-between"}
      >
        <text fg={props.color} wrapMode="word">
          {props.label}
        </text>
        <text fg={props.valueColor}>{formatMetric(props.metric)}</text>
      </box>
      <text fg={props.barColor}>{renderMetricBar(props.metric.percent, props.barWidth)}</text>
    </box>
  );
}
// END_BLOCK_OVERVIEW_TAB

// START_BLOCK_TOOLS_TAB
function ToolsTab(props: { analysis: ContextAnalysis; theme: ContextTheme; narrow: boolean }) {
  const tools = props.analysis.toolAttribution?.tools ?? [];
  if (!props.analysis.toolAttribution) {
    return <text fg={props.theme.warning}>Detailed tool attribution is unavailable.</text>;
  }
  if (tools.length === 0) {
    return <text fg={props.theme.textMuted}>No current tool schemas or active tool history.</text>;
  }
  return (
    <box flexDirection="column" gap={1}>
      <text fg={props.theme.text}>Tools · schema + active post-compaction history</text>
      {tools.map((tool) => (
        <ToolCard tool={tool} theme={props.theme} narrow={props.narrow} />
      ))}
    </box>
  );
}

function ToolCard(props: {
  tool: ContextToolUsage;
  theme: ContextTheme;
  narrow: boolean;
  nested?: boolean;
}) {
  return (
    <box flexDirection="column" paddingLeft={props.nested ? 2 : 0}>
      <box
        flexDirection={props.narrow ? "column" : "row"}
        justifyContent={props.narrow ? "flex-start" : "space-between"}
      >
        <text fg={props.theme.text} wrapMode="char">
          {props.tool.id}
        </text>
        <text fg={props.theme.textMuted}>{formatToolSource(props.tool.source)}</text>
      </box>
      <text fg={props.theme.textMuted}>active calls {props.tool.calls}</text>
      <text fg={props.theme.textMuted} wrapMode="word">
        schema {formatMetric(props.tool.schema)} · history {formatMetric(props.tool.history)}
      </text>
      <text fg={props.theme.primary}>total {formatMetric(props.tool.total)}</text>
    </box>
  );
}
// END_BLOCK_TOOLS_TAB

// START_BLOCK_MCP_TAB
function McpTab(props: { analysis: ContextAnalysis; theme: ContextTheme; narrow: boolean }) {
  const attribution = props.analysis.toolAttribution;
  if (!attribution) {
    return (
      <box flexDirection="column" gap={1}>
        <text fg={props.theme.warning}>Detailed MCP attribution is unavailable.</text>
        {props.analysis.mcpServers.map((server) => (
          <text fg={props.theme.textMuted} wrapMode="word">
            {server.name} · {server.status}
          </text>
        ))}
      </box>
    );
  }

  return (
    <box flexDirection="column" gap={1}>
      <text fg={props.theme.text}>MCP servers · current schemas + retained active history</text>
      {attribution.mcpServers.length === 0 ? (
        <text fg={props.theme.textMuted}>No MCP servers reported.</text>
      ) : (
        attribution.mcpServers.map((server) => (
          <McpServerCard server={server} theme={props.theme} narrow={props.narrow} />
        ))
      )}

      <text fg={props.theme.text}>Other external/plugin</text>
      {attribution.otherTools.length === 0 ? (
        <text fg={props.theme.textMuted}>No unattributed external or plugin tools.</text>
      ) : (
        attribution.otherTools.map((tool) => (
          <ToolCard tool={tool} theme={props.theme} narrow={props.narrow} nested={true} />
        ))
      )}
    </box>
  );
}

function McpServerCard(props: { server: ContextMcpUsage; theme: ContextTheme; narrow: boolean }) {
  return (
    <box flexDirection="column">
      <box
        flexDirection={props.narrow ? "column" : "row"}
        justifyContent={props.narrow ? "flex-start" : "space-between"}
      >
        <text fg={props.theme.text} wrapMode="word">
          {props.server.name}
        </text>
        <text fg={props.server.status === "connected" ? props.theme.primary : props.theme.warning}>
          {props.server.status}
        </text>
      </box>
      <text fg={props.theme.textMuted}>current tools {props.server.toolCount}</text>
      <text fg={props.theme.textMuted} wrapMode="word">
        schema {formatMetric(props.server.schema)} · history {formatMetric(props.server.history)}
      </text>
      <text fg={props.theme.primary}>total {formatMetric(props.server.total)}</text>
      {props.server.error ? (
        <text fg={props.theme.warning} wrapMode="word">
          {props.server.error}
        </text>
      ) : null}
      {props.server.tools.length === 0 ? (
        <text fg={props.theme.textMuted}>No attributed current schemas or active history.</text>
      ) : (
        props.server.tools.map((tool) => (
          <ToolCard tool={tool} theme={props.theme} narrow={props.narrow} nested={true} />
        ))
      )}
    </box>
  );
}
// END_BLOCK_MCP_TAB

function TabBar(props: { tab: () => ContextTab; theme: ContextTheme }) {
  return (
    <text fg={props.theme.primary} wrapMode="word">
      {() => `${formatTabBar(props.tab())}\n←/→ tabs · 1/2/3 select · ↑/↓ scroll · Esc close`}
    </text>
  );
}

function UsageSummary(props: {
  analysis: ContextAnalysis;
  primary: Color;
  muted: Color;
  barWidth: number;
}) {
  const measured = props.analysis.measured;
  if (!measured) {
    return (
      <text fg={props.muted} wrapMode="word">
        Provider usage is not available until the session has an assistant turn.
      </text>
    );
  }

  const percent = measured.percentUsed;
  const usageLine = `${renderMetricBar(percent, props.barWidth)} ${formatTokens(measured.usedTokens)}${
    measured.contextLimit ? ` / ${formatTokens(measured.contextLimit)}` : ""
  }${percent === undefined ? "" : ` (${percent.toFixed(1)}%)`}`;
  const tokenLine = `input ${formatTokens(measured.inputTokens)} · cache read ${formatTokens(
    measured.cacheReadTokens,
  )} · output ${formatTokens(measured.outputTokens)}${
    measured.remainingTokens === undefined
      ? ""
      : ` · remaining ${formatTokens(measured.remainingTokens)}`
  }`;
  return (
    <text fg={props.primary} wrapMode="word">
      {`${usageLine}\n${tokenLine}`}
    </text>
  );
}

function formatTabBar(active: ContextTab): string {
  return CONTEXT_TABS.map((tab, index) =>
    active === tab ? `[${index + 1} ${formatTabName(tab)}]` : `${index + 1} ${formatTabName(tab)}`,
  ).join("  ");
}

function formatTabName(tab: ContextTab): string {
  return tab === "mcp" ? "MCP" : tab[0]!.toUpperCase() + tab.slice(1);
}

function formatToolSource(source: ContextToolSource): string {
  if (source.kind === "builtin") return "Built-in";
  if (source.kind === "vvoc") return "vvoc";
  if (source.kind === "mcp") return `MCP · ${source.server}`;
  return "Other external/plugin";
}

function formatMetric(metric: ContextTokenMetric): string {
  return `${formatTokens(metric.estimatedTokens)} · ${formatPercent(metric.percent)}`;
}

function formatPercent(percent: number | undefined): string {
  return percent === undefined ? "—" : `${percent.toFixed(1)}%`;
}

function formatModel(analysis: ContextAnalysis): string {
  if (!analysis.model) return analysis.agent ?? "unknown model";
  const model = `${analysis.model.providerID}/${analysis.model.modelID}`;
  return analysis.agent ? `${analysis.agent} · ${model}` : model;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}m`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}k`;
  return String(tokens);
}

export function renderMetricBar(percent: number | undefined, width = 28): string {
  const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 28;
  const normalized = percent === undefined ? 0 : Math.min(100, Math.max(0, percent));
  const filled = Math.round((normalized / 100) * safeWidth);
  return `[${"█".repeat(filled)}${"░".repeat(safeWidth - filled)}]`;
}
