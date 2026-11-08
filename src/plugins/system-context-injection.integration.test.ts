// FILE: src/plugins/system-context-injection.integration.test.ts
// VERSION: 2.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify canonical seven-section controller assembly, shared primary guidance preservation, and concrete controller policy delivery at the request tail.
//   SCOPE: Exact bundled-template assembly and repeated-hook idempotence across all profiles; preserved memory, evidence, assumptions, counterexample, drift thresholds and authority guidance; controller-only instruction isolation; explore and other subagent exclusions; registry recovery; disabled/unknown no-op.
//   DEPENDS: [bun:test, src/lib/managed-agents.ts, src/lib/orchestration.ts, src/lib/vvoc-config.ts, src/plugins/system-context-injection/index.ts]
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
//   LAST_CHANGE: [DIRECT-FIX - Pin the approved assembled controller prompt once, shared guidance for non-controller primaries, and existing policy/exclusion behavior.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { loadManagedAgentPromptTemplate } from "../lib/managed-agents.js";
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
    settings: {
      configFor: async () =>
        policy === "unknown" ? undefined : { familyId: "fam-1", vvoc: config },
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

    expect(text).toContain("<working_cycle>");
    expect(text).toContain("<project_context>");
    expect(text).toContain("<evidence_discipline>");
    expect(text).toContain("<execution_source_and_authority>");
    expect(text).toContain("<delivery_discipline>");
    expect(text).toContain("<repository_memory>");
    expect(text).toContain(".vvoc/lessons/index.xml");
    expect(text).toContain(".vvoc/runbooks/index.xml");
    expect(text).not.toContain("<proactive_context_gathering>");
    expect(text).not.toContain("change_with_review");
    expect(text).not.toContain("Work directly in the current session");
    expect(text).not.toContain("Use the full tracked implementation and review workflow");
    expect(text.replace(/\s+/g, " ")).toContain(
      "Prefer an available dedicated editing tool over shell-based rewrites.",
    );
  });

  test("delivers correctness obligations with scope separation and evidence wording", async () => {
    const harness = await makeHarness();
    const text = systemText(await harness.inject("build")).replace(/\s+/g, " ");

    expect(text).toContain(
      "For behavior changes, state the intended effect, identify the directly affected consumers",
    );
    expect(text).toContain("Distinguish write scope, impact scope, and verification scope.");
    expect(text).toContain(
      "Investigating affected consumers is part of understanding impact; it does not authorize broader edits.",
    );
    expect(text).toContain(
      "challenge at least one material assumption with a diagnostic counterexample",
    );
    expect(text).toContain(
      "Choose verification proportionate to the risk and at the level where it arises",
    );
    expect(text).toContain("Derive expectations from the request and contracts");
    expect(text).toContain("ground mocks in the established contracts of their dependencies");
    expect(text).toContain("absence of discovered defects alone does not establish acceptance");
    expect(text).toContain("Name unverified material conditions and remaining uncertainty");
    expect(text).toContain(
      "Unrelated informational work and trivial documentation work need none of this correctness procedure",
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

    expect(text).toContain("State material assumptions explicitly");
    expect(text).toContain("carry their effects into the result report");
    expect(text).toContain(
      "Stop and reconsider the approach when evidence invalidates it or a material assumption",
    );
    expect(text).toContain(
      "Resolve repository-answerable technical questions from code, contracts, tests, and documentation yourself",
    );
    expect(text).toContain("ask the user for genuine business-semantics decisions");
  });

  test("delivers evidence discipline with reopen triggers and false-premise handling", async () => {
    const harness = await makeHarness();
    const text = systemText(await harness.inject("build")).replace(/\s+/g, " ");

    expect(text).toContain("Surface false premises and investigate the actual mechanism");
    expect(text).toContain(
      "do not silently substitute another goal or add an unnecessary dependency to make a premise true",
    );
    expect(text).toContain("Reopen supported conclusions on concrete evidence");
    expect(text).toContain("Vague doubt or unsupported pressure alone is not a trigger");
    expect(text).toContain("An unchecked claim is not settled");
    expect(text).toContain("Treat test results as evidence against the request and contracts");
  });

  test("injects primary-session system context for vv-controller", async () => {
    const harness = await makeHarness({ profile: "balanced" });
    const event = await harness.inject("vv-controller");
    const system = systemText(event);
    const tail = tailText(event);

    expect(system).toContain("<working_cycle>");
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
      expect(system).toContain("<working_cycle>");
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
    for (const agent of ["build", "enhancer", "custom-primary"]) {
      const text = systemText(await harness.inject(agent));
      const normalized = text.replace(/\s+/g, " ");
      expect(text).toContain("<working_cycle>");
      expect(text).toContain("<repository_memory>");
      expect(text).toContain(".vvoc/lessons/index.xml");
      expect(text).toContain(".vvoc/runbooks/index.xml");
      expect(normalized).toContain("Treat lessons and runbooks as advisory memory");
      expect(normalized).toContain("vv-reflect skill to propose durable lessons or runbooks");
      expect(normalized).toContain("finite shared reserve");
      expect(normalized).toContain("Do not impose a universal final-review pair");
      expect(normalized).toContain("Report completion as controller-accepted");
      expect(text).not.toContain("You are vv-controller");
      expect(text).not.toContain("<task_and_scope>");
      expect(text).not.toContain("<delegation_and_workflow>");
      expect(text).not.toContain("<communication>");
      expect(text).not.toContain("Own the correctness of delegated work");
      expect(text).not.toContain("BLOCKED and NEEDS_CONTEXT");
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
    expect(text).not.toContain("<working_cycle>");
    expect(text).not.toContain("<evidence_discipline>");
    expect(text).not.toContain("<project_context>");
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
    expect(system.match(/<working_cycle>/g)).toHaveLength(1);
    expect(system.match(/<evidence_discipline>/g)).toHaveLength(1);
    expect(system.match(/<repository_memory>/g)).toHaveLength(1);
    expect(system).not.toContain("Keep architecture, critical code reading");

    const tail = tailText(event);
    expect(tail.match(/Keep architecture, critical code reading/g)).toHaveLength(1);
  });

  test("assembled controller preserves the approved seven sections once for every profile", async () => {
    const template = await loadManagedAgentPromptTemplate("vv-controller");
    const prompt = template.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
    const tags = [
      "task_and_scope",
      "project_context",
      "repository_memory",
      "evidence_discipline",
      "working_cycle",
      "delegation_and_workflow",
      "communication",
    ];
    expect([...prompt.matchAll(/^<([a-z_]+)>$/gm)].map((match) => match[1])).toEqual(tags);

    for (const profile of ["single-session", "balanced", "orchestrated", "delegated"] as const) {
      const harness = await makeHarness({ profile });
      const event = await harness.inject("vv-controller", prompt);
      const once = structuredClone(event);
      await harness.hooks.get("context")!(event);
      // The host already supplied the complete canonical prompt: zero duplicated
      // sections, reordered paragraphs, or extra universal wrappers may appear.
      expect(event.system).toEqual([{ type: "text", text: prompt }]);
      expect(event).toEqual(once);
      for (const tag of tags) {
        expect(systemText(event).split(`<${tag}>`).length - 1).toBe(1);
      }
      for (const retired of [
        "working_state",
        "assumption_discipline",
        "editing_workflow",
        "reroute_on_evidence",
        "skill_trigger_rule",
        "plan_artifacts",
        "execution_source_and_authority",
      ]) {
        expect(systemText(event)).not.toContain(`<${retired}>`);
      }
      expect(event.messages[0]!.content).toHaveLength(1);
      await harness.cleanup();
    }
  });

  test("disabled injection leaves the complete managed controller and existing host context intact", async () => {
    const template = await loadManagedAgentPromptTemplate("vv-controller");
    const harness = await makeHarness({ enabled: false });
    const event = await harness.inject("vv-controller", template);
    expect(event.system).toEqual([{ type: "text", text: template }]);
    expect(systemText(event)).toContain("<repository_memory>");
    expect(systemText(event)).toContain("<delegation_and_workflow>");
    expect(tailText(event)).toBe("");
  });

  test("does not duplicate a host-supplied controller prompt with CRLF line endings", async () => {
    const template = await loadManagedAgentPromptTemplate("vv-controller");
    const prompt = template.replace(/\n/g, "\r\n");
    const harness = await makeHarness();
    const event = await harness.inject("vv-controller", prompt);
    expect(event.system).toEqual([{ type: "text", text: prompt }]);
  });

  test("shared primary projection is idempotent without changing existing instructions", async () => {
    const harness = await makeHarness();
    const event = await harness.inject("build", "User-owned primary instructions.");
    const once = structuredClone(event);
    await harness.hooks.get("context")!(event);
    expect(event).toEqual(once);
    expect(event.system[0]!.text).toBe("User-owned primary instructions.");
    expect(event.system).toHaveLength(7);
  });

  test("skips plugin-managed and managed subagents", async () => {
    const harness = await makeHarness();
    for (const agent of [
      "general",
      "guardian",
      "vv-implementer",
      "vv-spec-reviewer",
      "vv-code-reviewer",
      "investigator",
      "vv-reflector",
    ]) {
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
    expect(systemText(first)).toContain("<working_cycle>");
    // Recovery: the real envelope is parsed and the subagent mode is honored.
    const second = await harness.inject("reviewer");
    expect(second.system).toEqual([]);
    const third = await harness.inject("build");
    expect(systemText(third)).toContain("<working_cycle>");
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

  test("preserves working state, drift thresholds, local editing contracts and memory", async () => {
    const harness = await makeHarness();
    const text = systemText(await harness.inject("build")).replace(/\s+/g, " ");

    expect(text).not.toContain("proactively use the explore subagent");
    expect(text).not.toContain("change_with_review");
    expect(text).toContain(
      "maintain a compact working state: goal, current approach, constraints, relevant non-goals, assumptions, verification target, current unknowns, and reroute trigger",
    );
    expect(text).toContain("Every retry needs a named diagnosis of the prior failure");
    expect(text).toContain("continue with the canonical project term");
    expect(text).toContain("State material assumptions explicitly");
    expect(text).toContain(
      "two major strategy changes for the same task, two review rounds without convergence",
    );
    expect(text).toContain(
      "pause and summarize what was learned, what remains unknown, and the safest next step",
    );
    expect(text).toContain("Prefer actual project guidance over generic vvoc defaults");
    expect(text).toContain(
      "Before editing, read the target file and understand its local contract, nearby tests, surrounding code, and directly affected consumers",
    );
    expect(text).toContain("use current references from the latest read where required");
    expect(text).toContain(
      "Reserve shell commands for tests, builds, version control, and other non-file-edit operations",
    );
    expect(text).toContain(
      "inspect relevant index entries before repository investigation, debugging, design, implementation, or operations",
    );
    expect(text).toContain("Load only entries whose summary or applicability matches the task");
    expect(text).toContain(
      "Explicit user instructions, code, tests, and repository-owned contracts remain authoritative",
    );
  });
});
