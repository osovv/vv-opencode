# WorkflowPlugin V1 Plan

Date: 2026-04-20
Project: `@osovv/vv-opencode`

## Goal

Introduce a new `WorkflowPlugin` that replaces ad-hoc reviewer loops with an explicit work-item protocol and strict workflow enforcement.

The plugin should:

1. create explicit work items through tools
2. require tracked subagent launches to carry a work-item header
3. formalize tracked subagent result language into machine-checkable protocol fields
4. enforce deterministic transitions between tracked subagents
5. stop automation on `NEEDS_CONTEXT`
6. cap repeated review loops with explicit counters instead of semantic heuristics

## Confirmed Product Decisions

1. Managed tracked subagents will be renamed to:

- `vv-implementer`
- `vv-spec-reviewer`
- `vv-code-reviewer`

2. Tracked workflow enforcement applies to all tracked subagents above.

3. Subagent result language should become more formal and machine-checkable.

4. `NEEDS_CONTEXT` is a hard stop.
Main session must gather context before workflow continues.

5. Avoid semantic clustering, embeddings, n-grams, or fuzzy loop detection.
Use explicit IDs and simple counters only.

## Non-Goals For V1

1. Do not build semantic task grouping.
2. Do not infer work-item identity from prompt similarity.
3. Do not replace all existing subagents with workflow-aware variants.
4. Do not track `investigator` in the strict workflow state machine in V1.
5. Do not attempt full persistent recovery across process restarts in V1 unless required by actual runtime constraints.
6. Do not build a UI/dashboard first.

## Core Model

`WorkflowPlugin` is a runtime protocol and state machine, not a todo manager.

It has four responsibilities:

1. identity
Every tracked subagent run belongs to one explicit work item.

2. protocol
Every tracked subagent launch and result must follow strict machine-checkable fields.

3. transitions
Only allowed agent-to-agent transitions are permitted.

4. loop gating
Repeated review churn is capped by explicit counters keyed by work item.

## Work Item Protocol

### Work Item Identity

Use a required header:

```text
VVOC_WORK_ITEM_ID: wi-1
```

Rules:

1. It must be the first meaningful line of every tracked subagent prompt.
2. It must match an open work item in the parent session.
3. Missing, malformed, or unknown IDs fail closed.

### Work Item Tools

V1 tool surface:

1. `work_item_open`
2. `work_item_list`
3. `work_item_close`

`work_item_open` should be batch-based.

Example input:

```json
{
  "items": [
    { "key": "1", "title": "HashlineEditPlugin" },
    { "key": "2", "title": "README sync" }
  ]
}
```

Example output:

```json
{
  "items": [
    {
      "key": "1",
      "id": "wi-1",
      "title": "HashlineEditPlugin",
      "header": "VVOC_WORK_ITEM_ID: wi-1"
    },
    {
      "key": "2",
      "id": "wi-2",
      "title": "README sync",
      "header": "VVOC_WORK_ITEM_ID: wi-2"
    }
  ]
}
```

Semantics:

1. `key` is idempotency key inside the parent session.
2. Same `key` plus same `title` returns the same ID.
3. Same `key` plus different `title` is an error.
4. `work_item_close` is explicit. V1 should not silently auto-close items.

## Tracked Subagents

V1 tracked set:

- `vv-implementer`
- `vv-spec-reviewer`
- `vv-code-reviewer`

Untracked for V1:

- `investigator`
- `guardian`
- `memory-reviewer`
- `enhancer`

Reason:

1. V1 targets the concrete churn loop the user actually wants to control.
2. Smaller tracked surface reduces protocol brittleness.
3. `investigator` can remain available as a manual or later-phase escalation path.

## Result Protocol

Tracked subagents already have status language in prompts.
V1 should formalize it into strict top-of-response protocol fields.

### `vv-implementer`

Required top block:

```text
VVOC_WORK_ITEM_ID: wi-1
VVOC_STATUS: DONE
VVOC_ROUTE: change_with_review
```

Allowed `VVOC_STATUS` values:

- `DONE`
- `DONE_WITH_CONCERNS`
- `NEEDS_CONTEXT`
- `BLOCKED`

### `vv-spec-reviewer`

Required top block:

```text
VVOC_WORK_ITEM_ID: wi-1
VVOC_STATUS: PASS
```

Allowed `VVOC_STATUS` values:

- `PASS`
- `FAIL`
- `NEEDS_CONTEXT`

### `vv-code-reviewer`

Required top block:

```text
VVOC_WORK_ITEM_ID: wi-1
VVOC_STATUS: PASS
```

Allowed `VVOC_STATUS` values:

- `PASS`
- `FAIL`
- `NEEDS_CONTEXT`

Note:
`NEEDS_CONTEXT` should be added to the current `code-reviewer` contract so all tracked agents share a common hard-stop status.

### Parser Rules

1. Parse only the strict top block first.
2. Do not guess status from free-form prose.
3. Missing `VVOC_WORK_ITEM_ID` is a protocol error.
4. Missing `VVOC_STATUS` is a protocol error.
5. Unknown status is a protocol error.
6. Work-item mismatch is a protocol error.
7. Protocol errors must halt automation.

## Workflow State Machine

State key:

- `(parentSessionID, workItemID)`

Recommended state fields:

- `id`
- `key`
- `title`
- `state`
- `createdAt`
- `closedAt`
- `lastTrackedAgent`
- `lastStatus`
- `implementerCount`
- `specReviewCount`
- `codeReviewCount`
- `reviewRound`
- `blockedReason`
- `halted`
- `protocolVersion`

Recommended states:

- `open`
- `awaiting_implementer`
- `awaiting_spec_review`
- `awaiting_code_review`
- `needs_context`
- `blocked`
- `ready_to_close`
- `closed`

## Transition Policy

V1 deterministic workflow:

1. `open` or `awaiting_implementer`
launch `vv-implementer`

2. if `vv-implementer -> DONE` or `DONE_WITH_CONCERNS`
transition to `awaiting_spec_review`

3. if `vv-implementer -> NEEDS_CONTEXT`
transition to `needs_context`
hard stop

4. if `vv-implementer -> BLOCKED`
transition to `blocked`
hard stop

5. if `awaiting_spec_review`
launch `vv-spec-reviewer`

6. if `vv-spec-reviewer -> PASS`
transition to `awaiting_code_review`

7. if `vv-spec-reviewer -> FAIL`
transition to `awaiting_implementer`

8. if `vv-spec-reviewer -> NEEDS_CONTEXT`
transition to `needs_context`
hard stop

9. if `awaiting_code_review`
launch `vv-code-reviewer`

10. if `vv-code-reviewer -> PASS`
transition to `ready_to_close`

11. if `vv-code-reviewer -> FAIL`
transition to `awaiting_implementer`

12. if `vv-code-reviewer -> NEEDS_CONTEXT`
transition to `needs_context`
hard stop

13. from `ready_to_close`
main session may call `work_item_close`

## Loop Gating Policy

### V1 Recommendation

Use:

```text
reviewRound = max(specReviewCount, codeReviewCount)
```

Policy:

1. rounds `1` and `2` are allowed
2. before entering round `3`, reject the next tracked launch
3. main session must intervene explicitly

Intervention means one of:

1. gather more context and restart the item
2. split the work item
3. close the item
4. involve the user
5. manually run an untracked investigation path

Reason:

1. simple
2. deterministic
3. no fuzzy semantics
4. immediately solves the churn problem without adding investigator coupling in V1

## Hard Stop Rules

The plugin must stop automatic workflow progression when any of these happens:

1. tracked launch missing `VVOC_WORK_ITEM_ID`
2. unknown work item ID
3. malformed prompt header
4. malformed tracked subagent result
5. invalid state transition
6. `VVOC_STATUS: NEEDS_CONTEXT`
7. `VVOC_STATUS: BLOCKED`
8. review round limit exceeded

## Main Session Guidance

Main session should be explicitly taught to use the protocol.

Instruction goals:

1. open work items first
2. reuse returned `VVOC_WORK_ITEM_ID`
3. put that header first in tracked subagent prompts
4. treat `NEEDS_CONTEXT` as a hard stop
5. use `work_item_list` to inspect workflow state before retrying
6. avoid free-form review loops without explicit work-item identity

Recommended hook:

- `chat.message`

Reason:

1. it is easier to scope to primary sessions
2. it fits current `SystemContextInjectionPlugin` architecture
3. it avoids polluting subagent prompts globally

## Enforcement Hooks

### Launch Validation

Use:

- `tool.execute.before`

Target:

- `task`

Logic:

1. inspect `output.args.subagent_type`
2. if not tracked, ignore
3. if tracked, inspect `output.args.prompt`
4. require valid first-line `VVOC_WORK_ITEM_ID`
5. require existing open work item
6. require allowed next tracked agent for current workflow state
7. require round limit not exceeded
8. reject otherwise

### Result Parsing

Use:

- `tool.execute.after`

Target:

- `task`

Logic:

1. inspect tracked subagent output
2. parse strict top block
3. validate `VVOC_WORK_ITEM_ID`
4. validate allowed status for that agent
5. update counters and state
6. halt on protocol mismatch

### Cleanup

Optional in V1:

- `event`

Use cases:

1. clear stale workflow state on session deletion
2. prune old in-memory records
3. avoid memory leaks

## Rename Plan

This project has decided to rename tracked subagents in the first implementation wave.

Rename mapping:

- `implementer` -> `vv-implementer`
- `spec-reviewer` -> `vv-spec-reviewer`
- `code-reviewer` -> `vv-code-reviewer`

`investigator` remains unchanged in V1 unless a separate naming migration is approved.

Rename impact areas:

1. `src/lib/managed-agents.ts`
2. `src/lib/model-roles.ts`
3. `src/lib/opencode.ts`
4. `src/lib/opencode.test.ts`
5. `src/commands/init.test.ts`
6. `src/lib/managed-agents.test.ts`
7. `README.md`
8. `docs/knowledge-graph.xml`
9. `docs/verification-plan.xml`
10. prompt template file names and prompt lookup references

Important implementation choice:
rename the prompt file names too, not only the registered agent names.

Recommended file names:

- `vv-implementer.md`
- `vv-spec-reviewer.md`
- `vv-code-reviewer.md`

Reason:
keep external and on-disk naming aligned.

## Implementation Phases

### Phase 0: Protocol Lock

Goal:
freeze exact protocol before coding.

Tasks:

1. finalize header name
2. finalize required result fields
3. finalize allowed statuses
4. finalize loop limit policy
5. confirm whether `VVOC_ROUTE` is mandatory only for implementer

Exit criteria:

1. no ambiguity in tracked agent names
2. no ambiguity in top block grammar
3. no ambiguity in hard-stop behavior

### Phase 1: Rename Foundation

Goal:
rename tracked managed subagents to `vv-*`.

Tasks:

1. update managed agent names and prompt file names
2. update model-role bindings for renamed agents
3. update managed prompt lookup maps
4. update OpenCode registration tests
5. update init/install/sync expectations
6. update README and artifacts for renamed agents

Exit criteria:

1. `vvoc install` / `vvoc sync` scaffold renamed tracked agents
2. tests referencing managed agent registration pass
3. prompt lookup works for renamed files

### Phase 2: Workflow Core

Goal:
add plugin skeleton, work-item tools, and runtime state.

Tasks:

1. create `src/plugins/workflow/index.ts`
2. create work-item state store
3. implement `work_item_open`
4. implement `work_item_list`
5. implement `work_item_close`
6. export plugin at package root and subpath
7. add pack/export coverage

Exit criteria:

1. tools are registered
2. work-item identity works per session
3. state inspection works

### Phase 3: Main Session Instruction

Goal:
teach main session to use the new protocol.

Tasks:

1. add workflow system instruction text
2. inject only into primary sessions
3. document exact workflow protocol in README
4. keep guidance out of tracked subagent prompts unless explicitly needed

Exit criteria:

1. main session sees workflow protocol
2. subagent prompts are not accidentally polluted
3. tests confirm primary-only injection

### Phase 4: Launch Enforcement

Goal:
fail invalid tracked `task` launches before they run.

Tasks:

1. intercept `task` in `tool.execute.before`
2. validate `subagent_type`
3. validate `VVOC_WORK_ITEM_ID`
4. validate work-item existence
5. validate allowed next agent
6. validate round limits
7. return clear hard-fail messages

Exit criteria:

1. tracked launches cannot run without valid work-item identity
2. invalid transitions are blocked deterministically
3. untracked task launches still work

### Phase 5: Result Parsing And State Machine

Goal:
make tracked subagent outcomes machine-checkable.

Tasks:

1. update tracked subagent templates with strict top block
2. implement parsers for each tracked subagent
3. parse `tool.execute.after` output
4. update workflow state
5. halt on protocol errors
6. halt on `NEEDS_CONTEXT`
7. halt on `BLOCKED`

Exit criteria:

1. tracked runs update workflow state correctly
2. malformed results fail closed
3. `NEEDS_CONTEXT` returns control to main session

### Phase 6: Loop Gate

Goal:
stop repeated reviewer churn.

Tasks:

1. count spec-review runs
2. count code-review runs
3. compute `reviewRound`
4. block round `3`
5. provide explicit next-action guidance in block errors

Exit criteria:

1. repeated review loops stop deterministically
2. no semantic heuristics are used
3. main session can inspect state and recover explicitly

### Phase 7: Documentation And Verification

Goal:
fully document and verify the protocol.

Tasks:

1. update README
2. update `docs/knowledge-graph.xml`
3. update `docs/verification-plan.xml`
4. update `docs/development-plan.xml` if phase tracking is desired
5. update `docs/workflow-plugin-handoff.md`
6. add targeted tests and verification commands

Exit criteria:

1. docs reflect real tracked names and protocol
2. verification plan covers workflow enforcement
3. build and pack smoke checks pass

## Proposed File Layout

### New files

- `src/plugins/workflow/index.ts`
- `src/plugins/workflow/state.ts`
- `src/plugins/workflow/protocol.ts`
- `src/plugins/workflow/transitions.ts`
- `src/plugins/workflow/tooling.ts`
- `src/plugins/workflow/system-instruction.md`
- `src/plugins/workflow.test.ts`

### Updated source files

- `src/index.ts`
- `package.json`
- `src/lib/managed-agents.ts`
- `src/lib/model-roles.ts`
- `src/lib/opencode.ts`

### Updated prompt templates

- `templates/agents/vv-implementer.md`
- `templates/agents/vv-spec-reviewer.md`
- `templates/agents/vv-code-reviewer.md`

### Updated tests

- `src/lib/managed-agents.test.ts`
- `src/lib/opencode.test.ts`
- `src/commands/init.test.ts`
- `src/lib/model-roles.test.ts`

### Updated docs

- `README.md`
- `docs/knowledge-graph.xml`
- `docs/verification-plan.xml`
- `docs/workflow-plugin-handoff.md`

## Test Plan

### Unit tests

1. `work_item_open` idempotency by key
2. same key plus different title fails
3. `work_item_list` reflects state
4. `work_item_close` closes only existing open items
5. launch validation rejects missing header
6. launch validation rejects malformed header
7. launch validation rejects unknown work item
8. launch validation rejects invalid next agent
9. launch validation rejects round limit overflow
10. implementer result parser accepts valid statuses
11. spec-reviewer result parser accepts valid statuses
12. code-reviewer result parser accepts valid statuses
13. malformed tracked output halts workflow
14. `NEEDS_CONTEXT` moves item to hard-stop state

### Integration tests

1. happy path:
`vv-implementer -> vv-spec-reviewer -> vv-code-reviewer -> ready_to_close`

2. spec fail path:
`vv-implementer -> vv-spec-reviewer FAIL -> vv-implementer`

3. code fail path:
`vv-implementer -> vv-spec-reviewer PASS -> vv-code-reviewer FAIL -> vv-implementer`

4. hard-stop path:
any tracked agent returns `NEEDS_CONTEXT`

5. loop-gate path:
third review round is rejected

6. rename path:
install/sync writes renamed tracked agent registrations and prompt file references

### Verification commands

1. `bun run typecheck`
2. `bun run lint`
3. `bun run fmt:check`
4. `bun test src/plugins/workflow.test.ts`
5. `bun test src/lib/managed-agents.test.ts src/lib/opencode.test.ts src/commands/init.test.ts src/lib/model-roles.test.ts`
6. `bun run build`
7. `bun run pack:check`

## Open Questions

### Q1. What should happen after review round limit is reached?

Options:

1. hard stop and force user involvement
2. hard stop and allow manual untracked `investigator`
3. hard stop and allow main session to reopen/split the item explicitly

Recommended V1:
support 1 and 3 explicitly.
Do not bake `investigator` into the tracked state machine yet.

### Q2. Should `VVOC_ROUTE` be required everywhere?

Recommended V1:
require it only for `vv-implementer`.

Reason:
route is most meaningful at implementation stage.
Reviewers can stay status-only.

### Q3. Should workflow state persist across process restarts?

Recommended V1:
no.
Keep state in memory first.

Reason:
it is simpler and enough to validate the protocol.
Persistence can be Phase 2+ if runtime behavior proves it necessary.

### Q4. Should `DONE_WITH_CONCERNS` automatically proceed to review?

Recommended V1:
yes.

Reason:
it still means implementation completed.
The concern should remain visible in output, but it should not block review automatically.

## Recommended Execution Order

1. lock protocol grammar
2. rename tracked agents to `vv-*`
3. add workflow tools and in-memory state
4. inject main-session protocol guidance
5. add `task` launch validation
6. formalize tracked subagent result templates
7. parse tracked results and update state
8. add loop gating
9. update docs and verification artifacts

## Success Criteria

The change is successful when:

1. tracked subagent launches cannot happen without explicit work-item identity
2. tracked subagent outputs are machine-checkable
3. `NEEDS_CONTEXT` always halts workflow and returns control to main session
4. repeated review churn stops deterministically by explicit counter
5. renamed tracked subagents are scaffolded consistently by vvoc
6. no semantic heuristics are used anywhere in workflow enforcement
