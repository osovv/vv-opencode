// FILE: src/plugins/system-context-injection.test.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify primary-session system context injection behavior.
//   SCOPE: Primary agent injection, editing-workflow guidance, known subagent exclusion, custom configured subagent exclusion, and duplicate-prevention behavior.
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
//   LAST_CHANGE: [v0.4.0 - Added coverage for vv-controller primary injection and managed analyst subagent exclusion.]
//   LAST_CHANGE: [v0.3.4 - Updated editing-workflow assertion for context-anchored hashline refs.]
//   LAST_CHANGE: [v0.3.3 - Added regression coverage for primary-session editing workflow guidance that prefers hashline-backed `edit` over shell rewrites.]
//   LAST_CHANGE: [v0.3.2 - Updated assertions to match narrowed explore-only-context-gathering guidance.]
//   LAST_CHANGE: [v0.3.1 - Added coverage verifying vv-* tracked subagents remain excluded from primary-session system context injection.]
//   LAST_CHANGE: [v0.3.0 - Added coverage for standard trajectories, working-state, reroute, semantic continuity, assumption discipline, anti-drift, and project-overlay guidance blocks.]
//   LAST_CHANGE: [v0.2.0 - Added coverage for task routing, execution stability, and loop-control guidance blocks in primary-session system injection.]
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
    expect(systemText).toContain("<standard_trajectories>");
    expect(systemText).toContain("<task_routing>");
    expect(systemText).toContain("<working_state>");
    expect(systemText).toContain("<reroute_on_evidence>");
    expect(systemText).toContain("<semantic_continuity>");
    expect(systemText).toContain("<assumption_discipline>");
    expect(systemText).toContain("<anti_drift_budget>");
    expect(systemText).toContain("<project_overlays>");
    expect(systemText).toContain("<editing_workflow>");
    expect(systemText).toContain("proactively use the explore subagent");
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "Use the explore subagent ONLY for context gathering operations",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "Do NOT ask explore to propose solutions, suggest plans, recommend changes, make design decisions, or evaluate trade-offs.",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "prefer the `edit` tool over shell-based rewrites when it is available.",
    );
  });

  test("injects primary-session system context for vv-controller", async () => {
    const plugin = await SystemContextInjectionPlugin(createPluginInput());
    const output = createOutput("vv-controller");

    await plugin["chat.message"]?.(
      { sessionID: "session-1", agent: "vv-controller" } as never,
      output as never,
    );

    expect(output.message.system).toContain("<proactive_context_gathering>");
    expect(output.message.system).toContain("<task_routing>");
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

  test("skips vv-tracked subagents", async () => {
    const plugin = await SystemContextInjectionPlugin(createPluginInput());
    const output = createOutput("vv-implementer");

    await plugin["chat.message"]?.(
      { sessionID: "session-1", agent: "vv-implementer" } as never,
      output as never,
    );

    expect(output.message.system).toBeUndefined();
  });

  test("skips managed analyst and architect subagents", async () => {
    const plugin = await SystemContextInjectionPlugin(createPluginInput());
    const analystOutput = createOutput("vv-analyst");
    const architectOutput = createOutput("vv-architect");

    await plugin["chat.message"]?.(
      { sessionID: "session-1", agent: "vv-analyst" } as never,
      analystOutput as never,
    );
    await plugin["chat.message"]?.(
      { sessionID: "session-1", agent: "vv-architect" } as never,
      architectOutput as never,
    );

    expect(analystOutput.message.system).toBeUndefined();
    expect(architectOutput.message.system).toBeUndefined();
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
      "Use the explore subagent ONLY for context gathering operations: finding files, reading code, searching for patterns, mapping module relationships, and collecting factual information about the codebase.",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "Do NOT ask explore to propose solutions, suggest plans, recommend changes, make design decisions, or evaluate trade-offs.",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "Do not guess about code you have not inspected.",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "Prefer known trajectories over ad-hoc behavior.",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "classify it as one of: direct_change, investigate_first, or change_with_review.",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "stabilize a compact working state before acting: goal, current route, constraints, non-goals when relevant, assumptions, verification target, current unknown, and reroute if.",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "If new evidence invalidates the current route, stop and reroute instead of forcing the original plan.",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "Reuse stable domain terms from the user request and the repository.",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain("Do not make silent material assumptions.");
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "If you are not converging, stop and summarize instead of continuing blindly.",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "project-specific vocabulary, preferred patterns, boundaries, verification commands, architecture notes, or examples",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "Read the file first, then use exact `line#hash#anchor` refs from the latest `read` output when present.",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "Do not use `apply_patch`; prefer the hashline-backed `edit` tool for file changes. Managed vvoc installs also disable `apply_patch` in OpenCode config.",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "Reserve `bash` for tests, builds, git, and other non-file-edit commands.",
    );
  });
});
