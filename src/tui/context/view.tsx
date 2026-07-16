// FILE: src/tui/context/view.tsx
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Render the context analysis as an OpenCode-native measured-versus-estimated dialog.
//   SCOPE: Static xlarge dialog composition, token formatting, usage bar, category rows, MCP status, warnings, and accuracy legend.
//   DEPENDS: [@opencode-ai/plugin/tui, @opentui/core, @opentui/solid, src/tui/context/types.ts]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, DF-CONTEXT-INSPECTION, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   openContextDialog - Replace the host dialog stack with a rendered context report.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-CONTEXT-TUI-PLUGIN - Added the /context measured and approximate breakdown dialog.]
// END_CHANGE_SUMMARY

import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { RGBA } from "@opentui/core";
import type { ContextAnalysis } from "./types.js";

type Color = RGBA | string;

// START_BLOCK_CONTEXT_DIALOG
export function openContextDialog(api: TuiPluginApi, analysis: ContextAnalysis): void {
  const Dialog = api.ui.Dialog;
  const theme = api.theme.current;
  api.ui.dialog.setSize("xlarge");
  api.ui.dialog.replace(() => (
    <Dialog size="xlarge" onClose={() => api.ui.dialog.clear()}>
      <box flexDirection="column" gap={1} paddingLeft={1} paddingRight={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text}>Context usage</text>
          <text fg={theme.textMuted}>{formatModel(analysis)}</text>
        </box>

        <UsageSummary analysis={analysis} primary={theme.primary} muted={theme.textMuted} />

        <box flexDirection="column">
          <text fg={theme.text}>Approximate breakdown</text>
          {analysis.categories.map((category) => (
            <box flexDirection="row" justifyContent="space-between">
              <text fg={category.source === "provider-residual" ? theme.warning : theme.textMuted}>
                {category.source === "estimated" ? `~ ${category.label}` : category.label}
              </text>
              <text fg={theme.text}>{formatTokens(category.estimatedTokens)}</text>
            </box>
          ))}
        </box>

        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.textMuted}>Active messages</text>
          <text fg={theme.text}>
            {analysis.activeMessageCount}
            {analysis.compacted ? " (after compaction)" : ""}
          </text>
        </box>

        <McpSummary analysis={analysis} text={theme.text} muted={theme.textMuted} />

        {analysis.estimationDriftTokens > 0 ? (
          <text fg={theme.warning}>
            Estimate drift: +{formatTokens(analysis.estimationDriftTokens)} above provider usage
          </text>
        ) : null}

        {analysis.warnings.slice(0, 3).map((warning) => (
          <text fg={theme.warning}>Warning: {warning}</text>
        ))}

        <text fg={theme.textMuted}>
          Measured = latest provider usage. ~ = local estimate. MCP tools without source metadata
          are grouped.
        </text>
      </box>
    </Dialog>
  ));
}
// END_BLOCK_CONTEXT_DIALOG

function UsageSummary(props: { analysis: ContextAnalysis; primary: Color; muted: Color }) {
  const measured = props.analysis.measured;
  if (!measured) {
    return (
      <text fg={props.muted}>
        Provider usage is not available until the session has an assistant turn.
      </text>
    );
  }

  const percent = measured.percentUsed;
  return (
    <box flexDirection="column">
      <text fg={props.primary}>
        {renderUsageBar(percent)} {formatTokens(measured.usedTokens)}
        {measured.contextLimit ? ` / ${formatTokens(measured.contextLimit)}` : ""}
        {percent === undefined ? "" : ` (${percent.toFixed(1)}%)`}
      </text>
      <text fg={props.muted}>
        input {formatTokens(measured.inputTokens)} · cache read{" "}
        {formatTokens(measured.cacheReadTokens)} · output {formatTokens(measured.outputTokens)}
        {measured.remainingTokens === undefined
          ? ""
          : ` · remaining ${formatTokens(measured.remainingTokens)}`}
      </text>
    </box>
  );
}

function McpSummary(props: { analysis: ContextAnalysis; text: Color; muted: Color }) {
  if (props.analysis.mcpServers.length === 0) {
    return <text fg={props.muted}>MCP servers: none reported</text>;
  }

  return (
    <box flexDirection="column">
      <text fg={props.text}>MCP servers</text>
      {props.analysis.mcpServers.map((server) => (
        <box flexDirection="row" justifyContent="space-between">
          <text fg={props.muted}>{server.name}</text>
          <text fg={props.text}>{server.status}</text>
        </box>
      ))}
    </box>
  );
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

function renderUsageBar(percent: number | undefined): string {
  const width = 28;
  const normalized = percent === undefined ? 0 : Math.min(100, Math.max(0, percent));
  const filled = Math.round((normalized / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}
