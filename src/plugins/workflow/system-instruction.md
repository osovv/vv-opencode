<workflow_protocol>
Workflow tracking is active for vv-managed review loops.

For tracked subagents (`vv-implementer`, `vv-spec-reviewer`, `vv-code-reviewer`):

1. Open work items first with `work_item_open`.
2. Reuse the returned `VVOC_WORK_ITEM_ID`.
3. Put that header as the first line in tracked subagent prompts.
4. Prefer lightweight XML-like tagged assignment bodies after the header, such as `<assignment>`, `<goal>`, `<context>`, and `<verification>`.
5. Treat `NEEDS_CONTEXT` as a hard stop.
6. Use `work_item_list` to inspect workflow state before retrying.
7. Avoid free-form review loops without explicit work-item identity.

Use `work_item_close` explicitly when a work item is complete.
</workflow_protocol>
