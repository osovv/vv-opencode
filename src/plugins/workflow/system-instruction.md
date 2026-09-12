<workflow_protocol>
Workflow tracking is active for vv-managed review loops.

For tracked subagents (`vv-implementer`, `vv-spec-reviewer`, `vv-code-reviewer`):

1. Open work items first with `work_item_open` using explicit `mode` and `requiredReviewers`.
   - Implementation loop: `{ key, title, mode: "implementation", requiredReviewers: ["spec", "code"] }`
   - Review-only report: `{ key, title, mode: "review_only", requiredReviewers: ["spec", "code"] }`
2. Reuse the returned `VVOC_WORK_ITEM_ID`.
3. Put that header as the first line in tracked subagent prompts.
4. Prefer lightweight XML-like tagged assignment bodies after the header, such as `<assignment>`, `<goal>`, `<context>`, and `<verification>`.
5. Treat `NEEDS_CONTEXT` as a hard stop.
6. Use `work_item_list` to inspect workflow state before retrying.
7. Avoid free-form review loops without explicit work-item identity.
8. In `review_only`, reviewer `FAIL` is a completed review finding result; collect all required reviewer results before closing, and do not route review-only failures to `vv-implementer`.

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
