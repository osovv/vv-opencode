// FILE: src/plugins/system-context-injection.test.ts
// VERSION: 0.4.2
// START_MODULE_CONTRACT
//   PURPOSE: Verify universal primary guidance and startup-selected concrete vv-controller orchestration policy injection.
//   SCOPE: Per-profile controller context, primary isolation, explore guidance, known subagent exclusion, duplicate prevention, and startup snapshot stability.
//   DEPENDS: [bun:test, node:fs/promises, node:path, src/lib/config-layers.ts, src/lib/orchestration.ts, src/lib/vvoc-config.ts, src/plugins/system-context-injection/index.ts]
//   LINKS: [M-PLUGIN-SYSTEM-CONTEXT-INJECTION, M-ORCHESTRATION-PROFILES, V-M-PLUGIN-SYSTEM-CONTEXT-INJECTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SystemContextInjectionPlugin tests - Verify main-session system guidance is injected only for eligible agents.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.5.0 - Reset the runtime vvoc config singleton between plugin fixtures.]
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
//   LAST_CHANGE: [C-PRESET-ORCHESTRATION-PROFILES - Added concrete profile selection, negative prompt isolation, and startup snapshot coverage.]
// END_CHANGE_SUMMARY

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resetVvocConfigForTests } from "../lib/config-layers.js";
import type { OrchestrationProfile } from "../lib/orchestration.js";
import { createDefaultVvocConfig, renderVvocConfig } from "../lib/vvoc-config.js";
import { SystemContextInjectionPlugin } from "./system-context-injection/index.js";

const previousConfigHome = process.env.XDG_CONFIG_HOME;

beforeEach(() => {
  resetVvocConfigForTests();
  process.env.XDG_CONFIG_HOME = `/tmp/vvoc-system-context-empty-config-${process.pid}`;
});

afterEach(async () => {
  resetVvocConfigForTests();
  await rm(`/tmp/vvoc-system-context-empty-config-${process.pid}`, {
    recursive: true,
    force: true,
  });
  if (previousConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = previousConfigHome;
  }
});

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

async function writeProfile(profile: OrchestrationProfile): Promise<string> {
  const configHome = process.env.XDG_CONFIG_HOME;
  if (!configHome) throw new Error("XDG_CONFIG_HOME required for system-context test");
  const configPath = join(configHome, "vvoc", "vvoc.json");
  const config = createDefaultVvocConfig();
  config.orchestration = { profile };
  await mkdir(join(configHome, "vvoc"), { recursive: true });
  await writeFile(configPath, renderVvocConfig(config), "utf8");
  return configPath;
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
    expect(systemText).not.toContain("<proactive_context_gathering>");
    expect(systemText).not.toContain("change_with_review");
    expect(systemText).not.toContain("Work directly in the current session");
    expect(systemText).not.toContain("Use the full tracked implementation and review workflow");
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

    expect(output.message.system).toContain("<working_state>");
    expect(output.message.system).toContain("selectively delegate bounded repository search");
    expect(output.message.system).not.toContain("Work directly in the current session");
    expect(output.message.system).not.toContain("Use the full tracked implementation");
  });

  test("preserves existing system text and avoids duplicate injection", async () => {
    const plugin = await SystemContextInjectionPlugin(createPluginInput());
    const output = createOutput("vv-controller", "Existing system context.");

    await plugin["chat.message"]?.(
      { sessionID: "session-1", agent: "vv-controller" } as never,
      output as never,
    );
    await plugin["chat.message"]?.(
      { sessionID: "session-1", agent: "vv-controller" } as never,
      output as never,
    );

    const systemText = output.message.system ?? "";

    expect(systemText).toContain("Existing system context.");
    expect(systemText.match(/<working_state>/g)).toHaveLength(1);
    expect(systemText.match(/<repository_memory>/g)).toHaveLength(1);
    expect(systemText.match(/Keep architecture, critical code reading/g)).toHaveLength(1);
  });

  test("injects only the concrete controller policy selected by each profile", async () => {
    const cases: Array<{
      profile: OrchestrationProfile;
      expected: string;
      absent: string[];
    }> = [
      {
        profile: "single-session",
        expected: "Work directly in the current session",
        absent: [
          "selectively delegate bounded repository search",
          "Use the full tracked implementation and review workflow",
        ],
      },
      {
        profile: "balanced",
        expected: "selectively delegate bounded repository search",
        absent: [
          "Work directly in the current session",
          "Use the full tracked implementation and review workflow",
        ],
      },
      {
        profile: "orchestrated",
        expected: "Use the full tracked implementation and review workflow",
        absent: [
          "Work directly in the current session",
          "selectively delegate bounded repository search",
        ],
      },
    ];

    for (const { profile, expected, absent } of cases) {
      resetVvocConfigForTests();
      await writeProfile(profile);
      const plugin = await SystemContextInjectionPlugin(createPluginInput());
      const output = createOutput("vv-controller");
      await plugin["chat.message"]?.(
        { sessionID: `session-${profile}`, agent: "vv-controller" } as never,
        output as never,
      );
      const systemText = output.message.system ?? "";

      expect(systemText).toContain("<working_state>");
      expect(systemText).toContain(expected);
      for (const inactive of absent) expect(systemText).not.toContain(inactive);
      for (const profileName of ["single-session", "balanced", "orchestrated"]) {
        expect(systemText).not.toContain(profileName);
      }
    }
  });

  test("single-session excludes working-subagent routes and retains the reviewer exception", async () => {
    await writeProfile("single-session");
    const plugin = await SystemContextInjectionPlugin(createPluginInput());
    const output = createOutput("vv-controller");
    await plugin["chat.message"]?.(
      { sessionID: "session-single", agent: "vv-controller" } as never,
      output as never,
    );
    const systemText = output.message.system ?? "";

    for (const activity of [
      "exploration",
      "investigation",
      "planning",
      "implementation",
      "verification",
    ]) {
      expect(systemText).toContain(activity);
    }
    for (const inactive of [
      "proactively use the explore subagent",
      "investigator",
      "vv-implementer",
      "change_with_review",
      "tracked implementation-loop",
    ]) {
      expect(systemText).not.toContain(inactive);
    }
    expect(systemText).toContain("Do not delegate working context to subagents");
    expect(systemText).toContain("Independent reviewer subagents remain permitted");
  });

  test("non-controller primary agents receive universal guidance without orchestration policy", async () => {
    await writeProfile("orchestrated");
    const plugin = await SystemContextInjectionPlugin(createPluginInput());

    for (const agent of ["build", "custom-primary"]) {
      const output = createOutput(agent);
      await plugin["chat.message"]?.(
        { sessionID: `session-${agent}`, agent } as never,
        output as never,
      );
      const systemText = output.message.system ?? "";
      expect(systemText).toContain("<working_state>");
      expect(systemText).not.toContain("Work directly in the current session");
      expect(systemText).not.toContain("selectively delegate bounded repository search");
      expect(systemText).not.toContain("Use the full tracked implementation and review workflow");
    }
  });

  test("keeps the startup-selected policy after vvoc.json changes", async () => {
    await writeProfile("single-session");
    const plugin = await SystemContextInjectionPlugin(createPluginInput());
    await writeProfile("orchestrated");
    const output = createOutput("vv-controller");

    await plugin["chat.message"]?.(
      { sessionID: "session-snapshot", agent: "vv-controller" } as never,
      output as never,
    );

    expect(output.message.system).toContain("Work directly in the current session");
    expect(output.message.system).not.toContain(
      "Use the full tracked implementation and review workflow",
    );
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
    expect(systemText).not.toContain("<working_state>");
    expect(systemText).not.toContain("Work directly in the current session");
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

    expect(systemText).not.toContain("proactively use the explore subagent");
    expect(systemText).not.toContain("change_with_review");
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
