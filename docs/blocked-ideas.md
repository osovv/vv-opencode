# Blocked Ideas

Date: 2026-04-20
Project: `@osovv/vv-opencode`

This file tracks ideas worth revisiting later that are currently blocked by OpenCode core, plugin APIs, or SDK/runtime limitations.

## How To Use

- Add new blocked ideas at the top.
- Capture the desired behavior, the exact blocker, and what would need to change upstream.
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

Status: blocked
Date: 2026-04-20
Owner: vvoc

Desired behavior:

Provide a Claude-Code-like `/btw "question"` command in OpenCode sessions for quick side questions.

Why we want it:

Keep short contextual questions out of the main conversation while still letting the user ask about what the agent already knows.

Current blocker:

OpenCode supports custom slash commands, subagents, agents, and plugin hooks, but it does not appear to expose a native side-question primitive with Claude Code's semantics.

The missing behavior is the combination of all of the following:

- full visibility into the current session context
- no tool access
- no persistence in conversation history
- ephemeral overlay-style answer instead of a normal transcript turn
- ability to run independently while the main turn is still running

A custom OpenCode command can approximate only part of this behavior. It can be named `/btw` and can restrict tools, but it does not appear to give us a way to suppress history writes or render the response as an ephemeral side panel/overlay.

What would unblock it:

Any upstream OpenCode capability that provides one of these paths:

- a built-in side-question command API
- a plugin hook or SDK method for ephemeral, non-transcript responses
- command/session metadata that marks a command result as non-persistent
- a TUI extension point for overlay responses detached from normal chat history

Notes:

- If OpenCode later adds ephemeral command responses, revisit whether `vvoc` should implement `/btw` as a managed command, a plugin feature, or an upstream contribution.
- Relevant docs checked during investigation: Claude Code `commands` and `interactive-mode`; OpenCode `commands`, `agents`, `plugins`, `config`, and `tui`.
