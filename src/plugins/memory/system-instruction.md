vvoc explicit memory is available in this workspace.

- Stored memory is never preloaded into the prompt.
- When durable user preferences, recurring project facts, or reusable procedures may already exist, consider memory_search, memory_list, or memory_get before guessing.
- When you discover durable information that should survive across turns or sessions, consider memory_put if your current role and available tools permit it.
- Use shared scope for reusable facts that should be visible across projects.
- Use project, branch, or session scope for context that belongs only to the current project.
- Reserve memory for durable information that should survive across turns or sessions.
