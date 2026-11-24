// FILE: src/lib/orchestration.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Define the legacy orchestration profile vocabulary, strict recorded-value parsing, and the frozen vv-controller work policies used only by families that already recorded a profile.
//   SCOPE: Legacy profile names and types, strict recorded-value validation, and pure recorded-profile policy resolution. No CLI, config, preset, or absent-section default remains.
//   DEPENDS: [none]
//   LINKS: [M-ORCHESTRATION-PROFILES, V-M-ORCHESTRATION-PROFILES]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ORCHESTRATION_PROFILE_NAMES - Legacy recorded profile names in stable order.
//   OrchestrationProfile - Union of legacy recorded profile names.
//   ResolvedOrchestrationPolicy - Concrete legacy controller and workflow guidance for one recorded profile.
//   parseOrchestrationProfile - Strictly validates a recorded profile value with operation context.
//   policyForRecordedProfile - Resolves the frozen legacy policy for one recorded family profile, or none.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-REMOVE-SESSION-ORCHESTRATION-PROFILES T-002 - Removed config construction, absent-section defaults, and config-driven policy resolution; only recorded-profile decoding and frozen legacy policies remain.]
// END_CHANGE_SUMMARY

// START_BLOCK_PROFILE_TYPES
/** Supported orchestration profiles in stable CLI/schema order. */
export const ORCHESTRATION_PROFILE_NAMES = [
  "single-session",
  "balanced",
  "orchestrated",
  "delegated",
] as const;

/** One supported legacy-recorded orchestration profile. */
export type OrchestrationProfile = (typeof ORCHESTRATION_PROFILE_NAMES)[number];

/** Capabilities consumed by prompt-producing plugins without model inference. */
export type ResolvedOrchestrationPolicy = Readonly<{
  profile: OrchestrationProfile;
  controllerSystemContext: string;
  workflowGuidance: "review-only" | "selective" | "tracked" | "delegated";
}>;
// END_BLOCK_PROFILE_TYPES

// START_BLOCK_CONCRETE_POLICIES
const SINGLE_SESSION_CONTROLLER_SYSTEM_CONTEXT = `
Work directly in the current session. Perform repository exploration, investigation, planning,
implementation, and verification yourself. Do not delegate working context to subagents.

Independent reviewer subagents remain permitted when the user explicitly requests review or when
a materially risky completed change benefits from independent evaluation. Use one review round by
default, validate every finding personally, apply confirmed fixes yourself during active
implementation, and run fresh verification. For review-only requests, report findings and do not
fix them without subsequent user confirmation.
`.trim();

const BALANCED_CONTROLLER_SYSTEM_CONTEXT = `
Keep architecture, critical code reading, material decisions, and final synthesis in the primary
session. You may selectively delegate bounded repository search, isolated investigation,
mechanical implementation, or independent review when that is the lightest safe route. Delegation
is optional rather than mechanically mandatory, and automatic reviewer loops are not used.
`.trim();

const ORCHESTRATED_CONTROLLER_SYSTEM_CONTEXT = `
Use the full tracked implementation and review workflow for non-trivial changes. Open explicit work
items, dispatch implementers with complete task packets, collect all required reviewer results,
respect bounded review rounds, and treat BLOCKED and NEEDS_CONTEXT as hard stops. Keep work-item
identity stable through implementation, review, verification, and close.
`.trim();

const DELEGATED_CONTROLLER_SYSTEM_CONTEXT = `
Keep architecture, important code reading, task contracts, acceptance decisions, and final
synthesis in this primary session. Delegate source implementation, tests, runtime configuration
changes, formatting, lint fixes, and reviewer-requested implementation changes to implementation
workers, including small mechanical fixes.

You may author specifications, plans, and explicitly requested planning artifacts under their
existing approval lifecycle, and you may execute verification commands, including commands that
produce ordinary generated verification or build outputs. Do not write complete implementation
bodies inside task packets and do not bypass the delegation policy by rewriting source through
shell commands. Requirements may come from the supported approved native spec/plan package under
.vvoc/specs/, a provided plan reference, or the current conversation: work_checkpoint register
accepts only its supported approved native package, while a provided plan or conversation-scoped
run registers through work_item_open with an execution descriptor and keeps its own source rather
than being converted into a native package.

Send each worker one bounded task packet and let it complete its local edit, test, and fix cycle
before reporting a concise result with evidence references. One active implementation worker is the
default; any parallel work requires explicitly disjoint approved scopes. Read the material changed
code and evidence yourself, then explicitly accept each completed attempt or request changes with
bounded rationale. Spend independent review at declared plan checkpoints instead of after every
task, and treat BLOCKED and NEEDS_CONTEXT as hard stops: diagnose a stopped or exhausted task
yourself and recover it through the session's supported recovery operation — bounded, one unit per
grant, never an unlimited retry and never a substitute for acceptance or review. After the ordinary
allowances are exhausted, a recorded advance authority from an explicit user instruction may
fund a finite continuation; it never becomes acceptance or a passing review. A stop suspends that
work item; it does not end the session.
`.trim();

const RESOLVED_POLICIES: Readonly<Record<OrchestrationProfile, ResolvedOrchestrationPolicy>> =
  Object.freeze({
    "single-session": Object.freeze({
      profile: "single-session",
      controllerSystemContext: SINGLE_SESSION_CONTROLLER_SYSTEM_CONTEXT,
      workflowGuidance: "review-only",
    }),
    balanced: Object.freeze({
      profile: "balanced",
      controllerSystemContext: BALANCED_CONTROLLER_SYSTEM_CONTEXT,
      workflowGuidance: "selective",
    }),
    orchestrated: Object.freeze({
      profile: "orchestrated",
      controllerSystemContext: ORCHESTRATED_CONTROLLER_SYSTEM_CONTEXT,
      workflowGuidance: "tracked",
    }),
    delegated: Object.freeze({
      profile: "delegated",
      controllerSystemContext: DELEGATED_CONTROLLER_SYSTEM_CONTEXT,
      workflowGuidance: "delegated",
    }),
  });
// END_BLOCK_CONCRETE_POLICIES

// START_CONTRACT: parseOrchestrationProfile
//   PURPOSE: Validate one recorded legacy profile value without silently falling back from invalid input.
//   INPUTS: { value: unknown - candidate recorded profile value; operation: string - caller context for diagnostics }
//   OUTPUTS: { OrchestrationProfile - normalized supported profile }
//   SIDE_EFFECTS: Throws Error for blank, non-string, or unknown values.
//   LINKS: [ORCHESTRATION_PROFILE_NAMES]
// END_CONTRACT: parseOrchestrationProfile
// START_BLOCK_PARSE_PROFILE
export function parseOrchestrationProfile(value: unknown, operation: string): OrchestrationProfile {
  const normalized = typeof value === "string" ? value.trim() : "";
  if ((ORCHESTRATION_PROFILE_NAMES as readonly string[]).includes(normalized)) {
    return normalized as OrchestrationProfile;
  }

  const rendered = typeof value === "string" ? JSON.stringify(value) : String(value);
  throw new Error(
    `${operation}: invalid orchestration profile ${rendered}; expected one of: ${ORCHESTRATION_PROFILE_NAMES.join(", ")}`,
  );
}
// END_BLOCK_PARSE_PROFILE

// START_CONTRACT: policyForRecordedProfile
//   PURPOSE: Resolve the frozen legacy policy for one recorded family profile, or none for a record without one.
//   INPUTS: { profile: OrchestrationProfile | undefined - profile recorded on the family root, when present }
//   OUTPUTS: { ResolvedOrchestrationPolicy | undefined - frozen policy for a recorded profile; undefined without one }
//   SIDE_EFFECTS: [none]
//   LINKS: [RESOLVED_POLICIES]
// END_CONTRACT: policyForRecordedProfile
// START_BLOCK_RECORDED_POLICY
export function policyForRecordedProfile(
  profile: OrchestrationProfile | undefined,
): ResolvedOrchestrationPolicy | undefined {
  return profile === undefined ? undefined : RESOLVED_POLICIES[profile];
}
// END_BLOCK_RECORDED_POLICY
