// FILE: src/lib/orchestration.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Define orchestration profile names, strict parsing, backward-compatible defaults, and concrete vv-controller work policies.
//   SCOPE: Profile types, normalized config construction, explicit-value validation, and pure startup policy resolution.
//   DEPENDS: [none]
//   LINKS: [M-ORCHESTRATION-PROFILES, V-M-ORCHESTRATION-PROFILES]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ORCHESTRATION_PROFILE_NAMES - Supported profile names in stable CLI and schema order.
//   OrchestrationProfile - Union of supported profile names.
//   OrchestrationConfig - Canonical orchestration configuration section.
//   ResolvedOrchestrationPolicy - Concrete controller and workflow guidance selected at startup.
//   DEFAULT_ORCHESTRATION_PROFILE - Backward-compatible profile for an absent root section.
//   createOrchestrationConfig - Builds a normalized section and defaults only when the section is absent.
//   parseOrchestrationProfile - Strictly validates a profile value with operation context.
//   resolveOrchestrationPolicy - Resolves one immutable concrete policy from compatible config input.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-PRESET-ORCHESTRATION-PROFILES - Added the profile domain and concrete prompt policies without depending on VvocConfig.]
// END_CHANGE_SUMMARY

// START_BLOCK_PROFILE_TYPES
/** Supported orchestration profiles in stable CLI/schema order. */
export const ORCHESTRATION_PROFILE_NAMES = ["single-session", "balanced", "orchestrated"] as const;

/** One supported preset-controlled orchestration profile. */
export type OrchestrationProfile = (typeof ORCHESTRATION_PROFILE_NAMES)[number];

/** Optional canonical vvoc configuration section. */
export type OrchestrationConfig = {
  profile: OrchestrationProfile;
};

/** Capabilities consumed by prompt-producing plugins without model inference. */
export type ResolvedOrchestrationPolicy = Readonly<{
  profile: OrchestrationProfile;
  controllerSystemContext: string;
  workflowGuidance: "review-only" | "selective" | "tracked";
}>;

/** Backward-compatible profile used when an old valid v3 document omits orchestration. */
export const DEFAULT_ORCHESTRATION_PROFILE: OrchestrationProfile = "balanced";
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
  });
// END_BLOCK_CONCRETE_POLICIES

// START_BLOCK_PROFILE_PARSING
// START_CONTRACT: parseOrchestrationProfile
//   PURPOSE: Validate a CLI or config profile string without silently falling back from explicit invalid input.
//   INPUTS: { value: unknown - candidate profile value; operation: string - caller context for diagnostics }
//   OUTPUTS: { OrchestrationProfile - normalized supported profile }
//   SIDE_EFFECTS: Throws Error for blank, non-string, or unknown values.
//   LINKS: [ORCHESTRATION_PROFILE_NAMES]
// END_CONTRACT: parseOrchestrationProfile
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

// START_CONTRACT: createOrchestrationConfig
//   PURPOSE: Build a normalized orchestration section, defaulting only when the entire section is absent.
//   INPUTS: { value: Partial&lt;OrchestrationConfig&gt; | undefined - optional explicit section }
//   OUTPUTS: { OrchestrationConfig - normalized canonical section }
//   SIDE_EFFECTS: Throws when an explicit section lacks a valid profile.
//   LINKS: [parseOrchestrationProfile]
// END_CONTRACT: createOrchestrationConfig
export function createOrchestrationConfig(
  value?: Partial<OrchestrationConfig>,
): OrchestrationConfig {
  if (value === undefined) {
    return { profile: DEFAULT_ORCHESTRATION_PROFILE };
  }

  return {
    profile: parseOrchestrationProfile(value.profile, "create orchestration config"),
  };
}
// END_BLOCK_PROFILE_PARSING

// START_BLOCK_POLICY_RESOLUTION
// START_CONTRACT: resolveOrchestrationPolicy
//   PURPOSE: Resolve one immutable concrete policy from structurally compatible startup config input.
//   INPUTS: { config: object - loaded config with an optional orchestration section }
//   OUTPUTS: { ResolvedOrchestrationPolicy - frozen selected policy }
//   SIDE_EFFECTS: Throws when an explicit profile is invalid; never inspects provider or model data.
//   LINKS: [createOrchestrationConfig, RESOLVED_POLICIES]
// END_CONTRACT: resolveOrchestrationPolicy
export function resolveOrchestrationPolicy(config: {
  orchestration?: Partial<OrchestrationConfig>;
}): ResolvedOrchestrationPolicy {
  const { profile } = createOrchestrationConfig(config.orchestration);
  return RESOLVED_POLICIES[profile];
}
// END_BLOCK_POLICY_RESOLUTION
