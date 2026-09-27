#!/usr/bin/env bun
// FILE: scripts/e2e-v2/tui.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide an honest, non-passing placeholder for the native V2 TUI acceptance tier that T-008/T-009 must implement.
//   SCOPE: Describe the TUI acceptance intent, report the owning tasks, and refuse to report success. It never renders a fake pass or a status-only parity claim.
//   DEPENDS: [node:fs, node:path]
//   LINKS: [M-E2E-V2-HARNESS, V-M-E2E-V2-HARNESS, M-PLUGIN-CONTEXT-TUI]
//   ROLE: SCRIPT
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   TuiAcceptanceResult - Machine-readable outcome of the TUI scaffold.
//   runTuiAcceptance - Report the pending TUI acceptance scope without claiming success.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-V2-NATIVE T-003 - Added the truthful TUI acceptance scaffold owned by T-008/T-009.]
// END_CHANGE_SUMMARY

/** Machine-readable outcome of the TUI scaffold. */
export interface TuiAcceptanceResult {
  readonly ok: false;
  readonly implemented: false;
  readonly ownerTasks: readonly string[];
  readonly requiredScenarios: readonly string[];
  readonly note: string;
}

/**
 * Report the pending TUI acceptance scope. This intentionally returns `ok:false`
 * so a scaffold can never masquerade as a passing TUI acceptance run.
 */
export function runTuiAcceptance(): TuiAcceptanceResult {
  return {
    ok: false,
    implemented: false,
    ownerTasks: ["T-008", "T-009"],
    requiredScenarios: [
      "Overview/Tools/MCP collection and rendering against native client contracts",
      "provider/model usage with honest estimates and explicit unknown states",
      "compaction cutoff, tabs, keyboard navigation, scrolling, narrow layouts",
      "cache indicator, branding footer, peak-hours banner",
      "reopen and error states through a real PTY",
    ],
    note: "TUI acceptance is not implemented in T-003; --tui is a truthful scaffold, never a passing placeholder.",
  };
}
