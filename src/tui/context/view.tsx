// FILE: src/tui/context/view.tsx
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Render measured usage and detailed native context attribution as a responsive host-owned tabbed dialog using the native dialog, keymap, theme, and slot APIs.
//   SCOPE: Overview, Tools, and MCP tabs; unavailable/unknown disclosure; modal-scoped tab navigation through the native keymap layer; bounded scrolling; metric formatting; model/compaction attribution; warnings; and host dialog sizing.
//   DEPENDS: [@opencode/plugin/tui, @opentui/core, @opentui/solid, solid-js, src/tui/context/types.ts]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, DF-CONTEXT-INSPECTION, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ContextTab - Stable Overview, Tools, and MCP tab identifiers.
//   ContextThemeColors - Theme colors the dialog needs, mapped from the native resolved theme.
//   ContextKeymapLike - Structural native keymap layer registrar accepted by the dialog.
//   openContextDialog - Show the responsive context report through the native host dialog and select xlarge size.
//   claimContextCommand - Claim the app slot and register the /context keymap command inside a mounted render.
//   ContextDialogContent - Render measured usage plus component-local Overview, Tools, and MCP tabs.
//   selectContextTabForKey - Resolve left/right and direct-number tab navigation deterministically.
//   calculateContextBodyHeight - Bound the focused scroll region relative to terminal height.
//   renderMetricBar - Render a percentage bar clamped visually at 100 percent.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-008 - Ported the dialog to native dialog/theme/keymap APIs with native tool, MCP, model, and compaction attribution.]
// END_CHANGE_SUMMARY

import type { Plugin } from "@opencode/plugin/tui";
import type { RGBA } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { createMemo, createSignal } from "solid-js";
import type {
  ContextAnalysis,
  ContextTokenMetric,
  ContextToolSource,
  ContextToolUsage,
} from "./types.js";

type Color = RGBA | string;

/** Theme colors the dialog needs, mapped from the native resolved theme. */
export type ContextThemeColors = {
  text: Color;
  muted: Color;
  primary: Color;
  warning: Color;
  error: Color;
  success: Color;
};

/** Structural native keymap layer registrar accepted by the dialog. */
export type ContextKeymapLike = {
  layer(
    input: () => {
      mode?: string;
      commands?: readonly {
        title?: string;
        bind?: string | false;
        run?: (input?: string) => void | false | Promise<void>;
      }[];
    },
  ): void;
};

const CONTEXT_TABS = ["overview", "tools", "mcp"] as const;
const CONTEXT_DIALOG_MAX_BODY_HEIGHT = 16;
const CONTEXT_DIALOG_RESERVED_ROWS = 13;
export type ContextTab = (typeof CONTEXT_TABS)[number];

// START_BLOCK_CONTEXT_COMMAND_SLOT
/**
 * Claim the always-present native `app` slot and register the /context keymap
 * command from inside a mounted render. Native `keymap.layer` requires the
 * host Keymap provider context, which only exists inside the mounted component
 * tree; registering during plugin `setup` fails with "Keymap.Provider is
 * missing". Returns the slot disposer.
 */
export function claimContextCommand(
  ctx: Plugin.Context,
  command: {
    readonly id: string;
    readonly isEnabled: () => boolean;
    readonly run: () => Promise<void>;
  },
): () => void {
  return ctx.ui.slot({
    append: "app",
    render() {
      ctx.keymap.layer(() => ({
        // Global so the command is reachable from the prompt input mode, like
        // the built-in /btw command; the default base layer is not.
        mode: "global",
        commands: [
          {
            id: command.id,
            title: "Context usage",
            description: "Show measured context usage and an approximate source breakdown",
            group: "VVOC",
            palette: true,
            slash: { name: "context" },
            enabled: command.isEnabled,
            run: command.run,
          },
        ],
      }));
      return <></>;
    },
  });
}
// END_BLOCK_CONTEXT_COMMAND_SLOT

// START_BLOCK_CONTEXT_DIALOG
/** Show the responsive context report through the native host dialog. */
export function openContextDialog(ctx: Plugin.Context, analysis: ContextAnalysis): void {
  ctx.ui.dialog.show(() => (
    <ContextDialogContent analysis={analysis} keymap={ctx.keymap} theme={themeFrom(ctx.theme)} />
  ));
  ctx.ui.dialog.set({ size: "xlarge" });
}

export function ContextDialogContent(props: {
  analysis: ContextAnalysis;
  keymap?: ContextKeymapLike;
  theme: ContextThemeColors;
}) {
  const [tab, setTab] = createSignal<ContextTab>("overview");
  const dimensions = useTerminalDimensions();
  const narrow = createMemo(() => dimensions().width < 72);
  const bodyHeight = createMemo(() => calculateContextBodyHeight(dimensions().height));
  const barWidth = createMemo(() => calculateMetricBarWidth(dimensions().width));
  // The dialog owns its scroll region: the host dialog does not route arrow/page
  // keys into a plugin scrollbox, so bind them explicitly.
  let scrollRegion: { scrollBy(delta: number, unit?: "step" | "viewport"): void } | undefined;

  if (props.keymap) {
    props.keymap.layer(() => ({
      mode: "modal",
      commands: [
        { title: "Previous context tab", bind: "left", run: () => selectAndSet("left") },
        { title: "Next context tab", bind: "right", run: () => selectAndSet("right") },
        { title: "Show context Overview", bind: "1", run: () => selectAndSet("1") },
        { title: "Show context Tools", bind: "2", run: () => selectAndSet("2") },
        { title: "Show context MCP", bind: "3", run: () => selectAndSet("3") },
        { title: "Scroll context up", bind: "up", run: () => scrollRegion?.scrollBy(-1, "step") },
        {
          title: "Scroll context down",
          bind: "down",
          run: () => scrollRegion?.scrollBy(1, "step"),
        },
        {
          title: "Page context up",
          bind: "pageup",
          run: () => scrollRegion?.scrollBy(-1, "viewport"),
        },
        {
          title: "Page context down",
          bind: "pagedown",
          run: () => scrollRegion?.scrollBy(1, "viewport"),
        },
        {
          title: "Scroll context down",
          bind: "ctrl+d",
          run: () => scrollRegion?.scrollBy(1, "viewport"),
        },
        {
          title: "Scroll context up",
          bind: "ctrl+u",
          run: () => scrollRegion?.scrollBy(-1, "viewport"),
        },
      ],
    }));
  }

  function selectAndSet(keyName: string): void {
    const selected = selectContextTabForKey(tab(), keyName);
    if (selected !== undefined) setTab(selected);
  }

  return (
    <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={1}>
      <text fg={props.theme.text} wrapMode="word">
        {`Context usage\n${formatModels(props.analysis)}`}
      </text>

      <UsageSummary
        analysis={props.analysis}
        primary={props.theme.primary}
        muted={props.theme.muted}
        warning={props.theme.warning}
        barWidth={barWidth()}
      />

      <TabBar tab={tab} theme={props.theme} />

      <scrollbox
        ref={(value: unknown) => {
          scrollRegion = value as typeof scrollRegion;
        }}
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

      <text fg={props.theme.muted} wrapMode="word">
        Measured = latest provider usage. ~ = provider-neutral estimate. Percentages use only the
        current model context limit. Registered catalog != the session's final request.
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
  theme: ContextThemeColors;
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
          color={category.source === "provider-residual" ? props.theme.warning : props.theme.muted}
          valueColor={props.theme.text}
          barColor={
            category.source === "provider-residual" ? props.theme.warning : props.theme.primary
          }
          narrow={props.narrow}
          barWidth={props.barWidth}
        />
      ))}

      {props.analysis.catalogSchemaBudget !== undefined ? (
        <MetricRow
          label="Registered tool catalog (budget, not current context)"
          metric={props.analysis.catalogSchemaBudget}
          color={props.theme.muted}
          valueColor={props.theme.text}
          barColor={props.theme.muted}
          narrow={props.narrow}
          barWidth={props.barWidth}
        />
      ) : null}

      <box
        flexDirection={props.narrow ? "column" : "row"}
        justifyContent={props.narrow ? "flex-start" : "space-between"}
      >
        <text fg={props.theme.muted}>Active messages</text>
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
function ToolsTab(props: {
  analysis: ContextAnalysis;
  theme: ContextThemeColors;
  narrow: boolean;
}) {
  const tools = props.analysis.toolAttribution?.tools ?? [];
  return (
    <box flexDirection="column" gap={1}>
      <text fg={props.theme.text}>
        Registered tool catalog — current location; not the session's final request
      </text>
      <text fg={props.theme.muted} wrapMode="word">
        Catalog status: {props.analysis.toolCatalogStatus}
      </text>
      {props.analysis.toolCatalogStatus === "unavailable" ? (
        <text fg={props.theme.warning} wrapMode="word">
          The registered tool catalog is unavailable; schemas and code-mode intent are unknown.
        </text>
      ) : null}
      {tools.length === 0 ? (
        <text fg={props.theme.muted}>No current tool schemas or active tool history.</text>
      ) : (
        tools.map((tool) => <ToolCard tool={tool} theme={props.theme} narrow={props.narrow} />)
      )}
    </box>
  );
}

function ToolCard(props: {
  tool: ContextToolUsage;
  theme: ContextThemeColors;
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
        <text fg={props.theme.muted}>{formatToolSource(props.tool.source)}</text>
      </box>
      <text fg={props.theme.muted}>
        active calls {props.tool.calls} · code mode {props.tool.codeMode ? "on" : "off"}
      </text>
      <text fg={props.theme.muted} wrapMode="word">
        schema {formatKnownMetric(props.tool.schema, props.tool.schemaKnown)} · history{" "}
        {formatMetric(props.tool.history)}
      </text>
      <text fg={props.theme.primary}>
        {props.tool.schemaKnown ? "total" : "known total"} {formatMetric(props.tool.total)}
      </text>
    </box>
  );
}
// END_BLOCK_TOOLS_TAB

// START_BLOCK_MCP_TAB
function McpTab(props: { analysis: ContextAnalysis; theme: ContextThemeColors; narrow: boolean }) {
  const attribution = props.analysis.toolAttribution;
  return (
    <box flexDirection="column" gap={1}>
      <text fg={props.theme.text}>MCP servers · native status</text>
      {props.analysis.mcpServers.length === 0 ? (
        <text fg={props.theme.muted}>No MCP servers reported.</text>
      ) : (
        props.analysis.mcpServers.map((server) => (
          <box flexDirection="column">
            <box
              flexDirection={props.narrow ? "column" : "row"}
              justifyContent={props.narrow ? "flex-start" : "space-between"}
            >
              <text fg={props.theme.text} wrapMode="word">
                {server.name}
              </text>
              <text fg={server.status === "connected" ? props.theme.success : props.theme.warning}>
                {server.status}
              </text>
            </box>
            {server.error ? (
              <text fg={props.theme.warning} wrapMode="word">
                {server.error}
              </text>
            ) : null}
          </box>
        ))
      )}
      <text fg={props.theme.muted} wrapMode="word">
        Tool namespace is a registration hint, not authoritative MCP server provenance; tools
        without a known owner are grouped below.
      </text>

      <text fg={props.theme.text}>Other external/plugin tools</text>
      {(attribution?.otherTools.length ?? 0) === 0 ? (
        <text fg={props.theme.muted}>No unattributed external or plugin tools.</text>
      ) : (
        attribution?.otherTools.map((tool) => (
          <ToolCard tool={tool} theme={props.theme} narrow={props.narrow} nested={true} />
        ))
      )}
    </box>
  );
}
// END_BLOCK_MCP_TAB

function TabBar(props: { tab: () => ContextTab; theme: ContextThemeColors }) {
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
  warning: Color;
  barWidth: number;
}) {
  const measured = props.analysis.measured;
  if (!measured) {
    return (
      <text fg={props.muted} wrapMode="word">
        Provider usage is not available for the active context yet.
      </text>
    );
  }

  const percent = measured.percentUsed;
  const usageLine = `${renderMetricBar(percent, props.barWidth)} ${formatKnownTokens(
    measured.usedTokens,
  )}${measured.contextLimit === undefined ? "" : ` / ${formatTokens(measured.contextLimit)}`}${
    percent === undefined ? "" : ` (${percent.toFixed(1)}%)`
  }`;
  const tokenLine = [
    `input ${formatKnownTokens(measured.inputTokens)}`,
    `cache read ${formatKnownTokens(measured.cacheReadTokens)}`,
    `cache write ${formatKnownTokens(measured.cacheWriteTokens)}`,
    `output ${formatKnownTokens(measured.outputTokens)}`,
    `reasoning ${formatKnownTokens(measured.reasoningTokens)}`,
    measured.remainingTokens === undefined
      ? undefined
      : `remaining ${formatTokens(measured.remainingTokens)}`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
  const color =
    measured.matchesSelectedModel && measured.compactionRelation !== "before"
      ? props.primary
      : props.warning;
  return (
    <box flexDirection="column">
      <text fg={color} wrapMode="word">
        {`${usageLine}\n${tokenLine}\n${measured.label}`}
      </text>
    </box>
  );
}

function themeFrom(theme: {
  text: { base: RGBA; muted: RGBA; feedback: Record<string, { base: RGBA }> };
  hue: { accent: Record<number, RGBA> };
}): ContextThemeColors {
  return {
    text: theme.text.base,
    muted: theme.text.muted,
    primary: theme.hue.accent[200] ?? theme.text.base,
    warning: theme.text.feedback.warning.base,
    error: theme.text.feedback.error.base,
    success: theme.text.feedback.success.base,
  };
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
  return source.namespace === undefined
    ? "Other external/plugin"
    : `Other external/plugin · ${source.namespace}`;
}

function formatMetric(metric: ContextTokenMetric): string {
  return `${formatTokens(metric.estimatedTokens)} · ${formatPercent(metric.percent)}`;
}

function formatKnownMetric(metric: ContextTokenMetric, known: boolean): string {
  return known ? formatMetric(metric) : "unavailable";
}

function formatPercent(percent: number | undefined): string {
  return percent === undefined ? "—" : `${percent.toFixed(1)}%`;
}

function formatModels(analysis: ContextAnalysis): string {
  const selected =
    analysis.selectedModel === undefined
      ? "unknown model"
      : `${analysis.selectedModel.providerID}/${analysis.selectedModel.modelID}${
          analysis.selectedModel.variant === undefined ? "" : `#${analysis.selectedModel.variant}`
        }`;
  const history =
    analysis.historyModel === undefined
      ? undefined
      : `${analysis.historyModel.providerID}/${analysis.historyModel.modelID}`;
  const parts = [
    analysis.agent === undefined ? undefined : analysis.agent,
    `selected ${selected}`,
    history === undefined || history === selected ? undefined : `history ${history}`,
  ].filter((part): part is string => part !== undefined);
  return parts.join(" · ");
}

function formatKnownTokens(tokens: number | undefined): string {
  return tokens === undefined ? "unknown" : formatTokens(tokens);
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
