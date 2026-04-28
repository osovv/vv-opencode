// FILE: src/plugins/workflow/transitions.ts
// VERSION: 0.2.0
// START_MODULE_CONTRACT
//   PURPOSE: Provide deterministic workflow transition rules, allowed-next-agent resolution, and loop-gate policy checks.
//   SCOPE: Work-item state transition mapping from tracked results, launch permission checks by state, and review-round limit checks.
//   DEPENDS: [src/plugins/workflow/protocol.ts, src/plugins/workflow/state.ts]
//   LINKS: [M-WORKFLOW-TRANSITIONS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   MAX_REVIEW_ROUNDS - Maximum allowed review rounds before loop-gate block.
//   getNextState - Computes next work-item state from tracked agent result.
//   getAllowedNextAgent - Resolves the only allowed tracked agent for a state.
//   isAllowedTransition - Checks whether launching an agent from current state is allowed.
//   shouldBlockRound - Enforces loop-gate policy for review rounds.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.2.0 - Allowed fresh work items to start with reviewer subagents for review-only workflows.]
//   LAST_CHANGE: [v0.1.0 - Added deterministic state transition policy, launch-allowance resolution, and review round-gate checks.]
// END_CHANGE_SUMMARY

import type { ParsedResultBlock, TrackedAgentName } from "./protocol.js";
import type { WorkItemState } from "./state.js";

export const MAX_REVIEW_ROUNDS = 2;

// START_CONTRACT: getAllowedNextAgent
//   PURPOSE: Resolve the single tracked agent allowed to run from the current state.
//   INPUTS: { state: WorkItemState - current work-item lifecycle state }
//   OUTPUTS: { TrackedAgentName | null - allowed tracked agent or null when no launch is allowed }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-TRANSITIONS]
// END_CONTRACT: getAllowedNextAgent
export function getAllowedNextAgent(state: WorkItemState): TrackedAgentName | null {
  if (state === "open" || state === "awaiting_implementer") {
    return "vv-implementer";
  }
  if (state === "awaiting_spec_review") {
    return "vv-spec-reviewer";
  }
  if (state === "awaiting_code_review") {
    return "vv-code-reviewer";
  }
  return null;
}

// START_CONTRACT: isAllowedTransition
//   PURPOSE: Check whether launching the requested tracked agent is valid for current state.
//   INPUTS: { state: WorkItemState - current state, agent: TrackedAgentName - requested tracked subagent }
//   OUTPUTS: { boolean - true when launch is allowed }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-TRANSITIONS]
// END_CONTRACT: isAllowedTransition
export function isAllowedTransition(state: WorkItemState, agent: TrackedAgentName): boolean {
  if (state === "open") {
    return (
      agent === "vv-implementer" || agent === "vv-spec-reviewer" || agent === "vv-code-reviewer"
    );
  }
  return getAllowedNextAgent(state) === agent;
}

// START_CONTRACT: getNextState
//   PURPOSE: Compute deterministic next work-item state from a tracked subagent result.
//   INPUTS: { currentState: WorkItemState - current lifecycle state, result: ParsedResultBlock - validated tracked result block }
//   OUTPUTS: { WorkItemState - next lifecycle state }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-TRANSITIONS]
// END_CONTRACT: getNextState
export function getNextState(
  currentState: WorkItemState,
  result: ParsedResultBlock,
): WorkItemState {
  if (result.agent === "vv-implementer") {
    if (result.status === "DONE" || result.status === "DONE_WITH_CONCERNS") {
      return "awaiting_spec_review";
    }
    if (result.status === "NEEDS_CONTEXT") {
      return "needs_context";
    }
    return "blocked";
  }

  if (result.agent === "vv-spec-reviewer") {
    if (result.status === "PASS") {
      return "awaiting_code_review";
    }
    if (result.status === "FAIL") {
      return "awaiting_implementer";
    }
    return "needs_context";
  }

  if (result.agent === "vv-code-reviewer") {
    if (result.status === "PASS") {
      return "ready_to_close";
    }
    if (result.status === "FAIL") {
      return "awaiting_implementer";
    }
    return "needs_context";
  }

  return currentState;
}

// START_CONTRACT: shouldBlockRound
//   PURPOSE: Enforce loop-gate policy by rejecting rounds above MAX_REVIEW_ROUNDS.
//   INPUTS: { reviewRound: number - computed review round }
//   OUTPUTS: { boolean - true when launch must be blocked }
//   SIDE_EFFECTS: [none]
//   LINKS: [M-WORKFLOW-TRANSITIONS]
// END_CONTRACT: shouldBlockRound
// START_BLOCK_CHECK_ROUND_LIMIT
export function shouldBlockRound(reviewRound: number): boolean {
  return reviewRound > MAX_REVIEW_ROUNDS;
}
// END_BLOCK_CHECK_ROUND_LIMIT
