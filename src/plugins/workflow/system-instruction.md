<workflow_protocol>
Workflow tracking is active for vv-managed review loops.

For tracked subagents (`vv-implementer`, `vv-spec-reviewer`, `vv-code-reviewer`):

1. Open work items first with `work_item_open` using explicit `mode` and `requiredReviewers`.
   - Implementation loop: `{ key, title, mode: "implementation", requiredReviewers: ["spec", "code"] }`
   - Review-only report: `{ key, title, mode: "review_only", requiredReviewers: ["spec", "code"] }`
2. Reuse the returned `VVOC_WORK_ITEM_ID`.
3. Put that exact header (`VVOC_WORK_ITEM_ID: <returned id>`) as the first line in tracked subagent prompts.
4. Prefer lightweight XML-like tagged assignment bodies after the header, such as `<assignment>`, `<goal>`, `<context>`, and `<verification>`.
5. Treat `NEEDS_CONTEXT` as a hard stop.
6. Use `work_item_list` to inspect workflow state before retrying.
7. Avoid free-form review loops without explicit work-item identity.
8. In `review_only`, reviewer `FAIL` is a completed review finding result; collect all required reviewer results before closing, and do not route review-only failures to `vv-implementer`.

Tracked result protocol (applies to every tracked launch):

- A tracked result begins on its first line with the protocol top block — no preface, prose, or code
  fence — followed by a blank line and the body.
- Use the exact `VVOC_WORK_ITEM_ID` returned by `work_item_open` for that assignment, never a sample
  id from another task.
- `vv-implementer` reports `DONE`, `DONE_WITH_CONCERNS`, `NEEDS_CONTEXT`, or `BLOCKED` and must
  include `VVOC_ROUTE`. `vv-spec-reviewer` and `vv-code-reviewer` report `PASS`, `FAIL`, or
  `NEEDS_CONTEXT` and carry no route.
- A result whose first field names a different work item is a work-item mismatch, not malformed
  syntax; it is never relabeled to the expected id.
- Inspect `work_item_list` before retrying so you reuse the current identity, state, attempt, and
  budget. These common calls follow the published input schemas and need no separate execution
  skill; `work_item_list` reports the loaded contract revision and the on-demand reference path at
  `contract.referencePath`.

Use `work_item_close` explicitly when a work item is complete.

Execution sources and authority:

- Requirements may come from a native `.vvoc/specs` package, a provided plan document, or the current
  conversation. Choose one source per execution; do not create native documents or a second lifecycle
  for a provided plan or conversation-scoped request.
- Required reviews come from the selected source, an explicit user instruction, or an explicit
  controller decision. Do not install a universal final-review pair; enforce exactly the obligations
  that were registered.
- When the user explicitly delegates autonomy, proceed through the delegated stages with truthful
  controller-delegated provenance, respect reserved stops, and disclose material decisions without
  turning each disclosure into a blocking question.
- BLOCKED and NEEDS_CONTEXT remain hard stops. Use a recorded bounded recovery or authorized advance
  reserve instead of unbounded retries, and never report a stopped or failed result as success.
  </workflow_protocol>
