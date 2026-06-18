// FILE: src/plugins/workflow/transitions.ts
// VERSION: 0.3.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide deterministic workflow launch policy, reviewer role mapping, review-round aggregation, and loop-gate policy checks.
//   SCOPE: Record-aware launch allowance resolution, reviewer agent/role mapping, explicit review-round settlement checks, mode-specific aggregate state resolution, and implementation retry round-limit helpers.
//   DEPENDS: [src/plugins/workflow/protocol.ts, src/plugins/workflow/state.ts]
//   LINKS: [M-WORKFLOW-TRANSITIONS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   MAX_REVIEW_ROUNDS - Maximum allowed implementation review rounds before loop-gate block.
//   getReviewerRoleForAgent - Maps tracked reviewer subagent name to domain reviewer role.
//   getReviewerAgentForRole - Maps domain reviewer role to tracked reviewer subagent name.
//   getAllowedNextAgents - Returns tracked agents currently allowed for a work item.
//   isAllowedTransition - Checks whether launching a tracked agent is valid for a work item.
//   getAttemptedImplementationRound - Computes the implementation retry round for loop gating.
//   shouldBlockRound - Enforces loop-gate policy for implementation retry rounds.
//   hasNeedsContextResult - Checks whether a round already recorded NEEDS_CONTEXT.
//   isRoundSettled - Checks whether a review round can aggregate to a lifecycle state.
//   resolveCompletedRoundState - Resolves mode-specific lifecycle state for a settled review round.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.3.0 - Replaced sequential reviewer transitions with record-aware explicit review-round launch policy and mode-specific collect-all aggregation.]
//   LAST_CHANGE: [v0.2.0 - Allowed fresh work items to start with reviewer subagents for review-only workflows.]
//   LAST_CHANGE: [v0.1.0 - Added deterministic state transition policy, launch-allowance resolution, and review round-gate checks.]
// END_CHANGE_SUMMARY

import type { TrackedAgentName } from "./protocol.js";
import type {
  ReviewerAgentName,
  ReviewerRole,
  ReviewRound,
  WorkItemRecord,
  WorkItemState,
} from "./state.js";

export const MAX_REVIEW_ROUNDS = 2;

// START_CONTRACT: getReviewerRoleForAgent
//   PURPOSE: Map a tracked reviewer subagent to the stored domain reviewer role.
//   INPUTS: { agent: TrackedAgentName - tracked subagent name }
//   OUTPUTS: { ReviewerRole | undefined - reviewer role for reviewer subagents, undefined for implementer }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-TRANSITIONS, M-WORKFLOW-STATE]
// END_CONTRACT: getReviewerRoleForAgent
export function getReviewerRoleForAgent(agent: TrackedAgentName): ReviewerRole | undefined {
  if (agent === "vv-spec-reviewer") return "spec";
  if (agent === "vv-code-reviewer") return "code";
  return undefined;
}

// START_CONTRACT: getReviewerAgentForRole
//   PURPOSE: Map a domain reviewer role to the tracked reviewer subagent that satisfies it.
//   INPUTS: { role: ReviewerRole - domain reviewer role }
//   OUTPUTS: { ReviewerAgentName - tracked reviewer subagent }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-TRANSITIONS, M-WORKFLOW-STATE]
// END_CONTRACT: getReviewerAgentForRole
export function getReviewerAgentForRole(role: ReviewerRole): ReviewerAgentName {
  return role === "spec" ? "vv-spec-reviewer" : "vv-code-reviewer";
}

// START_CONTRACT: hasNeedsContextResult
//   PURPOSE: Check whether a review round already recorded a NEEDS_CONTEXT result.
//   INPUTS: { round: ReviewRound - current or completed review round }
//   OUTPUTS: { boolean - true when any reviewer result is NEEDS_CONTEXT }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-TRANSITIONS]
// END_CONTRACT: hasNeedsContextResult
export function hasNeedsContextResult(round: ReviewRound): boolean {
  return Object.values(round.results).some((result) => result?.status === "NEEDS_CONTEXT");
}

// START_CONTRACT: getAllowedNextAgents
//   PURPOSE: Resolve all tracked agents currently allowed to launch for a work item.
//   INPUTS: { record: WorkItemRecord - current work-item record }
//   OUTPUTS: { TrackedAgentName[] - allowed tracked agents, empty when none are allowed }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-TRANSITIONS]
// END_CONTRACT: getAllowedNextAgents
export function getAllowedNextAgents(record: WorkItemRecord): TrackedAgentName[] {
  if (
    record.mode === "implementation" &&
    (record.state === "open" || record.state === "awaiting_implementer")
  ) {
    return ["vv-implementer"];
  }

  if (
    record.state !== "awaiting_reviews" ||
    !record.currentRound ||
    record.currentRound.status !== "active"
  ) {
    return [];
  }

  if (hasNeedsContextResult(record.currentRound)) {
    return [];
  }

  return record.currentRound.pendingReviewers.map(getReviewerAgentForRole);
}

// START_CONTRACT: isAllowedTransition
//   PURPOSE: Check whether launching a tracked agent is valid for the current work-item record.
//   INPUTS: { record: WorkItemRecord - current work-item record, agent: TrackedAgentName - requested tracked subagent }
//   OUTPUTS: { boolean - true when launch is currently allowed }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-TRANSITIONS]
// END_CONTRACT: isAllowedTransition
export function isAllowedTransition(record: WorkItemRecord, agent: TrackedAgentName): boolean {
  return getAllowedNextAgents(record).includes(agent);
}

// START_CONTRACT: getAttemptedImplementationRound
//   PURPOSE: Compute the implementation retry round that would be entered by launching vv-implementer now.
//   INPUTS: { record: WorkItemRecord - current work item }
//   OUTPUTS: { number - attempted implementation round }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-TRANSITIONS]
// END_CONTRACT: getAttemptedImplementationRound
export function getAttemptedImplementationRound(record: WorkItemRecord): number {
  return record.completedReviewRoundCount + 1;
}

// START_CONTRACT: isRoundSettled
//   PURPOSE: Determine whether a review round can aggregate to a lifecycle state.
//   INPUTS: { round: ReviewRound - current review round }
//   OUTPUTS: { boolean - true when no in-flight result can still change aggregation timing }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-TRANSITIONS]
// END_CONTRACT: isRoundSettled
export function isRoundSettled(round: ReviewRound): boolean {
  if (round.inFlightReviewers.length > 0) return false;
  if (hasNeedsContextResult(round)) return true;
  return round.pendingReviewers.length === 0;
}

// START_CONTRACT: resolveCompletedRoundState
//   PURPOSE: Resolve the lifecycle state for a settled review round using mode-specific aggregation rules.
//   INPUTS: { record: WorkItemRecord - owning work item, round: ReviewRound - settled review round }
//   OUTPUTS: { WorkItemState - next lifecycle state }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-TRANSITIONS]
// END_CONTRACT: resolveCompletedRoundState
export function resolveCompletedRoundState(
  record: WorkItemRecord,
  round: ReviewRound,
): WorkItemState {
  if (hasNeedsContextResult(round)) return "needs_context";
  const allPass = round.requiredReviewers.every(
    (reviewer) => round.results[reviewer]?.status === "PASS",
  );
  if (allPass) return "ready_to_close";
  return record.mode === "review_only" ? "ready_to_close" : "awaiting_implementer";
}

// START_CONTRACT: shouldBlockRound
//   PURPOSE: Enforce loop-gate policy by rejecting implementation rounds above MAX_REVIEW_ROUNDS.
//   INPUTS: { reviewRound: number - attempted implementation round }
//   OUTPUTS: { boolean - true when launch must be blocked }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-TRANSITIONS]
// END_CONTRACT: shouldBlockRound
// START_BLOCK_CHECK_ROUND_LIMIT
export function shouldBlockRound(reviewRound: number): boolean {
  return reviewRound > MAX_REVIEW_ROUNDS;
}
// END_BLOCK_CHECK_ROUND_LIMIT
