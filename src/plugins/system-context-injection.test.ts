// FILE: src/plugins/system-context-injection.test.ts
// VERSION: 0.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify primary-session system context injection behavior.
//   SCOPE: Primary agent injection, known subagent exclusion, custom configured subagent exclusion, and duplicate-prevention behavior.
//   DEPENDS: [bun:test, src/plugins/system-context-injection/index.ts]
//   LINKS: [V-M-PLUGIN-SYSTEM-CONTEXT-INJECTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SystemContextInjectionPlugin tests - Verify main-session system guidance is injected only for eligible agents.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.1.0 - Added deterministic coverage for primary-session-only system context injection.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { SystemContextInjectionPlugin } from "./system-context-injection/index.js";

function createPluginInput() {
  return {
    client: {} as never,
    project: {} as never,
    directory: "/tmp/project",
    worktree: "/tmp/project",
    serverUrl: new URL("http://localhost"),
    $: {} as never,
  };
}

function createOutput(agent: string, system?: string) {
  return {
    message: {
      agent,
      system,
    },
    parts: [],
  };
}

describe("SystemContextInjectionPlugin", () => {
  test("injects primary-session system context for build", async () => {
    const plugin = await SystemContextInjectionPlugin(createPluginInput());
    const output = createOutput("build");

    await plugin["chat.message"]?.(
      {
        sessionID: "session-1",
        agent: undefined,
      } as never,
      output as never,
    );

    const systemText = output.message.system ?? "";

    expect(systemText).toContain("<proactive_context_gathering>");
    expect(systemText).toContain("proactively use the explore subagent");
  });

  test("preserves existing system text and avoids duplicate injection", async () => {
    const plugin = await SystemContextInjectionPlugin(createPluginInput());
    const output = createOutput("enhancer", "Existing system context.");

    await plugin["chat.message"]?.(
      { sessionID: "session-1", agent: "enhancer" } as never,
      output as never,
    );
    await plugin["chat.message"]?.(
      { sessionID: "session-1", agent: "enhancer" } as never,
      output as never,
    );

    const systemText = output.message.system ?? "";

    expect(systemText).toContain("Existing system context.");
    expect(systemText.match(/<proactive_context_gathering>/g)).toHaveLength(1);
  });

  test("skips built-in subagents", async () => {
    const plugin = await SystemContextInjectionPlugin(createPluginInput());
    const output = createOutput("explore");

    await plugin["chat.message"]?.(
      { sessionID: "session-1", agent: "explore" } as never,
      output as never,
    );

    expect(output.message.system).toBeUndefined();
  });

  test("skips plugin-managed subagents", async () => {
    const plugin = await SystemContextInjectionPlugin(createPluginInput());
    const output = createOutput("memory-reviewer");

    await plugin["chat.message"]?.(
      { sessionID: "session-1", agent: "memory-reviewer" } as never,
      output as never,
    );

    expect(output.message.system).toBeUndefined();
  });

  test("skips custom configured subagents", async () => {
    const plugin = await SystemContextInjectionPlugin(createPluginInput());
    await plugin.config?.({
      agent: {
        reviewer: {
          mode: "subagent",
        },
      },
    } as never);

    const output = createOutput("reviewer");

    await plugin["chat.message"]?.(
      { sessionID: "session-1", agent: "reviewer" } as never,
      output as never,
    );

    expect(output.message.system).toBeUndefined();
  });

  test("keeps injected guidance wording stable", async () => {
    const plugin = await SystemContextInjectionPlugin(createPluginInput());
    const output = createOutput("build");

    await plugin["chat.message"]?.(
      { sessionID: "session-1", agent: "build" } as never,
      output as never,
    );

    const systemText = output.message.system ?? "";

    expect(systemText).toContain("Before answering questions about the codebase or making changes");
    expect(systemText.replace(/\s+/g, " ")).toContain("proactively use the explore subagent");
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "Do not guess about code you have not inspected.",
    );
  });
});
