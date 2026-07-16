// FILE: src/tui/context/view.test.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify that /context renders inside the host-owned dialog with stable xlarge sizing.
//   SCOPE: Renderer registration, post-replacement size selection, and host Dialog ownership regression coverage.
//   DEPENDS: [bun:test, @opencode-ai/plugin/tui, src/tui/context/view.tsx]
//   LINKS: [M-PLUGIN-CONTEXT-TUI, V-M-PLUGIN-CONTEXT-TUI]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   context dialog composition test - Prevent host and plugin Dialog wrappers from being nested.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [DIRECT-FIX - Added regression coverage for host-owned positioning and size reset order.]
// END_CHANGE_SUMMARY

import { expect, test } from "bun:test";
import type { TuiPluginApi } from "@opencode-ai/plugin/tui";
import type { ContextAnalysis } from "./types.js";
import { openContextDialog } from "./view.js";

test("renders context content directly in the host dialog", () => {
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
    theme: {
      current: {
        text: "#ffffff",
        textMuted: "#888888",
        primary: "#00ffff",
        warning: "#ffff00",
      },
    },
    ui,
  } as unknown as TuiPluginApi;

  openContextDialog(api, emptyAnalysis());

  expect(selectedSize).toBe("xlarge");
  expect(render).toBeFunction();
  expect(dialogReads).toBe(0);
  expect(dialogEvents).toEqual(["replace", "size:xlarge"]);
});

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
