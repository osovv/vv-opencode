// FILE: src/lib/managed-agents.test.ts
// VERSION: 0.8.0
// START_MODULE_CONTRACT
//   PURPOSE: Verify vvoc-managed agent prompt template loading, scoped runtime lookup, and correctness-obligation instruction contracts.
//   SCOPE: Bundled template reads, the complete canonical seven-section controller with preserved memory, verification, delegation, authority, recovery and handoff obligations; absence of superseded prompt sections and duplicated skill/artifact manuals; existing worker/reviewer/investigator contracts, metadata, protocol examples, scoped lookup and missing-prompt errors.
//   DEPENDS: [bun:test, node:fs/promises, node:os, node:path, src/lib/managed-agents.ts, src/lib/vvoc-paths.ts, src/plugins/workflow/protocol.ts]
//   LINKS: [M-CLI-MANAGED-AGENTS, M-WORKFLOW-PROTOCOL, V-M-CLI-MANAGED-AGENTS]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   PROTOCOL_EXAMPLE_ID - Non-wi-1 work-item id used by the shipped protocol example fixtures.
//   extractProtocolExample - Extracts one shipped agent result-protocol example and its top-block fields.
//   [test scenarios] - Managed prompt behavior is expressed through module-level tests.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [DIRECT-FIX - Pin the approved consolidated controller requirements and native skill/artifact ownership while retaining worker and lookup regression coverage.]
// END_CHANGE_SUMMARY

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MANAGED_PRIMARY_AGENT_NAMES,
  getManagedAgentPromptPath,
  loadManagedAgentPromptTemplate,
  loadManagedAgentPromptText,
} from "./managed-agents.js";
import { loadManagedSkillReference } from "./managed-skills.js";
import { installManagedSkillFiles, syncManagedSkillFiles } from "./opencode/agent-registrations.js";
import type { ResolvedPaths } from "./opencode/paths.js";
import { getGlobalVvocDir, getProjectVvocDir, getVvocAgentsDir } from "./vvoc-paths.js";
import {
  parseResultBlock,
  parseWorkItemHeader,
  describeStatusVocabulary,
} from "../plugins/workflow/protocol.js";

/** Assigned-id sample used by shipped examples; distinct from the first item `wi-1`. */
const PROTOCOL_EXAMPLE_ID = "wi-7";

/**
 * Extract one shipped result-protocol example: its strict top-block fields and
 * the first body line after the required blank-line separator. Throws when the
 * template no longer contains a parseable example, so template edits must keep
 * the example real.
 */
function extractProtocolExample(
  template: string,
  expectedId: string,
): { output: string; topBlockFields: string[] } {
  const lines = template.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => line.trim() === `VVOC_WORK_ITEM_ID: ${expectedId}`);
  if (start < 0) {
    throw new Error(`agent template has no VVOC_WORK_ITEM_ID: ${expectedId} example`);
  }

  const topBlockFields: string[] = [];
  let index = start;
  for (; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? "").trim();
    if (!/^([A-Z_]+)\s*:/.test(trimmed)) break;
    topBlockFields.push(trimmed);
  }
  if ((lines[index] ?? "").trim() !== "") {
    throw new Error("protocol example is missing its blank-line body separator");
  }

  const body = (lines[index + 1] ?? "").trim();
  if (body === "") {
    throw new Error("protocol example is missing a body line");
  }

  return { output: `${topBlockFields.join("\n")}\n\n${body}`, topBlockFields };
}

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
    expect(template).toContain(
      "You are vv-controller, a coding agent responsible for the user's requested outcome.",
    );
    expect(MANAGED_PRIMARY_AGENT_NAMES.filter((name) => name === "vv-controller")).toHaveLength(1);
    expect([...template.matchAll(/^<([a-z_]+)>$/gm)].map((match) => match[1])).toEqual([
      "task_and_scope",
      "project_context",
      "repository_memory",
      "evidence_discipline",
      "working_cycle",
      "delegation_and_workflow",
      "communication",
    ]);
    const normalized = template.replace(/\s+/g, " ");
    expect(normalized).toContain("Use the user's language in replies");
    expect(normalized).toContain(
      "Keep system-level prompts and workflow artifacts in English unless their owning format requires otherwise",
    );
    expect(normalized).toContain("Follow the concrete work policy supplied for this session");
    expect(normalized).toContain(
      "For questions, reviews, investigations, and planning requests, present the requested findings or plan",
    );
    expect(normalized).toContain("Proceed to implementation when authorized by the user");
    for (const retired of [
      "core_principles",
      "working_state",
      "assumption_discipline",
      "editing_workflow",
      "reroute_on_evidence",
      "skill_trigger_rule",
      "source_and_authority",
      "stop_and_recovery",
      "plan_artifacts",
      "final_response_format",
      "task",
    ]) {
      expect(template).not.toContain(`<${retired}>`);
    }
    expect(template).not.toContain(".vvoc/specs/");
    expect(template).not.toContain("`vv-spec`");

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

  test("vv-controller template distinguishes stops, recovery, and completion without automatic handoff files", async () => {
    const template = await loadManagedAgentPromptTemplate("vv-controller");
    const normalized = template.replace(/\s+/g, " ");

    // The automatic blocker-to-handoff-file ritual is gone.
    expect(template).not.toContain("<hard_stop_handoff>");
    expect(template).not.toContain("leave a compact handoff");

    expect(normalized).toContain(
      "A worker stop or exhausted loop returns control to the controller for diagnosis; it does not itself end the session",
    );
    expect(normalized).toContain(
      "Do not redispatch an unchanged stopped item or grant unlimited retries",
    );
    expect(normalized).toContain("it is not acceptance, a passing review, or completion");
    expect(normalized).toContain(
      "Write a handoff file only when the user requests a transfer or the session genuinely ends",
    );
    expect(normalized).toContain(
      "Resolve repository-answerable technical questions from code, contracts, tests, and documentation yourself",
    );
    expect(normalized).toContain("ask the user for genuine business-semantics decisions");
  });

  test("vv-controller template carries profile-neutral correctness leadership", async () => {
    const template = await loadManagedAgentPromptTemplate("vv-controller");
    const normalized = template.replace(/\s+/g, " ");

    expect(template).toContain("<delegation_and_workflow>");
    expect(normalized).toContain("Own the correctness of delegated work");
    expect(normalized).toContain(
      "Before dispatch, resolve missing consumer-visible acceptance criteria",
    );
    expect(normalized).toContain(
      "Give each bounded task its material dependencies and at least one diagnostic scenario",
    );
    expect(normalized).toContain(
      "absence of discovered defects alone does not establish acceptance",
    );
    expect(normalized).toContain(
      "Support substantive completion claims with observed evidence that exercises the behavior at risk",
    );
  });

  test("vv-controller template keeps supported conclusions and separates pressure from evidence", async () => {
    const template = await loadManagedAgentPromptTemplate("vv-controller");
    const normalized = template.replace(/\s+/g, " ");

    expect(normalized).toContain("Surface false premises and investigate the actual mechanism");
    expect(normalized).toContain("Vague doubt or unsupported pressure alone is not a trigger");
    expect(normalized).toContain(
      "briefly explain the supported conclusion and ask for a specific discrepancy when needed",
    );
    expect(normalized).toContain(
      "Handle explicit user changes in requirements through the applicable scope and approval process",
    );
    expect(normalized).toContain("Reopen supported conclusions on concrete evidence");
    expect(normalized).toContain("An unchecked claim is not settled");
    expect(normalized).toContain(
      "Once the required checks support the material claims for the current files and inputs, proceed",
    );
    expect(normalized).toContain(
      "Treat test results as evidence against the request and contracts",
    );
    expect(normalized).toContain(
      "Preserve required fresh verification, independent review, and explicit acceptance",
    );
    expect(normalized).toContain(
      "Surface a failing test that contradicts the agreed contract as a discrepancy before deciding whether the implementation or tests should change",
    );

    // No blanket bans on apologizing or agreeing, and no mandatory per-claim rituals.
    for (const banned of ["Never apologize", "Do not agree", "Mark each claim"]) {
      expect(template).not.toContain(banned);
    }
    expect(template).not.toContain("restate the requirement in one line in your own words");
  });

  test("controller retains repository memory, bounded authority and acceptance distinctions", async () => {
    const template = await loadManagedAgentPromptTemplate("vv-controller");
    const normalized = template.replace(/\s+/g, " ");
    for (const obligation of [
      ".vvoc/lessons/index.xml",
      ".vvoc/runbooks/index.xml",
      "Load only entries whose summary or applicability matches the task",
      "Treat lessons and runbooks as advisory memory",
      "vv-reflect skill to propose durable lessons or runbooks",
      "Do not invent a native package or second lifecycle for a provided plan or conversation-scoped request",
      "Do not impose a universal final-review pair",
      "finite shared reserve",
      "only after ordinary allowances are exhausted",
      "Respect reserved stops, host permissions, and destructive, publication, or credential-operation boundaries",
      "BLOCKED and NEEDS_CONTEXT suspend the affected work",
      "Report completion as controller-accepted when no independent review was assigned",
      "independently reviewed only after every registered review obligation passes for the current result",
      "two major strategy changes for the same task, two review rounds without convergence",
      "challenge at least one material assumption with a diagnostic counterexample",
      "Distinguish write scope, impact scope, and verification scope",
      "reconcile the result with every part of the request",
    ])
      expect(normalized).toContain(obligation);
  });

  test("loads bundled vv-implementer template with strict top-block protocol", async () => {
    const template = await loadManagedAgentPromptTemplate("vv-implementer");
    expect(template).toStartWith("---\n");
    expect(template).toContain("You are the vv-implementer subagent.");
    expect(template).toContain(`VVOC_WORK_ITEM_ID: ${PROTOCOL_EXAMPLE_ID}`);
    expect(template).toContain("VVOC_STATUS: DONE");
    expect(template).toContain("VVOC_ROUTE: change_with_review");
    expect(template).toContain(
      "Allowed `VVOC_STATUS` values: `DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED`",
    );
    expect(template).not.toContain("VVOC_WORK_ITEM_ID: wi-1");
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

  test("vv-implementer template settles evidence and routes false premises and conflicting findings", async () => {
    const template = await loadManagedAgentPromptTemplate("vv-implementer");
    const normalized = template.replace(/\s+/g, " ");

    expect(normalized).toContain(
      "Treat a conclusion as settled while its supporting evidence and inputs remain valid",
    );
    expect(normalized).toContain(
      "Vague doubt or unsupported pressure is not itself a reason to flip or restart",
    );
    expect(normalized).toContain(
      "Once the required checks substantiate the material claims for the current files and inputs, move forward",
    );
    expect(normalized).toContain(
      "interpret test results against the task and contract rather than treating them as the authoritative specification",
    );
    expect(normalized).toContain(
      "a failing test that contradicts the agreed contract is a discrepancy to surface, not an automatic reason to rewrite code or tests",
    );
    expect(normalized).toContain(
      "Evaluate each concrete reviewer finding against the task contract before changing anything",
    );
    expect(normalized).toContain(
      "Conflicting or mutually exclusive findings return to the controller with the conflict stated",
    );
    expect(normalized).toContain("When the request assumes something that does not exist");
    expect(normalized).toContain(
      "never silently substitute the goal or add an unnecessary dependency to make the premise true",
    );

    // No blanket bans on apologizing or agreeing, and no mandatory per-claim rituals.
    for (const banned of ["Never apologize", "Do not agree", "Mark each claim"]) {
      expect(template).not.toContain(banned);
    }
    expect(template).not.toContain("restate the requirement in one line in your own words");
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
    expect(template.replace(/\s+/g, " ")).toContain(
      "A stop is about this assignment, not the end of the session",
    );
  });

  test("reviewer templates distinguish initial review from scoped re-review", async () => {
    const specTemplate = await loadManagedAgentPromptTemplate("vv-spec-reviewer");
    const codeTemplate = await loadManagedAgentPromptTemplate("vv-code-reviewer");

    for (const template of [specTemplate, codeTemplate]) {
      const normalized = template.replace(/\s+/g, " ");
      expect(normalized).toContain("Distinguish an initial review from a scoped re-review");
      expect(normalized).toContain("effects the fix itself could have caused");
      expect(normalized).toContain("directly affected consumers where necessary");
      expect(normalized).toContain(
        "unrelated optional improvements observed during a re-review do not renew the correction loop",
      );
      expect(normalized).toContain("never downgraded merely to finish");
    }
    expect(specTemplate.replace(/\s+/g, " ")).toContain(
      "first confirm each prior finding is actually resolved",
    );
    expect(codeTemplate.replace(/\s+/g, " ")).toContain(
      "first verify each prior finding against the fix",
    );
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

    expect(specTemplate).toContain(`VVOC_WORK_ITEM_ID: ${PROTOCOL_EXAMPLE_ID}`);
    expect(specTemplate).toContain("VVOC_STATUS: PASS");
    expect(specTemplate).toContain("Allowed `VVOC_STATUS` values: `PASS | FAIL | NEEDS_CONTEXT`");
    expect(specTemplate).not.toContain("VVOC_WORK_ITEM_ID: wi-1");
    expect(specTemplate).not.toContain("Status: PASS | FAIL | NEEDS_CONTEXT");
    expect(specTemplate).toContain("[Missing|Extra|Wrong|Unproven]");
    expect(specTemplate).toContain("tightest actionable location package available");
    expect(specTemplate).toContain("path:line (symbol/scope)");
    expect(specTemplate).toContain("expected fix direction");
    expect(specTemplate).toContain("project-owned overlays");
    expect(specTemplate).toContain("Reuse canonical repository terms");
    expect(specTemplate).toContain("unstated material assumption");

    expect(codeTemplate).toContain(`VVOC_WORK_ITEM_ID: ${PROTOCOL_EXAMPLE_ID}`);
    expect(codeTemplate).toContain("VVOC_STATUS: PASS");
    expect(codeTemplate).toContain("Allowed `VVOC_STATUS` values: `PASS | FAIL | NEEDS_CONTEXT`");
    expect(codeTemplate).not.toContain("VVOC_WORK_ITEM_ID: wi-1");
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

  test("shipped agent protocol examples parse for every role terminal status", async () => {
    const cases = [
      {
        agent: "vv-implementer",
        statuses: ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"],
        routeRequired: true,
      },
      {
        agent: "vv-spec-reviewer",
        statuses: ["PASS", "FAIL", "NEEDS_CONTEXT"],
        routeRequired: false,
      },
      {
        agent: "vv-code-reviewer",
        statuses: ["PASS", "FAIL", "NEEDS_CONTEXT"],
        routeRequired: false,
      },
    ] as const;

    for (const testCase of cases) {
      const template = await loadManagedAgentPromptTemplate(testCase.agent);
      // The reusable `wi-1` sample from the first opened item must not survive.
      expect(template).not.toContain("VVOC_WORK_ITEM_ID: wi-1");

      const { output, topBlockFields } = extractProtocolExample(template, PROTOCOL_EXAMPLE_ID);
      const parsed = parseResultBlock({
        agent: testCase.agent,
        output,
        expectedWorkItemId: PROTOCOL_EXAMPLE_ID,
      });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value.workItemId).toBe(PROTOCOL_EXAMPLE_ID);
      expect(parsed.value.body.length).toBeGreaterThan(0);
      expect(parsed.value.route !== undefined).toBe(testCase.routeRequired);
      expect(topBlockFields).toHaveLength(testCase.routeRequired ? 3 : 2);

      const header = parseWorkItemHeader(
        `VVOC_WORK_ITEM_ID: ${PROTOCOL_EXAMPLE_ID}\n<assignment/>`,
      );
      expect(header.ok).toBe(true);
      if (header.ok) expect(header.value).toBe(PROTOCOL_EXAMPLE_ID);

      for (const status of testCase.statuses) {
        expect(template).toContain(status);
      }
      // The shipped vocabulary is exactly the parser's vocabulary, not a hand-typed copy.
      expect(template).toContain(describeStatusVocabulary(testCase.agent));
      expect(template).toContain("no preface");
      expect(template).toContain("blank line before the body");
      expect(template).toContain("from the top of your assignment");
      expect(template).not.toContain("returned by `work_item_open`");
    }
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

  test("loads bundled vv-reflector template with read-only subagent-tree contract", async () => {
    const template = await loadManagedAgentPromptTemplate("vv-reflector");
    const normalized = template.replace(/\s+/g, " ");

    expect(template).toContain("You are the vv-reflector subagent");
    expect(normalized).toContain("read-only analyst");
    expect(normalized).toContain("session and its subagent tree");
    expect(normalized).toContain("session-graph.py");
    expect(normalized).toContain("Read-only. Never edit, write, or run mutating commands.");
    expect(normalized).toContain("Never spawn a subagent.");
    expect(normalized).toContain("Return at most ten proposals");
    expect(normalized).toContain("Return only the proposal list");
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

describe("managed skill reference installation", () => {
  /** Minimal resolved-paths view: only managedSkillsDirPath is consumed by the skill installers. */
  function skillsPaths(managedSkillsDirPath: string): ResolvedPaths {
    return { managedSkillsDirPath } as unknown as ResolvedPaths;
  }

  test("installManagedSkillFiles copies the vv-execute tool-contracts reference into a temp scope", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vvoc-managed-tool-contracts-"));
    try {
      const results = await installManagedSkillFiles(skillsPaths(dir), { force: false });
      const copied = join(dir, "vv-execute", "references", "tool-contracts.md");
      expect(existsSync(copied)).toBe(true);
      expect(results.find((result) => result.path === copied)?.action).toBe("created");
      expect(await readFile(copied, "utf8")).toBe(
        await loadManagedSkillReference("vv-execute", "tool-contracts.md"),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("syncManagedSkillFiles keeps an up-to-date copied reference", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vvoc-managed-tool-contracts-sync-"));
    try {
      await installManagedSkillFiles(skillsPaths(dir), { force: false });
      const copied = join(dir, "vv-execute", "references", "tool-contracts.md");
      const synced = await syncManagedSkillFiles(skillsPaths(dir), { force: true });
      expect(synced.find((result) => result.path === copied)?.action).toBe("kept");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
