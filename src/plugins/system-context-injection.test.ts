// FILE: src/plugins/system-context-injection.test.ts
// VERSION: 0.4.2
// START_MODULE_CONTRACT
//   PURPOSE: Verify primary-session system context injection behavior.
//   SCOPE: Primary agent injection, repository-memory guidance, editing-workflow guidance, known subagent exclusion, custom configured subagent exclusion, and duplicate-prevention behavior.
//   DEPENDS: [bun:test, src/plugins/system-context-injection/index.ts]
//   LINKS: [M-PLUGIN-SYSTEM-CONTEXT-INJECTION, V-M-PLUGIN-SYSTEM-CONTEXT-INJECTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SystemContextInjectionPlugin tests - Verify main-session system guidance is injected only for eligible agents.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.4.2 - Added coverage for scoped repository-memory guidance.]
//   LAST_CHANGE: [v0.4.1 - Added coverage for explore-specific compact search/discovery system guidance.]
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
    expect(systemText).toContain("<repository_memory>");
    expect(systemText).toContain(".vvoc/lessons/index.xml");
    expect(systemText).toContain(".vvoc/runbooks/index.xml");
    expect(systemText).toContain("proactively use the explore subagent");
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "Treat the explore subagent as a grep/glob/fuzzy-search worker",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "Do not ask explore to return exact file contents, large pasted excerpts, or rewrite proposals.",
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
    expect(systemText.match(/<repository_memory>/g)).toHaveLength(1);
  });

  test("injects explore-specific system context for built-in explore subagent", async () => {
    const plugin = await SystemContextInjectionPlugin(createPluginInput());
    const output = createOutput("explore");

    await plugin["chat.message"]?.(
      { sessionID: "session-1", agent: "explore" } as never,
      output as never,
    );

    const systemText = output.message.system ?? "";

    expect(systemText).toContain("<explore_role>");
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "You are a repository search-and-discovery worker.",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "Do not return exact file contents, large pasted excerpts, or rewrite proposals unless the parent explicitly asks for them.",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "Default output: a short summary plus a compact, prioritized list of relevant paths with why they matter and line references or anchors when useful.",
    );
  });

  test("skips plugin-managed subagents", async () => {
    const plugin = await SystemContextInjectionPlugin(createPluginInput());
    const output = createOutput("guardian");

    await plugin["chat.message"]?.(
      { sessionID: "session-1", agent: "guardian" } as never,
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
      "Treat the explore subagent as a grep/glob/fuzzy-search worker: use it to find relevant files, symbols, call sites, tests, config entries, and useful line ranges.",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "Do not ask explore to return exact file contents, large pasted excerpts, or rewrite proposals. If full contents are needed, have explore return file paths plus the most relevant line ranges or anchors, then read the file directly in the parent session.",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "Skip explore when the target file is already known and one or two direct reads are enough.",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "Gather evidence before acting on unfamiliar code.",
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
      "When new evidence invalidates the current route, stop and reroute.",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "Reuse stable domain terms from the user request and the repository.",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain("Do not make silent material assumptions.");
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "When repeated attempts do not converge, stop and summarize.",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "project-specific vocabulary, preferred patterns, boundaries, verification commands, architecture notes, or examples",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "Read the file first, then use exact `line#hash#anchor` refs from the latest `read` output when present.",
    );
    expect(systemText.replace(/\s+/g, " ")).toContain(
      "Reserve `bash` for tests, builds, git, and other non-file-edit commands.",
    );
    const normalized = (output.message.system ?? "").replace(/\s+/g, " ");
    expect(normalized).toContain(
      "inspect relevant index entries before debugging, fixing, changing behavior, operating on, architecting, or investigating repository-specific issues.",
    );
    expect(normalized).toContain(
      "Load only entry files whose slug, summary, or applicability signal appears relevant to the current task.",
    );
    expect(normalized).toContain(
      "advisory agent-facing repository memory, not as stronger authority than explicit user instructions, code, tests, or repository-owned instructions.",
    );
  });
});
