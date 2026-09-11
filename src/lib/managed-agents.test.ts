// FILE: src/lib/managed-agents.test.ts
// VERSION: 0.5.3
// START_MODULE_CONTRACT
//   PURPOSE: Verify vvoc-managed agent prompt template loading, scoped runtime lookup, and correctness-obligation instruction contracts.
//   SCOPE: Bundled template reads, profile-neutral controller invariants, controller correctness leadership, bounded implementer impact investigation, evidence-based reviewer verdicts, investigator property reporting, primary/subagent metadata checks, scoped prompt resolution, and missing prompt failures.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/lib/managed-agents.ts, src/lib/vvoc-paths.ts]
//   LINKS: [M-CLI-MANAGED-AGENTS, V-M-CLI-MANAGED-AGENTS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   [test scenarios] - Managed prompt behavior is expressed through module-level tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-CORRECTNESS-OBLIGATIONS-PROMPTS - Added correctness-leadership, bounded impact investigation, material verification gap, evidential support, and violated-property coverage; superseded search-boundary and unconditional no-findings PASS directions.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANAGED_PRIMARY_AGENT_NAMES,
  getManagedAgentPromptPath,
  loadManagedAgentPromptTemplate,
  loadManagedAgentPromptText,
} from "./managed-agents.js";
import { getGlobalVvocDir, getProjectVvocDir, getVvocAgentsDir } from "./vvoc-paths.js";

describe("managed agent prompts", () => {
  test("loads bundled guardian template", async () => {
    const template = await loadManagedAgentPromptTemplate("guardian");
    expect(template).toStartWith("---\n");
    expect(template).toContain("mode: subagent");
    expect(template).toContain("hidden: true");
    expect(template).toContain("You are performing a risk assessment of a coding-agent tool call.");
  });

  test("loads bundled enhancer template", async () => {
    const template = await loadManagedAgentPromptTemplate("enhancer");
    expect(template).toStartWith("---\n");
    expect(template).toContain("mode: primary");
    expect(template).toContain("You are the enhancer agent.");
    expect(template).toContain("The final XML prompt must always be written in English.");
    expect(template).toContain("<task_type>");
    expect(template).toContain("<execution_mode>");
    expect(template).toContain("<constraint_1>");
    expect(template).toContain("<verification_check_1>");
    expect(template).toContain("<current_unknowns>");
    expect(template).toContain("<reroute_if>");
    expect(template).toContain("<project_overlays>");
    expect(template).toContain("Do not use repeated identical child tags.");
    expect(template).toContain("Reuse stable domain terms");
    expect(template).toContain(
      "Use only project overlays present in the request or upstream context",
    );
  });

  test("loads bundled vv-controller template with profile-neutral universal guidance", async () => {
    const template = await loadManagedAgentPromptTemplate("vv-controller");
    expect(template).toStartWith("---\n");
    expect(template).toContain("mode: primary");
    expect(template).toContain("You are the vv-controller primary agent.");
    expect(MANAGED_PRIMARY_AGENT_NAMES.filter((name) => name === "vv-controller")).toHaveLength(1);
    expect(template).toContain("<core_principles>");
    expect(template).toContain("<working_state>");
    expect(template).toContain("<assumption_discipline>");
    expect(template).toContain("<editing_workflow>");
    expect(template).toContain("<reroute_on_evidence>");
    expect(template).toContain("<skill_trigger_rule>");
    expect(template).toContain("<large_feature_gate>");
    expect(template).toContain("<hard_stop_handoff>");
    expect(template).toContain("<plan_artifacts>");
    expect(template).toContain("<final_response_format>");
    expect(template).toContain("Match the user's language");
    expect(template).toContain("concrete system work policy supplied for this session");
    expect(template).toContain("`vv-review` performs findings-only independent review");
    expect(template).toContain("`vv-execute` validates an approved plan");
    expect(template).toContain("follows the mode selected by the user");

    for (const inactivePolicyTerm of [
      "direct_change",
      "change_with_review",
      "explore",
      "investigator",
      "vv-implementer",
      "requiredReviewers",
      "VVOC_WORK_ITEM_ID",
      "work_item_open",
      "tracked_implementation_loop",
      "delegation_packet_convention",
    ]) {
      expect(template).not.toContain(inactivePolicyTerm);
    }
  });

  test("vv-controller template carries profile-neutral correctness leadership", async () => {
    const template = await loadManagedAgentPromptTemplate("vv-controller");
    const normalized = template.replace(/\s+/g, " ");

    expect(template).toContain("<correctness_leadership>");
    expect(normalized).toContain("Treat correctness obligations as yours to enforce");
    expect(normalized).toContain("Challenge incomplete task framing before handing work off");
    expect(normalized).toContain("material dependencies and at least one diagnostic scenario");
    expect(normalized).toContain(
      "distinguish no discovered defect from sufficient support for a material claim",
    );
    expect(normalized).toContain(
      "Tie substantive completion claims to observed evidence that actually exercises the changed behavior",
    );
  });

  test("loads bundled vv-implementer template with strict top-block protocol", async () => {
    const template = await loadManagedAgentPromptTemplate("vv-implementer");
    expect(template).toStartWith("---\n");
    expect(template).toContain("You are the vv-implementer subagent.");
    expect(template).toContain("VVOC_WORK_ITEM_ID: wi-1");
    expect(template).toContain("VVOC_STATUS: DONE");
    expect(template).toContain("VVOC_ROUTE: change_with_review");
    expect(template).toContain(
      "Allowed `VVOC_STATUS` values: `DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`",
    );
    expect(template).not.toContain("Status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED");
    expect(template).toContain("stabilize a compact working state");
    expect(template).toContain("project-owned overlays");
    expect(template).toContain("Prefer semantically meaningful identifiers");
    expect(template).toContain("Do not make silent material assumptions");
    expect(template).toContain("start from the provided file paths, line refs, symbols or scopes");
    expect(template).toContain("Treat a normalized finding packet as the starting map");
    expect(template).toContain("reviewer feedback becomes conflicting, ambiguous, or repetitive");
  });

  test("vv-implementer template permits bounded impact investigation inside bounded writes", async () => {
    const template = await loadManagedAgentPromptTemplate("vv-implementer");
    const normalized = template.replace(/\s+/g, " ");

    expect(template).not.toContain("Hyperfocus on the assigned scope.");
    expect(template).not.toContain(
      "Widen search only when the packet is incomplete, inconsistent, or contradicted by fresh evidence",
    );
    expect(normalized).toContain("Keep writes within the assigned scope");
    expect(normalized).toContain(
      "Investigating directly affected consumers — callers, variants, and contracts your change touches — is part of the task, not a scope violation",
    );
    expect(normalized).toContain("Bound investigation to impact, not to the packet");
    expect(normalized).toContain(
      "checking relevant neighboring variants of a confirmed defect when practical",
    );
    expect(normalized).toContain(
      "If the required fix crosses the assigned write scope, stop and report instead of widening writes",
    );
    expect(normalized).toContain(
      "Derive test expectations from the task contract, the request, and established behavior — never from your implementation's current output",
    );
    expect(normalized).toContain("Ground mocks in the dependency's established contract");
    expect(normalized).toContain(
      "Never use DONE_WITH_CONCERNS to hide an unverified condition of your fix",
    );
    expect(normalized).toContain("the smallest check that would verify it");
  });

  test("vv-implementer template carries the delegated worker contract", async () => {
    const template = await loadManagedAgentPromptTemplate("vv-implementer");
    expect(template).toContain("declares a write scope, edit only those files");
    expect(template).toContain(
      "complete your own local edit, test, and fix cycle before reporting",
    );
    expect(template).toContain("fix your own lint, type, and test failures first");
    expect(template).toContain("Returning DONE reports a completed attempt. It is not acceptance");
    expect(template).toContain("explicitly decides");
    expect(template).toContain("an attempt counter or rework authorization in the packet");
    expect(template).toContain("Reference evidence by path and command output");
  });

  test("reviewer templates judge pinned snapshots without claiming task acceptance", async () => {
    const specTemplate = await loadManagedAgentPromptTemplate("vv-spec-reviewer");
    const codeTemplate = await loadManagedAgentPromptTemplate("vv-code-reviewer");

    for (const template of [specTemplate, codeTemplate]) {
      expect(template).toContain("pins a review snapshot or covered scope");
      expect(template).toContain("not task acceptance");
      expect(template).not.toContain("accept the task");
    }
    expect(specTemplate).toContain("say so explicitly instead of guessing which revision to judge");
    expect(codeTemplate).toContain("instead of reviewing a moving tree");
  });

  test("loads bundled vv-reviewer templates with strict top-block protocol", async () => {
    const specTemplate = await loadManagedAgentPromptTemplate("vv-spec-reviewer");
    const codeTemplate = await loadManagedAgentPromptTemplate("vv-code-reviewer");

    expect(specTemplate).toContain("VVOC_WORK_ITEM_ID: wi-1");
    expect(specTemplate).toContain("VVOC_STATUS: PASS");
    expect(specTemplate).toContain("Allowed `VVOC_STATUS` values: `PASS | FAIL | NEEDS_CONTEXT`");
    expect(specTemplate).not.toContain("Status: PASS | FAIL | NEEDS_CONTEXT");
    expect(specTemplate).toContain("[Missing|Extra|Wrong|Unproven]");
    expect(specTemplate).toContain("tightest actionable location package available");
    expect(specTemplate).toContain("path:line (symbol/scope)");
    expect(specTemplate).toContain("expected fix direction");
    expect(specTemplate).toContain("project-owned overlays");
    expect(specTemplate).toContain("Reuse canonical repository terms");
    expect(specTemplate).toContain("unstated material assumption");

    expect(codeTemplate).toContain("VVOC_WORK_ITEM_ID: wi-1");
    expect(codeTemplate).toContain("VVOC_STATUS: PASS");
    expect(codeTemplate).toContain("Allowed `VVOC_STATUS` values: `PASS | FAIL | NEEDS_CONTEXT`");
    expect(codeTemplate).not.toContain("Status: PASS | FAIL | NEEDS_CONTEXT");
    expect(codeTemplate).toContain(
      "Review only issues introduced by this change or left unresolved by it.",
    );
    expect(codeTemplate).toContain("tightest actionable location package available");
    expect(codeTemplate).toContain("path:line (symbol/scope)");
    expect(codeTemplate).toContain("expected fix direction");
    expect(codeTemplate).toContain("project-owned overlays");
    expect(codeTemplate).toContain("Reuse canonical repository terms");
    expect(codeTemplate).toContain(
      "Treat route or process choices as findings only when they create a concrete engineering risk",
    );
    expect(codeTemplate).toContain("If a concern lacks a concrete failure mode");
  });

  test("code reviewer template binds verdicts to evidence and material verification gaps", async () => {
    const codeTemplate = await loadManagedAgentPromptTemplate("vv-code-reviewer");
    const normalized = codeTemplate.replace(/\s+/g, " ");

    expect(codeTemplate).not.toContain("If no issues are found, keep `VVOC_STATUS: PASS`");
    expect(normalized).toContain(
      "Reconstruct the expected properties independently from the request, contracts, and surrounding code",
    );
    expect(normalized).toContain(
      "Examine the consumers the change touches within the reviewed scope",
    );
    expect(normalized).toContain(
      "PASS requires no blocking findings and sufficient evidence for the material correctness claims in the reviewed scope",
    );
    expect(normalized).toContain("FAIL covers a concrete defect or a material verification gap");
    expect(normalized).toContain("no discovered defect is not proof of correctness");
    expect(normalized).toContain(
      "When context you need for a safe verdict is missing, use `VVOC_STATUS: NEEDS_CONTEXT` and state exactly what is missing",
    );
    expect(normalized).toContain(
      "a material verification gap is not a residual risk — report it as a Verification finding",
    );
    expect(normalized).toContain(
      "identifies the property at stake, why it is relevant, the evidence limitation, and the smallest useful check that would close it",
    );
    expect(normalized).toContain(
      "do not demand unspecified missing tests or require a duplicate full-suite run to state one",
    );
  });

  test("spec reviewer template separates compliance from evidential support", async () => {
    const specTemplate = await loadManagedAgentPromptTemplate("vv-spec-reviewer");
    const normalized = specTemplate.replace(/\s+/g, " ");

    expect(normalized).toContain("Distinguish compliance from evidential support");
    expect(normalized).toContain(
      "A compliant implementation with a material behavior left unverified is not a PASS",
    );
    expect(normalized).toContain("Never PASS while a material condition is labeled `Unproven`");
    expect(normalized).toContain(
      "correctness conditions the specification omitted but the requested behavior cannot hold without",
    );
    expect(normalized).toContain(
      "report them as findings for an explicit decision instead of inventing business requirements",
    );
  });

  test("loads bundled investigator template with investigation status protocol", async () => {
    const template = await loadManagedAgentPromptTemplate("investigator");
    const normalized = template.replace(/\s+/g, " ");

    expect(template).toContain("Status: REPRODUCED | PARTIAL | NOT_REPRODUCED | NEEDS_CONTEXT");
    expect(template).toContain("Recommended route:");
    expect(template).toContain("project-owned overlays");
    expect(template).toContain("Assumptions / missing evidence:");
    expect(template).toContain("Likely root cause:");
    expect(template).toContain("Next best step:");
    expect(normalized).toContain("Name the violated property explicitly");
    expect(normalized).toContain("Anchor the root cause in a supporting diagnostic scenario");
    expect(normalized).toContain(
      "report directly affected variants or consumers where the same root cause plausibly produces the same violation",
    );
    expect(normalized).toContain("Deliver these through the existing result structure");
  });

  test("prefers project managed prompt over global prompt", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-managed-prompt-home-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-managed-prompt-project-"));
    const previousConfigHome = process.env.XDG_CONFIG_HOME;

    try {
      process.env.XDG_CONFIG_HOME = configHome;

      const globalAgentsDir = getVvocAgentsDir(getGlobalVvocDir());
      const projectAgentsDir = getVvocAgentsDir(getProjectVvocDir(projectDir));
      await mkdir(globalAgentsDir, { recursive: true });
      await mkdir(projectAgentsDir, { recursive: true });
      await writeFile(
        getManagedAgentPromptPath(globalAgentsDir, "guardian"),
        "Global guardian prompt.\n",
        "utf8",
      );
      await writeFile(
        getManagedAgentPromptPath(projectAgentsDir, "guardian"),
        "Project guardian prompt.\n",
        "utf8",
      );

      expect(await loadManagedAgentPromptText(projectDir, "guardian")).toBe(
        "Project guardian prompt.\n",
      );
    } finally {
      if (previousConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousConfigHome;
      }
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("falls back to global managed prompt when project prompt is missing", async () => {
    const configHome = await mkdtemp(join(tmpdir(), "vvoc-managed-prompt-home-"));
    const projectDir = await mkdtemp(join(tmpdir(), "vvoc-managed-prompt-project-"));
    const previousConfigHome = process.env.XDG_CONFIG_HOME;

    try {
      process.env.XDG_CONFIG_HOME = configHome;

      const globalAgentsDir = getVvocAgentsDir(getGlobalVvocDir());
      await mkdir(globalAgentsDir, { recursive: true });
      await writeFile(
        getManagedAgentPromptPath(globalAgentsDir, "guardian"),
        "Global guardian prompt.\n",
      );

      expect(await loadManagedAgentPromptText(projectDir, "guardian")).toBe(
        "Global guardian prompt.\n",
      );
    } finally {
      if (previousConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousConfigHome;
      }
      await rm(configHome, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
