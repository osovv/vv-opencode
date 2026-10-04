// FILE: src/plugins/system-context-injection.integration.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify native universal primary guidance injection, including correctness obligations and evidence discipline, and bound-family concrete vv-controller orchestration policy injection into native system parts.
//   SCOPE: Correctness-obligations delivery, settled-conclusion reopen triggers, false-premise handling, pressure-versus-evidence distinction, per-profile controller context, primary isolation, explore guidance, built-in/managed/configured subagent exclusion, duplicate prevention, native-registry mode exclusion, and unknown/disabled no-op.
//   DEPENDS: [bun:test, src/lib/orchestration.ts, src/lib/vvoc-config.ts, src/plugins/system-context-injection/index.ts]
//   LINKS: [M-PLUGIN-SYSTEM-CONTEXT-INJECTION, M-ORCHESTRATION-PROFILES, V-M-PLUGIN-SYSTEM-CONTEXT-INJECTION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   NativeSystemPart - Native system part fixture.
//   NativeMessage - Native request message fixture carrying mutable content parts.
//   NativeContextEvent - Native chat context event fixture.
//   makeHarness - Builds a native plugin harness with an injected capture policy.
//   systemText - Joins injected native system part text.
//   tailText - Joins the injected transient tail policy text of the last request message.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-SNAPSHOT-ANCHORING-REDESIGN T-007 - Static guidance is asserted in the system prefix while the variable orchestration policy is asserted at the request tail.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import type { OrchestrationProfile } from "../lib/orchestration.js";
import { createDefaultVvocConfig, type VvocConfig } from "../lib/vvoc-config.js";
import { createSystemContextInjectionPlugin } from "./system-context-injection/index.js";

interface NativeSystemPart {
  type: "text";
  text: string;
}
interface NativeMessage {
  role?: string;
  content: Array<{ type: "text"; text: string }>;
}
interface NativeContextEvent {
  sessionID: string;
  agent: string;
  system: NativeSystemPart[];
  messages: NativeMessage[];
}

function systemText(event: NativeContextEvent): string {
  return event.system.map((part) => part.text).join("\n\n");
}

function tailText(event: NativeContextEvent): string {
  const last = event.messages[event.messages.length - 1];
  return last === undefined ? "" : last.content.map((part) => part.text).join("\n\n");
}

async function makeHarness(
  options: {
    profile?: OrchestrationProfile;
    enabled?: boolean;
    policy?: "enabled" | "unknown";
    agentModes?: Record<string, "subagent" | "primary" | "all">;
    /** Override the default registry adapter (defaults to a real envelope-shaped list). */
    agentList?: () => Promise<unknown>;
    existingSystem?: string;
  } = {},
) {
  const config: VvocConfig = createDefaultVvocConfig();
  config.orchestration = { profile: options.profile ?? "balanced" };
  if (options.enabled === false) {
    config.plugins = { ...config.plugins, "system-context-injection": false };
  }
  const policy = options.policy ?? "enabled";
  const agentModes = options.agentModes ?? {
    build: "primary",
    "vv-controller": "primary",
    // Native registry truth: explore is a subagent (core/src/plugin/agent.ts).
    explore: "subagent",
    "custom-primary": "primary",
  };
  const hooks = new Map<string, (event: NativeContextEvent) => Promise<void> | void>();
  let released = false;
  const fakeRuntime = {
    snapshots: {
      configFor: async () =>
        policy === "unknown" ? undefined : { familyId: "fam-1", vvoc: config },
      accept: async () => ({ status: "unbound" }),
    },
    release: async () => {
      released = true;
    },
  };
  const envelope = () => ({
    location: { directory: "/tmp/project" },
    data: Object.entries(agentModes).map(([id, mode]) => ({ id, mode })),
  });
  const fakeContext = {
    location: {
      directory: "/tmp/project",
      project: { id: "proj", directory: "/tmp/project", canonical: "/tmp/project" },
    },
    agent: {
      list: options.agentList ?? (async () => envelope()),
    },
    session: {
      hook: async (name: string, callback: (event: NativeContextEvent) => Promise<void> | void) => {
        hooks.set(name, callback);
        return { dispose: async () => undefined };
      },
    },
  };
  const plugin = createSystemContextInjectionPlugin({
    acquireRuntime: async () => fakeRuntime as never,
  });
  const cleanup = (await plugin.setup(fakeContext as never)) as () => Promise<void>;
  const inject = async (agent: string, existing?: string): Promise<NativeContextEvent> => {
    const handler = hooks.get("context");
    if (handler === undefined) throw new Error("no context hook registered");
    const event: NativeContextEvent = {
      sessionID: `session-${agent}`,
      agent,
      system: existing === undefined ? [] : [{ type: "text", text: existing }],
      messages: [{ role: "user", content: [] }],
    };
    await handler(event);
    return event;
  };
  return { hooks, inject, cleanup, isReleased: () => released };
}

describe("SystemContextInjectionPlugin", () => {
  test("registers the context hook even when the startup config disables the toggle", async () => {
    const disabled = await makeHarness({ enabled: false });
    expect(disabled.hooks.has("context")).toBe(true);
  });

  test("cleanup releases the shared runtime", async () => {
    const harness = await makeHarness();
    expect(harness.isReleased()).toBe(false);
    await harness.cleanup();
    expect(harness.isReleased()).toBe(true);
  });

  test("injects primary-session system context for build", async () => {
    const harness = await makeHarness();
    const event = await harness.inject("build");
    const text = systemText(event);

    expect(text).toContain("<working_state>");
    expect(text).toContain("<reroute_on_evidence>");
    expect(text).toContain("<semantic_continuity>");
    expect(text).toContain("<assumption_discipline>");
    expect(text).toContain("<correctness_obligations>");
    expect(text).toContain("<anti_drift_budget>");
    expect(text).toContain("<project_overlays>");
    expect(text).toContain("<editing_workflow>");
    expect(text).toContain("<repository_memory>");
    expect(text).toContain(".vvoc/lessons/index.xml");
    expect(text).toContain(".vvoc/runbooks/index.xml");
    expect(text).not.toContain("<proactive_context_gathering>");
    expect(text).not.toContain("change_with_review");
    expect(text).not.toContain("Work directly in the current session");
    expect(text).not.toContain("Use the full tracked implementation and review workflow");
    expect(text.replace(/\s+/g, " ")).toContain(
      "prefer the `edit` tool over shell-based rewrites when it is available.",
    );
  });

  test("delivers correctness obligations with scope separation and evidence wording", async () => {
    const harness = await makeHarness();
    const text = systemText(await harness.inject("build")).replace(/\s+/g, " ");

    expect(text).toContain(
      "For behavior changes, run a compact correctness cycle before reporting done",
    );
    expect(text).toContain(
      "Separate write scope (what you may edit), impact scope (behavior that could change), and verification scope (what you actually check).",
    );
    expect(text).toContain(
      "Investigating directly affected consumers to understand impact is required; broadening writes beyond the approved scope is not",
    );
    expect(text).toContain(
      "challenge at least one material assumption with a diagnostic counterexample",
    );
    expect(text).toContain("Choose verification at the level where the risk arises");
    expect(text).toContain(
      "Derive test expectations from the contract and the request, not from the implementation's current output",
    );
    expect(text).toContain(
      "ground mocks in the dependency's established contract rather than in whatever makes the change pass",
    );
    expect(text).toContain("The absence of a discovered defect is not proof of correctness");
    expect(text).toContain(
      "an unverified material condition is reported as remaining uncertainty, never presented as a passed check",
    );
    expect(text).toContain(
      "Unrelated informational or trivial documentation work needs none of this ceremony",
    );
  });

  test("delivers calibrated assumption discipline without per-claim reasoning labels", async () => {
    const harness = await makeHarness();
    const raw = systemText(await harness.inject("build"));
    const text = raw.replace(/\s+/g, " ");

    expect(raw).not.toContain("Mark each claim in internal reasoning:");
    expect(raw).not.toContain("`✓` verified");
    expect(raw).not.toContain("An unmarked claim counts as");
    expect(text).not.toContain("restate the requirement in one line in your own words");

    expect(text).toContain("Do not make silent material assumptions.");
    expect(text).toContain(
      "If a material assumption is necessary, state it explicitly and carry its effect into the result report.",
    );
    expect(text).toContain("If a material assumption later becomes false, stop and reroute.");
    expect(text).toContain(
      "Resolve repository-answerable technical questions from the established code, contracts, and tests yourself",
    );
    expect(text).toContain("only a genuine business-semantics fork needs a user decision");
  });

  test("delivers evidence discipline with reopen triggers and false-premise handling", async () => {
    const harness = await makeHarness();
    const text = systemText(await harness.inject("build")).replace(/\s+/g, " ");

    expect(text).toContain(
      "When a request assumes something that does not exist (a library, file, or behavior), surface the false premise",
    );
    expect(text).toContain(
      "never silently substitute a different goal or add an unnecessary dependency to make the premise true",
    );
    expect(text).toContain("A reopen or reroute trigger is concrete");
    expect(text).toContain("Vague doubt or unsupported pressure is not itself a trigger");
    expect(text).toContain("An unchecked claim is not settled");
    expect(text).toContain(
      "Interpret test results as evidence against the request and established contracts, not as the authoritative specification",
    );
  });

  test("injects primary-session system context for vv-controller", async () => {
    const harness = await makeHarness({ profile: "balanced" });
    const event = await harness.inject("vv-controller");
    const system = systemText(event);
    const tail = tailText(event);

    expect(system).toContain("<working_state>");
    expect(system).not.toContain("selectively delegate bounded repository search");
    expect(system).not.toContain("Work directly in the current session");
    expect(system).not.toContain("Use the full tracked implementation");
    expect(tail).toContain("selectively delegate bounded repository search");
  });

  test("injects only the concrete controller policy selected by each captured profile", async () => {
    const cases: Array<{ profile: OrchestrationProfile; expected: string; absent: string[] }> = [
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
      {
        profile: "delegated",
        expected: "Keep architecture, important code reading, task contracts",
        absent: [
          "Work directly in the current session",
          "selectively delegate bounded repository search",
          "Use the full tracked implementation and review workflow",
        ],
      },
    ];

    for (const { profile, expected, absent } of cases) {
      const harness = await makeHarness({ profile });
      const event = await harness.inject("vv-controller");
      const system = systemText(event);
      const tail = tailText(event);
      expect(system).toContain("<working_state>");
      expect(system).not.toContain(expected);
      expect(tail).toContain(expected);
      for (const inactive of absent) expect(tail).not.toContain(inactive);
      for (const profileName of ["single-session", "balanced", "orchestrated", "delegated"]) {
        expect(tail).not.toContain(profileName);
      }
    }
  });

  test("single-session excludes working-subagent routes and retains the reviewer exception", async () => {
    const harness = await makeHarness({ profile: "single-session" });
    const tail = tailText(await harness.inject("vv-controller"));

    for (const activity of [
      "exploration",
      "investigation",
      "planning",
      "implementation",
      "verification",
    ]) {
      expect(tail).toContain(activity);
    }
    for (const inactive of [
      "proactively use the explore subagent",
      "investigator",
      "vv-implementer",
      "change_with_review",
      "tracked implementation-loop",
    ]) {
      expect(tail).not.toContain(inactive);
    }
    expect(tail).toContain("Do not delegate working context to subagents");
    expect(tail).toContain("Independent reviewer subagents remain permitted");
  });

  test("non-controller primary agents receive universal guidance without orchestration policy", async () => {
    const harness = await makeHarness({ profile: "orchestrated" });
    for (const agent of ["build", "custom-primary"]) {
      const text = systemText(await harness.inject(agent));
      expect(text).toContain("<working_state>");
      expect(text).not.toContain("Work directly in the current session");
      expect(text).not.toContain("selectively delegate bounded repository search");
      expect(text).not.toContain("Use the full tracked implementation and review workflow");
    }
  });

  test("injects explore-specific guidance for the built-in subagent-mode explore worker only", async () => {
    // Pinned native truth: core/src/plugin/agent.ts sets explore.mode = "subagent".
    const harness = await makeHarness();
    const text = systemText(await harness.inject("explore"));

    expect(text).toContain("<explore_role>");
    expect(text.replace(/\s+/g, " ")).toContain(
      "You are a repository search-and-discovery worker.",
    );
    expect(text).not.toContain("<working_state>");
    expect(text).not.toContain("<correctness_obligations>");
    expect(text).not.toContain("<semantic_continuity>");
    expect(text).not.toContain("Work directly in the current session");
    expect(text).not.toContain("selectively delegate bounded repository search");
  });

  test("preserves existing system text and avoids duplicate injection", async () => {
    const harness = await makeHarness({ profile: "balanced" });
    const handler = harness.hooks.get("context");
    if (handler === undefined) throw new Error("no context hook registered");
    const event: NativeContextEvent = {
      sessionID: "session-vv-controller",
      agent: "vv-controller",
      system: [{ type: "text", text: "Existing system context." }],
      messages: [{ role: "user", content: [] }],
    };
    await handler(event);
    await handler(event);

    const system = systemText(event);
    expect(system).toContain("Existing system context.");
    expect(system.match(/<working_state>/g)).toHaveLength(1);
    expect(system.match(/<correctness_obligations>/g)).toHaveLength(1);
    expect(system.match(/<repository_memory>/g)).toHaveLength(1);
    expect(system).not.toContain("Keep architecture, critical code reading");

    const tail = tailText(event);
    expect(tail.match(/Keep architecture, critical code reading/g)).toHaveLength(1);
  });

  test("skips plugin-managed and managed subagents", async () => {
    const harness = await makeHarness();
    for (const agent of ["guardian", "vv-implementer"]) {
      const event = await harness.inject(agent);
      expect(event.system).toEqual([]);
    }
  });

  test("skips internal title/summary/compaction agents", async () => {
    const harness = await makeHarness();
    for (const agent of ["title", "summary", "compaction"]) {
      const event = await harness.inject(agent);
      expect(event.system).toEqual([]);
    }
  });

  test("skips a custom agent whose native registry mode is subagent", async () => {
    const harness = await makeHarness({
      agentModes: { build: "primary", reviewer: "subagent" },
    });
    const event = await harness.inject("reviewer");
    expect(event.system).toEqual([]);
  });

  test("default registry adapter reads the real native envelope and recovers from a transient failure", async () => {
    let calls = 0;
    const harness = await makeHarness({
      agentList: async () => {
        calls += 1;
        if (calls === 1) throw new Error("registry unavailable");
        return {
          location: { directory: "/tmp/project" },
          data: [
            { id: "build", name: "Build", mode: "primary" },
            { id: "reviewer", name: "Reviewer", mode: "subagent" },
          ],
        };
      },
    });
    // First lookup fails transiently: the agent is treated as non-subagent (no
    // permanent poisoning) and universal guidance is injected.
    const first = await harness.inject("build");
    expect(systemText(first)).toContain("<working_state>");
    // Recovery: the real envelope is parsed and the subagent mode is honored.
    const second = await harness.inject("reviewer");
    expect(second.system).toEqual([]);
    const third = await harness.inject("build");
    expect(systemText(third)).toContain("<working_state>");
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  test("default registry adapter reflects a newly configured subagent without restart", async () => {
    const modes = new Map<string, "subagent" | "primary">([["build", "primary"]]);
    const harness = await makeHarness({
      agentList: async () => ({
        location: { directory: "/tmp/project" },
        data: [...modes.entries()].map(([id, mode]) => ({ id, mode })),
      }),
    });
    expect((await harness.inject("new-worker")).system).not.toEqual([]);
    modes.set("new-worker", "subagent");
    expect((await harness.inject("new-worker")).system).toEqual([]);
  });

  test("a disabled or unknown captured policy injects nothing", async () => {
    const disabled = await makeHarness({ enabled: false });
    expect((await disabled.inject("build")).system).toEqual([]);
    const unknown = await makeHarness({ policy: "unknown" });
    expect((await unknown.inject("build")).system).toEqual([]);
  });

  test("keeps injected guidance wording stable", async () => {
    const harness = await makeHarness();
    const text = systemText(await harness.inject("build")).replace(/\s+/g, " ");

    expect(text).not.toContain("proactively use the explore subagent");
    expect(text).not.toContain("change_with_review");
    expect(text).toContain(
      "stabilize a compact working state before acting: goal, current route, constraints, non-goals when relevant, assumptions, verification target, current unknown, and reroute if.",
    );
    expect(text).toContain("When new evidence invalidates the current route, stop and reroute.");
    expect(text).toContain("Reuse stable domain terms from the user request and the repository.");
    expect(text).toContain("Do not make silent material assumptions.");
    expect(text).toContain("When repeated attempts do not converge, stop and summarize.");
    expect(text).toContain(
      "project-specific vocabulary, preferred patterns, boundaries, verification commands, architecture notes, or examples",
    );
    expect(text).toContain(
      "Read the file first, then use exact `line#hash#anchor` refs from the latest `read` output when present.",
    );
    expect(text).toContain(
      "Reserve `bash` for tests, builds, git, and other non-file-edit commands.",
    );
    expect(text).toContain(
      "inspect relevant index entries before debugging, fixing, changing behavior, operating on, architecting, or investigating repository-specific issues.",
    );
    expect(text).toContain(
      "advisory agent-facing repository memory, not as stronger authority than explicit user instructions, code, tests, or repository-owned instructions.",
    );
  });
});
