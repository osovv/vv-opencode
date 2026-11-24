# Long sessions: state, updates, references

## The cumulative input

History keeps old tasks, rejected variants, intermediate assumptions, and the model's own answers. Without explicit update semantics, the model guesses which instructions are still active. Design the whole visible input, not the last phrase.

## Current task

Mark it explicitly: `<CURRENT-TASK-TURN-12>Rebuild the guide structure within the new scope.</CURRENT-TASK-TURN-12>`. Recency alone ("now let's do it differently") is not marking.

## Update semantics

Four operations; inner fields vary, the operation names do not:

- **extends** — adds a requirement.
- **supersedes** — replaces a previous requirement; name the previous ID and the replacement.
- **preserves** — explicitly keeps previous rules active.
- **removes** — cancels a requirement without replacement.

`<UPDATE-TURN-12><supersedes><previous>REQUIREMENT-03</previous><replacement id="REQUIREMENT-03">…</replacement></supersedes><preserves>REQUIREMENT-01, REQUIREMENT-02</preserves><current-task>…</current-task></UPDATE-TURN-12>`

Omit the operations the turn does not need.

## State vs history

History answers "how did we get here"; state answers "what is true and active now". A current-state block (`<SESSION-STATE-V4>` with the active objective, active constraints, accepted decisions, assumptions, open questions, current task) is an authoritative restatement inside the visible context, not a memory system. Restate when: several requirements were revised, the model returns rejected ideas, old and new scope mix, references turn ambiguous, or the current task cannot be stated without retelling history. Restatement keeps source IDs and marks assumptions; it never silently rewrites history.

## One authoritative location

"Be concise / avoid verbosity / no filler / keep it short" are four non-equivalent rules. The full rule lives in one place; near the current task, repeat the ID and a short active meaning: `Apply REQUIREMENT-03 (the guide stays limited to prompt formulation).`

## Exact references and superseded status

Before: "compare this with that variant above."
After: `Compare <PROMPT-V3> with <PROMPT-V5> against CRITERIA-REVIEW-02.`
Mark superseded blocks instead of deleting them: `<DECISION-04 status="superseded-by-DECISION-09">`.

## Q-IDs for external results

Assign each external request (query, search, command) a stable ID. Results return wrapped with that ID, never bare: `<Q-1>…</Q-1>`, `<Q-2 status="empty" />`. Status makes absence a fact: `empty`, `failed`, `superseded-by-Q-5`. Later references use exact IDs ("compare Q-1 with Q-3"), and a retry links to the previous request through update semantics. Keep the ID format identical across the whole session.

## Alignment and transfer

Before substantial work: restate the task in one line, state material assumptions and scope, and request a readback (the executor's understanding of goal, criteria, boundaries); correct divergence before work starts. Short tasks collapse this to one restatement line. On transfer or cold start, build a resume brief — goal, current state, accepted decisions, blockers, next step, preserving source IDs; in vvoc, vv-handoff owns the durable handoff artifact.
