# Blocked Ideas

Date: 2026-04-20
Project: `@osovv/vv-opencode`

This file tracks ideas worth revisiting later that are blocked by OpenCode core, plugin APIs, or SDK/runtime limitations, and preserves the outcome when a blocker is later removed.

## How To Use

- Add new blocked ideas at the top.
- Capture the desired behavior, the exact blocker, and what would need to change upstream.
- When upstream capabilities remove a blocker, mark the entry `unblocked`, record the re-evaluation date and evidence, and retain any remaining limitations.
- Keep entries concrete enough that a future session can quickly re-evaluate them.

## Entry Template

### Idea: `<short-name>`

Status: blocked
Date: YYYY-MM-DD
Owner: vvoc

Desired behavior:

Why we want it:

Current blocker:

What would unblock it:

Notes:

## Entries

### Idea: builtin `websearch`/`webfetch` provider override

Status: blocked
Date: 2026-04-20
Owner: vvoc

Desired behavior:

Let `vvoc` replace OpenCode builtin `websearch` and `webfetch` by name while keeping the same tool interfaces and routing execution to external providers.

Why we want it:

Support pluggable external web providers without changing prompts, agent expectations, or downstream tool semantics.

Current blocker:

OpenCode custom tools do take precedence over builtins by name, so name collision itself is not the blocker. The blocker is capability parity between builtin tools and custom/plugin tools.

- Current upstream `@opencode-ai/plugin` `ToolResult` on `dev` is still `string | { output, metadata? }`, not full builtin-style structured results with `title` and `attachments`.
- OpenCode issue `#21383` tracks that plugin tools cannot return image attachments even though internal tools can.
- OpenCode PR `#12050` proposes aligning plugin tool types with builtin tool capabilities, including structured results and attachments, but it is not merged yet.
- Local repro against released OpenCode `1.4.6` showed that overriding builtin `webfetch` by name works for plain string output, but object results crashed at runtime with `J.split is not a function` instead of behaving like builtin `webfetch`.

What would unblock it:

- Merge and release an upstream fix equivalent to PR `#12050`, including stable runtime support for structured custom tool results.
- Confirm in a released OpenCode build that same-name custom overrides work reliably for both `websearch` and `webfetch`.
- For `webfetch`, ensure custom/plugin tools can return `title` and `attachments` with the same downstream behavior as builtin tools.

Notes:

- Current fallback is to disable builtin `websearch` and `webfetch` via `tools` config and expose `vvoc`-managed `web_search` and `web_fetch` instead.
- Relevant upstream links:
- `https://github.com/anomalyco/opencode/issues/21383`
- `https://github.com/anomalyco/opencode/pull/12050`

### Idea: `/btw` side-question command

Status: unblocked
Date: 2026-04-20
Re-evaluated: 2026-08-03
Owner: vvoc

Desired behavior:

Provide a Claude-Code-like `/btw "question"` command in OpenCode sessions for quick side questions.

Why we want it:

Keep short contextual questions out of the main conversation while still letting the user ask about what the agent already knows.

What changed:

Modern OpenCode 1.18.x exposes a TUI plugin API that is sufficient to implement the side-question workflow without changing OpenCode core. A TUI plugin can register `/btw`, read the active session's messages and parts, render an overlay through the top-level app slot, create and prompt a separate temporary session asynchronously, deny all tools, and delete that session when the overlay closes.

This supports the important user-facing behavior:

- access to a bounded snapshot of the exposed current session context
- no tool access
- no additions to the parent conversation history
- ephemeral overlay-style answer instead of a normal transcript turn
- ability to run independently while the main turn is still running

Remaining limitations:

- The stable OpenCode release does not yet include a native `/btw` command.
- A standalone plugin can snapshot the exposed session messages and tool parts, but it cannot reliably reuse the parent's exact model-visible system/instruction prefix or provider prompt-cache prefix.
- The practical implementation uses a temporary child session that exists in OpenCode storage until the plugin deletes it, while keeping the parent transcript unchanged.

Exact Claude Code parity would benefit from the narrow side-question endpoint proposed by upstream PR `#21002`, which reuses canonical parent context without adding the question or answer to session history.

Supported implementation direction:

- Add `/btw` to the existing `@osovv/vv-opencode/tui` module alongside `/context`.
- Open a dismissible overlay, snapshot bounded parent context, and run a tool-free `promptAsync` request in a temporary child session.
- Abort and delete the temporary session on cancellation or close so the parent session and its queue remain untouched.

Notes:

- The native OpenCode feature request remains open and is currently labelled for the 2.0 line.
- PR `#21002` is the active native proposal; PR `#18635` was an earlier closed background-session implementation.
- Community TUI plugins such as `opencode-mini-session`, `opencode-sidechat`, and `opencode-bytheway` demonstrate that overlay and temporary-session variants work on current OpenCode releases.
- Relevant upstream links:
  - `https://github.com/anomalyco/opencode/issues/16992`
  - `https://github.com/anomalyco/opencode/pull/21002`
  - `https://github.com/anomalyco/opencode/pull/18635`
