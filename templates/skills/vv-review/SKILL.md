---
name: vv-review
description: Use for review requests — routes to reviewer sub-agents through a vvoc review-only workflow, reports findings, and stops before fixes
---

<scope>
Route review requests to the appropriate vvoc reviewer sub-agents and present findings. Your output is the review report: do NOT implement fixes and do NOT delegate to implementers.

Review only the pinned snapshot you were given. If the covered files change during the review, say so explicitly instead of reviewing a moving tree.
</scope>

<workflow>
1. Route this request as a review_only vvoc workflow.
2. Decide what kind of review is needed:
   - Spec review (vv-spec-reviewer): when checking against a spec or acceptance criteria.
   - Code review (vv-code-reviewer): when checking for bugs, regressions, maintainability, or security.
   - Both: when the request calls for comprehensive review.
3. Open one review-only work item with work_item_open before dispatching tracked reviewer sub-agents. Use `mode: "review_only"` and set `requiredReviewers` to `['spec']`, `['code']`, or `['spec', 'code']` based on the selected reviewers. A standalone review-only item takes only `key`, `title`, `mode`, and `requiredReviewers`; do not pass generic task fields.
4. Put the work item's returned `header` as the first meaningful line of each reviewer sub-agent prompt, exactly `VVOC_WORK_ITEM_ID: wi-<n>`: colon after the id, nothing else on that line (no `=`, no trailing prose). Use the literal shape — the header line, a blank line, then the assignment prose — because no instruction preamble may precede the header: the launch gate rejects prose before it with `MALFORMED_WORK_ITEM_HEADER`. Reviewer results report `PASS`, `FAIL`, or `NEEDS_CONTEXT` and carry no route. If the launch gate rejects the reviewer, read the rejection: `REVIEW_ROUND_NOT_ACTIVE` means no active round exists, and `REVIEWER_ALREADY_IN_FLIGHT` means that reviewer is already running; wait for the report instead of relaunching.
5. Collect findings from each required reviewer. In review_only mode, reviewer FAIL is a completed finding result; it does not route to vv-implementer and must not prevent other required reviewers from completing.
6. Close the work item with work_item_close after the review is complete.
</workflow>

<rules>
- Findings are the FINAL output. Do NOT proceed to fixes without explicit user confirmation.
- When the request is a re-review after a fix, scope the reviewer packets to a scoped re-review: verify the prior findings against the fix and the fix's material effects — including directly affected consumers where necessary — rather than re-reviewing an entire unchanged change from scratch. Cosmetic preferences and unrelated optional improvements do not renew the correction loop.
- Present findings honestly: "no findings" means no defect was discovered within the reviewed scope, not a guarantee of correctness. Note material verification gaps and what the review could not establish; do not turn an empty findings list into a completion or correctness claim.
- When this review is a delegated-execution checkpoint review, the linked review work item is already open with the declared reviewer set: launch exactly those reviewers with the returned header and report the collected findings. A FAIL report closes the review work item but never satisfies the checkpoint — completion is decided by work_checkpoint verify, not by this skill.
</rules>

<artifact>
Finding format:
`[Severity] path:line (symbol/scope) — what is wrong, why it matters, and the expected fix direction`

Severities:
- Critical: bug, crash, data loss, security issue.
- Important: missing feature, wrong behavior, spec violation.
- Minor: style, clarity, improvement suggestion.
</artifact>

<done>
Every required reviewer reported, the findings report is presented, and the work item is closed. Stop before any fix.
</done>
