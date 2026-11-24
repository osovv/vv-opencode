---
name: vv-execute
description: Use when the user explicitly selects the native plan-package execution workflow — validate an approved plan.xml, choose an execution mode with the user, and execute tasks with verification and commits
---

<scope>
Execute an approved plan.xml from .vvoc/specs/&lt;id&gt;/plan.xml: first validate the plan, resolve the execution mode, and execute tasks with verification and commits.

Do not mutate files until the execution mode is explicit. In classic mode, delegate implementation to vv-implementer and collect all required reviewers per task. In inline mode, write code yourself in the current session without subagent dispatch. In delegated mode, keep architecture, acceptance decisions, and verification in this session and delegate implementation edits, including reviewer-requested fixes, to workers.
</scope>

<workflow>
<step name="load-plan">
Read plan.xml from .vvoc/specs/&lt;id&gt;/plan.xml. Use the artifact grep helpers to understand scope and execution order. Also check whether a sibling design-context.xml exists (.vvoc/specs/&lt;id&gt;/design-context.xml) — note it as available context for reviewers but do not treat it as a requirements source.
</step>

<step name="validate-plan">
Checks:
- Plan file exists and is readable.
- The plan path is an active plan under .vvoc/specs/&lt;id&gt;/ with the plan as a sibling of spec.xml. Reject plans under any archive/ directory.
- The plan contains a &lt;plan&gt; root tag.
- The plan contains a non-empty top-level &lt;status&gt; whose value is approved. If it is draft, stop and ask the user to approve the plan first. If it is applied, stop and report that the plan has already been applied. If it is missing or any other value, stop and report the invalid lifecycle status.
- The plan contains a non-empty &lt;spec&gt; path pointing to a readable active spec file at .vvoc/specs/&lt;id&gt;/spec.xml. Stop and report if the spec path is under archive/.
- The linked spec's top-level &lt;status&gt; is approved. If it is draft, applied, missing, or invalid, stop and report that vv-execute requires an approved active spec.
- The plan contains a &lt;tasks&gt; section with at least one &lt;TASK-T-NNN&gt; element grouped under &lt;WAVE-N&gt; elements.
- Each task element name matches the TASK-T-NNN pattern and the task has non-empty &lt;title&gt; and &lt;file&gt;. There is no child id element — identity lives in the element name.
- Each task has &lt;snippet&gt; (may be empty but must exist) and an &lt;acceptance&gt; section with at least one &lt;criterion&gt;.
- Plan architecture components use COMPONENT-UPPER-SLUG element names and every component exists in the linked spec's components section — plan components are a subset of spec components.

If any check fails, stop and report the issue with line numbers. Do not proceed with a broken plan.
</step>

<step name="assess-complexity">
Assess the plan after validation and before implementation. Task count is only a weak signal: 10-15 small, localized, clear tasks can still be better suited for inline execution, while a 2-3 task plan can require classic execution if it is risky or cross-cutting.

Consider:
- total task count and whether tasks are small/mechanical or broad/ambiguous
- number of target files and whether changes stay localized
- dependency graph shape and coupling between tasks
- whether public APIs, package exports, CLI behavior, setup flow, config locations, persistence, security, migrations, or user data handling change
- clarity and verifiability of acceptance criteria
- whether the plan requires architectural decisions, broad refactors, or integration-heavy coordination

Recommend inline when tasks are clear, localized, mechanically verifiable, and low-risk even if there are many small tasks. Recommend classic when tasks are ambiguous, high-risk, cross module boundaries, affect public/setup/config/security/persistence behavior, or require heavier review isolation. Recommend delegated when the plan has many mechanical tasks with clear contracts, the controller wants explicit per-task acceptance without a per-task reviewer barrier, and the plan declares meaningful review checkpoints. Delegation is not a token-saving trick: the controller still reads the material changed code and evidence before accepting.
</step>

<step name="select-execution-mode">
Execution mode resolution — make the user explicitly choose an execution mode unless they already specified one.

If the user did not specify a mode, stop and ask them to choose. Do not auto-pick. Present a compact assessment and recommendation in the user's language, then offer exactly three choices:

```
Plan complexity assessment:
- N tasks
- M target files
- dependency/coupling summary
- risk signals found or not found
- acceptance criteria clarity

Recommended mode: inline|classic|delegated

Choose execution mode:
1. inline — execute in this session
2. classic — delegate each task to vv-implementer with required reviewers per task
3. delegated — delegate implementation, accept each attempt yourself, review at declared checkpoints
```

Wait for the user's answer before editing files, opening work items, dispatching vv-implementer, registering plans, or running implementation commands.
</step>

<step name="create-todo">
Create a TodoWrite with all task IDs in dependency order for progress tracking.
</step>

## Classic workflow

Use this workflow only when execution mode is classic. Each task runs as an independent unit with its own work item and implementer dispatch. The implementer receives the task's contract + criteria + files plus the material dependencies, affected consumers, and diagnostic scenarios the controller already knows — not the full plan. This keeps context lean while the packet stays complete enough to verify real impact.

<step name="classic-extract">
Use the extract-task helper to pull the full task content. Collect the task id and title, file path, code snippet from CDATA, acceptance criteria, and dependencies.
</step>

<step name="classic-construct-packet">
Build the vv-implementer assignment. The packet must contain:

```
&lt;assignment&gt;
  &lt;goal&gt;Implement &lt;component&gt; per spec and plan&lt;/goal&gt;
  &lt;contract&gt;...task's code snippet...&lt;/contract&gt;
  &lt;acceptance&gt;...task's criteria...&lt;/acceptance&gt;
  &lt;dependencies&gt;...material dependencies, affected consumers, and a diagnostic scenario exercising the property at risk...&lt;/dependencies&gt;
  &lt;verification&gt;Run the tests, verify all criteria pass&lt;/verification&gt;
&lt;/assignment&gt;
```

Every material finding from plan.xml must be enumerated explicitly in the packet body — the implementer has zero session context.
</step>

<step name="classic-dispatch">
Open an implementation work item with work_item_open for this task: `{ items: [{ key, title, mode: "implementation", requiredReviewers: ["spec", "code"] }] }`.

A standalone item takes only `key`, `title`, `mode`, and `requiredReviewers`. The fields `goal`, `acceptanceCriteria`, `verification`, `writeScope`, `dependsOn`, and `blockedBy` belong to `execution.tasks[]` and are rejected on a standalone open. Put those details in the assignment packet, not in work_item_open.

The work_item_open response includes a ready-to-copy `header` for each item. Dispatch vv-implementer with a packet whose FIRST meaningful line is exactly that header, in the form `VVOC_WORK_ITEM_ID: wi-<n>`: colon after the id, nothing else on that line (no `=`, no trailing prose), followed by the constructed packet.

The launch gate allows exactly one tracked agent per workflow state — the artifact state table below is authoritative. If a launch is rejected, read the rejection instead of retrying the same transition. `LAUNCH_REJECTED_INVALID_TRANSITION` names the only allowed agent for the current state. `REVIEW_ROUND_NOT_ACTIVE` means the item has no active review round yet. `REVIEWER_ALREADY_IN_FLIGHT` means that reviewer is already running; wait for its report instead of launching it again.

The implementer writes code, runs tests, and returns a status. This controller verifies acceptance criteria and commits after verification passes.
</step>

<step name="classic-handle-status">
Cases:
- DONE: use the task-file helper to verify files exist. Run the test command from the plan (if specified). Verify each acceptance criterion. If verification fails, re-dispatch the implementer with failure details (the work item is still awaiting implementation). If verification passes, proceed to the review step.
- DONE_WITH_CONCERNS: read the concerns before proceeding. If they are about correctness or scope, address them by updating the packet and re-dispatching the implementer. If they are observations (for example "file is getting large"), note them and proceed with verification as DONE, then to the review step.
- NEEDS_CONTEXT: a hard stop. The runtime will not allow another tracked launch for this work item, so do not re-dispatch the implementer. Surface the preserved context from work_item_list to the user and require an explicit recovery decision — typically a fresh work item with the missing context supplied.
- BLOCKED: a hard stop. The runtime will not allow another tracked launch for this work item, so do not re-dispatch the implementer. Escalate to the user with the captured blocker context and ask for a decision (a different approach, a different model via a fresh work item, or a plan change).
</step>

<step name="classic-verify">
Run the acceptance criteria. For each criterion:
- Can you point to a test that proves it?
- Does the test pass?
- Does the check actually exercise the changed behavior at the level the risk arises, or is it a green general check that cannot reach the changed path?
- Did the implementer miss any edge cases?

If all criteria pass, proceed to review. If criteria fail, re-dispatch the implementer with specific failure details.
</step>

<step name="classic-review">
A DONE implementer moves the work item to awaiting_reviews with a review round that requires EVERY role in requiredReviewers (spec and code). Dispatch and collect ALL required reviewers before closing:
- Dispatch vv-spec-reviewer with the header line exactly as returned, `VVOC_WORK_ITEM_ID: wi-<n>`, followed by a spec-compliance packet.
- Dispatch vv-code-reviewer with the same header line followed by the changed code and diff.

Each reviewer prompt must start with the header as its FIRST meaningful line; prose or `VVOC_WORK_ITEM_ID=` before it is rejected.

The launch gate allows exactly one agent per state. A reviewer launch is rejected while the item is open (`REVIEW_ROUND_NOT_ACTIVE`) or while another reviewer is in flight (`REVIEWER_ALREADY_IN_FLIGHT`); read the rejection and wait for that report instead of relaunching. To review a diff or PR that no implementation item owns, open a NEW item with `mode: "review_only"` and its reviewer roles first; a review-only item starts directly in awaiting_reviews.

Collect both results:
- Both PASS → the work item becomes ready_to_close → proceed to commit.
- Any FAIL → the work item returns to awaiting_implementer. Re-dispatch the implementer with the normalized reviewer findings, then repeat handle-status, verify, and review (bounded by the runtime review-round limit). The repeat review is a scoped re-review: it verifies the prior findings against the fix and the fix's material effects — including directly affected consumers where necessary — rather than an unrestricted second full review; unrelated optional improvements do not renew the loop.
- A reviewer returning NEEDS_CONTEXT is a hard stop: surface it to the user instead of re-dispatching.
</step>

<step name="classic-close">
After all acceptance criteria pass and all required reviewers passed, commit the task's changes under the commit discipline in rules, mark the task complete in TodoWrite, and close the work item with work_item_close. If all tasks are done, proceed to completion. Otherwise move to the next task in dependency order.
</step>

## Delegated workflow

Use this workflow only when execution mode is delegated. Implementation ownership belongs to workers; architecture, important code reading, acceptance decisions, and final synthesis stay in this controller session. The approved plan's declared checkpoints — not a per-task habit — decide when independent review happens.

<step name="delegated-register-once">
Register the approved plan exactly once with work_checkpoint (action register) using the plan path. work_checkpoint register accepts only its supported approved native plan package — the approved spec.xml and plan.xml pair under .vvoc/specs/. A provided plan or conversation-scoped execution stays on its own source and lifecycle: keep that source authoritative, and never disguise a managed reviewer as another agent to evade checkpoint enforcement. Registration derives every task and checkpoint obligation from the validated file; it dispatches no agents and runs no commands. Re-registering identical inputs is idempotent; if the approved plan or spec content changed, registration reports explicit plan drift — amend the plan instead of resetting progress. Track progress in TodoWrite and runtime state; do not update approved plan XML task or lifecycle statuses during execution.
</step>

<step name="delegated-dispatch-task">
For the next dependency-ready task, dispatch one bounded vv-implementer packet using the task's registered work item: the VVOC_WORK_ITEM_ID header, the task's contract-level snippet, acceptance criteria, declared write scope, verification commands, and the material dependencies and diagnostic scenario the controller knows. One active implementation worker is the default. The worker completes its own local edit, test, and fix cycle before reporting; do not interrupt it mid-cycle.
</step>

<step name="delegated-decide-acceptance">
A DONE worker result parks the item in awaiting_acceptance. It is not accepted and cannot close by itself. Inspect the material changed code and evidence yourself, then call work_item_decide:
- accept with rationale and evidence references when the result matches the task contract and the evidence actually exercises the task's material claims.
- request_changes with bounded rationale when it does not; the worker returns for one correction attempt before explicit recovery is required.

Acceptance requires evidence sufficiency: a DONE report plus green general checks that never reach the changed behavior is not acceptance. DONE_WITH_CONCERNS requires an explicit concernsDisposition — never auto-accept it, and never let a stated concern substitute for an unverified material condition of the change. Attempt identity is bound to the host call: decisions must target the current completed attempt, and duplicate or stale decisions fail without side effects. The two-attempt budget (initial plus one correction) never resets on retries or re-decisions.

Two bounded paths extend work without resetting history: a stopped or exhausted unaccepted task recovers through work_item_decide with decision recover — one autonomous grant per target, then further units only with an explicit root-user message referenced by userMessageId or a recorded advance authority referenced by runId and authorityId — and an accepted task covered by a failed checkpoint reopens through decision rework. Recovery authorizes the next bounded attempt; it never accepts a result or replaces a reviewer.
</step>

<step name="delegated-hard-stops">
NEEDS_CONTEXT and BLOCKED from a worker are hard stops. Do not re-dispatch the unchanged stopped item or reset it under a new key to evade limits. Diagnose the stop yourself from the preserved excerpt in work_item_list and the changed code, then recover the same work item with work_item_decide decision recover: name the diagnosis, the changed condition or approach, the required verification, and a stable recoveryId. The first needed grant is autonomous; every further unit requires a fresh root-user message referenced by userMessageId or one recorded advance-authority unit referenced by runId and authorityId. Recovery resumes the same item with its history preserved — it never accepts the result or skips a reviewer. A stop suspends this task; it does not end the execution session.
</step>

<step name="delegated-run-due-checkpoints">
Before starting tasks whose wave sits behind a declared checkpoint, run the due checkpoint: work_checkpoint (action start) opens exactly the declared reviewer set against a pinned snapshot of the covered scope. Launch those reviewers with the returned review work item header, collect every declared reviewer, then work_checkpoint (action verify) derives passed, failed, stale, or stopped.
- Every declared reviewer must PASS for the pinned snapshot; a closed review-only FAIL report is a findings result, never approval.
- Editing covered files during review makes the generation stale, not passing.
- A failed checkpoint routes confirmed implementation fixes to workers: authorize rework with work_item_decide (decision rework) for the covered accepted task, then re-accept and start the checkpoint's one correction generation.
- A checkpoint generation that stopped (NEEDS_CONTEXT) or exhausted its two ordinary generations recovers through work_checkpoint (action recover) with the same bounded fields as task recovery. Recovery preserves covered tasks, declared reviewers, and history, and it never seals the run — only a passing verified final review does.
- Passed milestones stay historical; later planned edits are covered by later checkpoints, not by the old approval.
</step>

<step name="delegated-final-gate">
The plan is complete only when every declared task is accepted, every earlier checkpoint passed, and the final checkpoint covers the complete current result. Call work_checkpoint (action verify, complete: true) on the final checkpoint after fresh verification; completion is refused while anything is unaccepted, failed, or stale.
</step>

## Inline workflow

Use this workflow only when execution mode is inline. Execute tasks directly in the current session to reduce latency and token overhead for clear, localized plans. Inline execution preserves the plan contract: dependency order, TodoWrite tracking, acceptance verification, and commit discipline still apply.

<step name="inline-extract">
Use the extract-task helper to pull the full task content: task id and title, file path, code snippet from CDATA, acceptance criteria, and dependencies.
</step>

<step name="inline-prepare-context">
Read the target file and any directly relevant local contracts, tests, or surrounding implementation before editing. Keep context bounded to the current task or wave. If the task depends on previous tasks, verify those dependencies are completed before editing.
</step>

<step name="inline-implement">
Apply the smallest correct change that satisfies the task contract and acceptance criteria. Follow repository instructions, semantic markup rules, and existing patterns. If scope expands beyond the assessed inline complexity, stop and reroute instead of continuing speculatively.
</step>

<step name="inline-verify">
Run the acceptance criteria for the task or wave. For each criterion:
- Can you point to a test, command, or deterministic check that proves it?
- Does the check pass?
- Does the check actually exercise the changed behavior at the level the risk arises, or is it a green general check that cannot reach the changed path?
- Did the inline implementation miss any edge cases?

If criteria fail with a clear local cause, fix and rerun verification. If criteria fail and the root cause, expected behavior, or safe fix path is unclear, stop and ask the user whether to switch the remaining execution to classic mode. Do not silently dispatch vv-implementer from inline mode.
</step>

<step name="inline-close">
After the task's acceptance criteria pass and its task or wave commit is complete or intentionally skipped with a warning, mark the task complete in TodoWrite. If all tasks are done, proceed to completion. Otherwise move to the next task in dependency order.
</step>

<step name="inline-reroute">
Inline mode is allowed only while the work remains clear, bounded, and low-risk. Stop and ask the user whether to switch to classic mode when:
- the implementation crosses unexpected module or architecture boundaries
- public API, CLI behavior, package exports, setup flow, config locations, persistence, security, migrations, or user data handling become materially affected and were not already part of the inline assessment
- acceptance criteria are ambiguous or incomplete
- verification fails without a clear local cause
- repeated inline attempts do not converge
</step>
</workflow>

<rules>
- Write execution output in English by default. Use the user's language only for dialogue; if the user explicitly requests a different output language, follow that request.
- An execution mode that the user already stated explicitly is reused; do not ask for it again.
- If the approved plan declares an &lt;execution&gt;&lt;mode&gt; and that intent is compatible with the user's explicit choice and the active session policy, reuse the declared mode without asking again.
- If execution intent is missing, or the plan, user, and active orchestration profile conflict, stop and ask for one explicit decision before any writes. Do not guess and do not silently switch policy mid-run.
- Commit discipline: after the task's acceptance criteria pass, commit the task's changes. Derive a business task identifier in priority order from the branch name ticket reference, then the spec package directory name or plan summary, then the plan title, then ask the user. Match the repository's existing convention (`git log --oneline -10`). Format `&lt;business-ref&gt; &lt;type&gt;(&lt;scope&gt;): &lt;task title&gt;`; if no business identifier is available, omit it. Do NOT include internal T-NNN task IDs. If git is unavailable, skip with a warning; if the commit fails, report the failure and stop. Apply the same discipline to classic, delegated, and inline commits; inline commits per task by default, or per wave when the plan defines waves or several small tasks are tightly coupled. Do not collapse the whole plan into one final commit unless the plan is a single logical task or single logical wave.
- Verification: choose checks at the level where the risk arises. A green general check that cannot reach the changed path is not evidence for a material criterion.
- Model selection respects the configured semantic roles; do not suggest escalating to the smart model for routine work. vv-implementer runs on the default role regardless of task size; do not route integration implementation to smart/Astra yourself. Reviewers run on the reviewer role; routine code or spec reviews do not need smart/Astra. If a worker returns BLOCKED because of task complexity, that is an explicit recovery decision for the user — not an automatic model escalation. Role and profile assignments come from the vvoc configuration and presets; changing them requires an OpenCode restart, not a mid-run override.
- NEEDS_CONTEXT and BLOCKED from a worker are hard stops.
- A reviewer FAIL report is a findings result; a closed review-only FAIL report is a findings result, never approval.
</rules>

<artifact>
Supported modes:
- inline: walk tasks in dependency order and implement directly in the current session without subagent dispatch, while preserving TodoWrite tracking, acceptance verification, and per-task or per-wave commit discipline.
- classic: walk tasks in dependency order, dispatch vv-implementer with the extracted contract and acceptance criteria per task, track progress with work_item_open/list/close in mode "implementation", collect every required reviewer per task, verify results, and commit per task.
- delegated: register the approved plan once with work_checkpoint, dispatch bounded task packets to vv-implementer in mode "delegated", inspect changed code and evidence yourself, accept or request changes per attempt with work_item_decide, and spend independent review only at the plan's declared review checkpoints.

| Mode | Implementer | Reviews | Commit |
|---|---|---|---|
| inline | current session | acceptance verification only | per task, or per wave when declared |
| classic | vv-implementer per task | spec and code reviewer per task | per task |
| delegated | vv-implementer in bounded packets | only declared checkpoints | per task |

Launch-gate state map:

| State | Allowed tracked agent |
|---|---|
| `open` (implementation) | `vv-implementer` |
| `awaiting_implementer` | `vv-implementer` |
| `awaiting_reviews` (active round) | the pending `vv-spec-reviewer` and `vv-code-reviewer` roles |
| `awaiting_acceptance` | none; the controller calls `work_item_decide` |
| `needs_context` / `blocked` | none until an explicit recovery decision |
| `ready_to_close` / `closed` | none |

Grep helpers:

| Helper | Command | Purpose |
|---|---|---|
| plan-meta | `sed -n '/&lt;meta&gt;/,/&lt;\/meta&gt;/p' PLAN_PATH` | plan metadata: summary, waves, complexity |
| plan-document-status | `sed -n '1,20p' PLAN_PATH \| grep '&lt;status&gt;'` | top-level lifecycle status |
| linked-spec | `sed -n '1,20p' PLAN_PATH \| grep '&lt;spec&gt;'` | linked spec path |
| spec-document-status | `sed -n '1,20p' SPEC_PATH \| grep '&lt;status&gt;'` | linked spec lifecycle status |
| architecture | `sed -n '/&lt;architecture&gt;/,/&lt;\/architecture&gt;/p' PLAN_PATH` | full architecture section |
| module-list | `grep '&lt;COMPONENT-' PLAN_PATH` | architecture component identities |
| extract-component | `sed -n '/&lt;COMPONENT-UPPER-SLUG&gt;/,/&lt;\/COMPONENT-UPPER-SLUG&gt;/p' PLAN_PATH` | one component by slug |
| list-tasks | `grep '&lt;TASK-T-' PLAN_PATH` | all task ids in document order |
| extract-task | `sed -n '/&lt;TASK-T-NNN&gt;/,/&lt;\/TASK-T-NNN&gt;/p' PLAN_PATH` | one full task by id |
| extract-snippet | `sed -n '/&lt;TASK-T-NNN&gt;/,/&lt;\/TASK-T-NNN&gt;/p' PLAN_PATH \| sed -n '/&lt;snippet&gt;/,/&lt;\/snippet&gt;/p'` | only the task snippet |
| extract-acceptance | `sed -n '/&lt;TASK-T-NNN&gt;/,/&lt;\/TASK-T-NNN&gt;/p' PLAN_PATH \| sed -n '/&lt;acceptance&gt;/,/&lt;\/acceptance&gt;/p'` | task acceptance criteria |
| task-file | `sed -n '/&lt;TASK-T-NNN&gt;/,/&lt;\/TASK-T-NNN&gt;/p' PLAN_PATH \| grep '&lt;file&gt;'` | target file for a task |
| task-status | `sed -n '/&lt;TASK-T-NNN&gt;/,/&lt;\/TASK-T-NNN&gt;/p' PLAN_PATH \| grep '&lt;status&gt;'` | task status |
| dependency-graph | `grep '&lt;task_id&gt;' PLAN_PATH` | all task dependencies |
| task-deps | `sed -n '/&lt;TASK-T-NNN&gt;/,/&lt;\/TASK-T-NNN&gt;/p' PLAN_PATH \| grep '&lt;task_id&gt;'` | dependencies for a task |
| count-tasks | `grep -c '&lt;TASK-T-' PLAN_PATH` | total tasks |
| all-files | `grep '&lt;path&gt;' PLAN_PATH` | all file paths in the plan |
| verification-commands | `grep '&lt;command&gt;' PLAN_PATH` | all verification commands |
</artifact>

<refs>
- `references/tool-contracts.md` — generated nine-tool contract reference; load only the tool section you need instead of the whole manual.
</refs>

<done>
All tasks are complete, acceptance criteria passed, required reviews passed or declared checkpoints verified, and task or wave commits are complete. Then prepare archival: ensure .vvoc/specs/archive/ exists, resolve a non-clobbering destination .vvoc/specs/archive/&lt;id&gt;-&lt;timestamp&gt;/, update the linked spec and plan top-level statuses to applied, move the entire .vvoc/specs/&lt;id&gt;/ directory there, commit the workflow-state change separately, and report the selected mode, completed tasks, changed files, acceptance outcome, and archive paths. If the archive move fails, stop and report the exact source and destination paths; do not claim execution is complete. In delegated mode, complete: true on the final checkpoint is required before archival. After the summary, ask the user whether they want a review; vv-review can check the implementation against the spec.
</done>
