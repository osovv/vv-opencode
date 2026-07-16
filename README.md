# @osovv/vv-opencode

**Curated, opinionated OpenCode plugin set** for spec-first, review-driven, safer agentic development — with managed agents, skills, safety plugins, and the `vvoc` CLI.

<p>
  <a href="https://www.npmjs.com/package/@osovv/vv-opencode"><img src="https://img.shields.io/npm/v/%40osovv%2Fvv-opencode?style=flat&label=npm&color=blue" alt="npm"></a>
  <a href="https://github.com/osovv/vv-opencode/actions/workflows/publish.yml"><img src="https://github.com/osovv/vv-opencode/actions/workflows/publish.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/osovv/vv-opencode/releases"><img src="https://img.shields.io/github/v/release/osovv/vv-opencode?style=flat&label=release" alt="release"></a>
  <a href="https://github.com/osovv/vv-opencode"><img src="https://img.shields.io/github/stars/osovv/vv-opencode?style=flat&color=yellow" alt="stars"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-bun-%23f9f9f9?style=flat&logo=bun" alt="bun"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/osovv/vv-opencode?style=flat&color=green" alt="MIT"></a>
</p>

---

## Quick Start

```bash
bun add -g opencode-ai@1.18.2
bun add -g @osovv/vv-opencode
vvoc install
```

That's it. `vvoc install` pins the server plugin, registers the same pinned package for OpenCode to load its `/context` TUI export, scaffolds managed agents and skills, writes canonical config, and sets `vv-controller` as your default OpenCode agent with auto-triggered spec, planning, review, reflection, and handoff skills. The TUI integration requires OpenCode `1.18.2` or newer; `vvoc status` and `vvoc doctor` report the installed host version and fail compatibility checks for older releases.

To scope everything to the current project instead of the global OpenCode config:

```bash
vvoc install --scope project
vvoc launch --scope project
```

Project scope writes only to `./.opencode/` and `./.vvoc/`. A normal `opencode` launch may still apply OpenCode's native config discovery and merge behavior; `vvoc launch --scope project` is the hard sandbox path and starts OpenCode with `OPENCODE_CONFIG`, `OPENCODE_TUI_CONFIG`, and `VVOC_CONFIG` pinned to the selected local files, so you can smoke-test vv-opencode in one repository without mutating your primary global setup.

> **Already installed?** Run `vvoc sync` anytime to refresh plugins, prompts, skills, and presets.

---

## 1.0 Stability Posture

`vv-opencode` 1.0 marks the workflow as a daily-driver baseline: a hand-picked, curated OpenCode setup that packages the agent routing, managed skills, model-role indirection, safer editing, review loops, and release discipline used in real projects.

The stable user-facing surface is intentionally practical:

- `vvoc install` / `vvoc sync` / `vvoc launch` remain the primary setup and refresh path.
- `vv-spec`, `vv-plan`, and `vv-execute` remain the canonical spec-to-code path for larger work.
- `vv-review`, `vv-reflect`, and `vv-handoff` remain the auxiliary review, durable-learning, and session-continuity workflows.
- The published package exports, CLI command names, canonical vvoc schema v3, and date-prefixed `.vvoc/specs/YYYY-MM-DD-<slug>/` artifact layout are treated as compatibility surfaces.

The project still prefers conservative, explicit changes over hidden migration magic: user-owned config is not silently clobbered, invalid current config fails loudly, and breaking workflow or config changes must be documented in release notes.

---

## Spec-to-Code Pipeline

vvoc keeps larger agentic work from jumping straight into edits. The process turns a request into explicit artifacts first, then executes the approved plan with bounded implementation and review loops.

```
Request / idea
   ↓
vv-spec
   asks clarifying questions
   writes .vvoc/specs/YYYY-MM-DD-<slug>/spec.xml
   waits for spec approval
   ↓
vv-plan
   reads the approved spec
   writes .vvoc/specs/YYYY-MM-DD-<slug>/plan.xml
   defines tasks, contracts, dependencies, and acceptance criteria
   waits for plan approval
   ↓
vv-execute
   applies the approved plan task by task
   runs implementation + review internally
   verifies before moving on
   ↓
Verified result
```

Inside `vv-execute`:

```text
Each plan task
   ↓
vv-implementer
   implements the focused task and runs targeted verification
   ↓
vv-spec-reviewer
   checks whether the result matches the approved spec
   ↓
vv-code-reviewer
   checks bugs, regressions, maintainability, and missing tests
   ↓
verification
   pass → next task
   fail → bounded retry loop
   needs context / blocked → stop and ask the user
```

All artifacts for one feature live together:

```text
.vvoc/specs/YYYY-MM-DD-<slug>/
  spec.xml            # what should be built and why
  design-context.xml  # optional design memory
  plan.xml            # how to implement and verify it
```

New `vv-spec` packages use a date-prefixed id (`YYYY-MM-DD-<slug>`, for example `2026-06-24-cache-store`) so active packages sort by creation date. The prefix is date-only; it must not include hours, minutes, seconds, timezone, or a full ISO timestamp.

Specs and plans use a top-level lifecycle status: `draft` while being written, `approved` after explicit user approval, and `applied` after successful execution. `vv-execute` archives applied artifact packages by moving the entire spec package directory `.vvoc/specs/YYYY-MM-DD-<slug>/` to `.vvoc/specs/archive/YYYY-MM-DD-<slug>-<timestamp>/`.

### XML grep

Plans and specs are XML documents, making every element grep-able:

```bash
# Extract tasks from plan
grep '<id>T-' .vvoc/specs/*/plan.xml

# Extract all acceptance criteria
grep '<criterion>' .vvoc/specs/*/plan.xml

# Extract dependency graph
grep '<task_id>' .vvoc/specs/*/plan.xml

# Extract method signatures
grep '/\*\*' .vvoc/specs/*/plan.xml

# Extract all modules from architecture
grep '<name>' .vvoc/specs/*/plan.xml
```

Managed skills are installed by `vvoc`. `vv-controller` explicitly routes `vv-spec`, `vv-plan`, and `vv-review`; `vv-execute`, `vv-reflect`, and `vv-handoff` are available as managed skills for plan execution, durable repository memory, and end-of-session handoff notes.

---

## Why vv-opencode?

OpenCode is a strong, flexible base for agentic coding, but it intentionally leaves the development process mostly up to you: when to clarify requirements, when to plan, when to investigate first, when to review, and how to keep longer runs safe. That flexibility is powerful, but it can also make agent work feel loose and inconsistent.

**vv-opencode adds a curated process layer on top of OpenCode:**

- **Formalized trajectories** — small changes stay direct, unclear bugs start with investigation, large changes go through spec and plan, and risky implementation uses review loops
- **Spec-first by default** — turn broad requests into explicit specs, plans, and review gates before implementation
- **Review-driven execution** — keep implementation, spec review, and code review as separate steps instead of one agent silently doing everything
- **Portable model choices** — use roles like `vv-role:smart` and `vv-role:fast` in shared agents, then map those roles per machine or project
- **Long-run safety** — Guardian auto-approves routine low-risk permission requests, leaves risky ones to OpenCode's manual approval flow, and secrets redaction reduces accidental leakage
- **Safer edits** — hashline-backed `edit` ties changes to fresh `read` output so agents are less likely to write against stale line numbers

---

## Features

| Area | What you get |
|---|---|
| **Plugins** | A curated set of OpenCode plugins that make agentic work more structured, portable, and safer without hand-wiring each piece yourself |
| **Agent System** | A default controller (vv-controller) that follows the concrete work policy selected by the orchestration profile |
| **Skills** | Guided workflows for turning ideas into specs, specs into plans, plans into execution, reviews into findings, and long sessions into reusable memory |
| **Spec-to-Code Pipeline** | A repeatable path from request → spec → plan → implementation → review, so agents do not silently skip requirements or acceptance criteria |
| **One-Click Setup** | Recreate the same opinionated workflow on a new machine or project with `vvoc install` / `vvoc sync` |
| **CLI Tooling** | Operate and diagnose the setup from one CLI: install, sync, launch, status, doctor, roles, presets, orchestration profiles, plugin toggles, completion, and upgrade |
| **Long-Run Safety** | Guardian keeps safe long/AFK runs moving by auto-approving routine low-risk permissions, while risky actions stay in OpenCode's manual approval flow; secrets redaction reduces accidental leakage |
| **Model Roles** | Put roles like `vv-role:smart` or `vv-role:fast` in shared agents and skills instead of hardcoded model IDs, then choose provider/model mappings per environment |
| **Orchestration Profiles** | Select a concrete work policy — single-session, balanced, or orchestrated — to control how vv-controller delegates. Built-in presets pick a sensible default and status reports the effective profile. |
| **Workflow Tracking** | Replace free-form multi-agent chaos with explicit work items, bounded review rounds, reviewer result collection, and hard stops when more context is needed |
| **Context Inspector** | Run `/context` in an active OpenCode TUI session for Overview, Tools, and MCP tabs with provider-reported usage, approximate context-window percentages, active post-compaction tool history, and deterministic source attribution |

---

## The Seven Plugins

| Plugin | What it helps you do |
|---|---|
| **WorkflowPlugin** | Keep multi-agent work structured with explicit work items, bounded implementation/review loops, reviewer result collection, and safe stops when more context is needed. |
| **ModelRolesPlugin** | Use semantic model roles instead of hardcoded model IDs in OpenCode agents, subagents, and command configs — e.g. `vv-role:smart`, `vv-role:fast` — then map those roles per machine or project. |
| **GuardianPlugin** | Keep long or AFK agent runs moving by auto-approving routine low-risk permission requests. If something looks risky, Guardian does not auto-approve it and leaves the decision to OpenCode's normal manual approval flow. |
| **HashlineEditPlugin** | Make agent edits safer by tying changes to fresh `read` output, reducing wrong-line and stale-context edits. |
| **SystemContextInjectionPlugin** | Inject universal primary guidance plus one startup-resolved orchestration policy into vv-controller, with skill discovery and subagent-only explore worker prompts. |
| **SecretsRedactionPlugin** | Reduce accidental secret leakage by redacting tokens, keys, emails, and other sensitive values before messages are sent to the model. |
| **ContextTuiPlugin** | Add a native scrollable `/context` dialog with measured usage plus detailed observable per-tool and per-MCP schema/history estimates, explicitly marking data that OpenCode does not expose. |

Workflow work items are opened with explicit intent. For implementation loops, controllers use:

```json
{
  "items": [
    {
      "key": "implement-feature",
      "title": "Implement feature",
      "mode": "implementation",
      "requiredReviewers": ["spec", "code"]
    }
  ]
}
```

For review-only reports, use `"mode": "review_only"`. In review-only mode, reviewer `FAIL` is a completed finding result: required reviewers are collected independently, parallel `spec` and `code` reviewers may both return `FAIL`, and the item does not route to `vv-implementer` unless the user explicitly requests fixes.

### `/context` accuracy

Run `/context` inside an active session. Its bounded host-owned dialog has three tabs: **Overview**, **Tools**, and **MCP**. Use left/right arrows or `1`, `2`, and `3` to switch tabs and up/down to scroll long detail. The measured header remains visible on every tab. Top-line used/remaining values come from the latest assistant turn's provider-reported input, cache-read, and output token counts when OpenCode exposes them.

Overview category rows remain provider-neutral estimates derived from observable TUI/SDK state: system instructions, skill catalog, loaded skills, tool schemas, user and assistant messages, tool calls and results, files, and the latest compaction summary. Percentages are always `estimated tokens / current model contextLimit`; if OpenCode does not expose a positive current limit, the percentage is shown as an em dash rather than using another denominator. Numeric percentages may exceed 100% when estimates drift, while visual bars clamp only their fill at 100%.

The Tools tab separates each observable current tool's persistent **schema** estimate from its active **history** estimate, call count, combined total, source, and percentages. When a schema catalog is unavailable, the row says `schema unavailable` and labels the history-only subtotal as `known total` rather than presenting a false zero. History includes only tool parts in the active context: the latest compaction summary and subsequent turns. Pending and running calls include observable input; completed calls include output and failed calls include errors. The `skill` tool remains visible in detail, but its history continues to belong to Overview's `Loaded skill results` category so it is not double-counted as `Tool calls and results`.

The MCP tab aggregates observable current schema and retained active history by server and nests the attributed tools. OpenCode 1.18.x does not expose connected MCP tool definitions through its public TUI/SDK tool catalog, so connected servers show `current tools unavailable` and `schema unavailable`; their `known total` includes retained history only, while the unexposed schema overhead remains in `Unknown/provider-only`. `disabled`, `failed`, `needs_auth`, and `needs_client_registration` servers have a known zero current schema, while matching call history can remain visible until compaction removes it. Attribution follows OpenCode's sanitized `<server>_<tool>` naming contract with unique longest-prefix matching. Sanitized collisions or other ambiguous ownership fail closed under **Other external/plugin** with a bounded warning instead of being guessed.

The plugin does **not** claim to reconstruct the exact final provider request or provide provider-exact tokenization. Hidden provider transformations, plugin-added data, or otherwise unattributable content appears as `Unknown/provider-only`; when visible estimates exceed provider usage, the dialog reports estimation drift instead of forcing totals to match. Collection reuses OpenCode's existing tool catalog, active parts, model metadata, and MCP status snapshot without issuing extra MCP requests.

The `context` vvoc plugin toggle defaults to enabled. Disable it with `vvoc plugin disable context`, then restart OpenCode.

---

## CLI at a Glance

| Command | Purpose |
|---|---|
| `vvoc init` | Interactive bootstrap flow |
| `vvoc install` | Non-interactive setup and scaffolding |
| `vvoc sync` | Refresh runtime/TUI plugin entries, agents, prompts, skills, config |
| `vvoc launch` | Launch OpenCode with deterministic runtime, TUI, and vvoc config sources |
| `vvoc status` | Show current installation state, including OpenCode version compatibility and TUI registration |
| `vvoc doctor` | Diagnose OpenCode version/runtime/TUI/vvoc setup problems (exits non-zero on issues) |
| `vvoc config validate` | Validate canonical `vvoc.json` |
| `vvoc role list\|set\|unset` | Manage model role assignments |
| `vvoc preset list\|show\|<name>` | Inspect or apply named presets |
| `vvoc guardian config` | Print or write guardian section |
| `vvoc plugin list` | List OpenCode plugin entries |
| `vvoc plugin enable\|disable` | Toggle a vvoc-managed plugin on or off |
| `vvoc orchestration show\|set` | Show or set the vv-controller orchestration profile |
| `vvoc patch-provider stepfun-ai\|zai\|codex` | Patch an OpenCode provider; `codex` adds subscription-safe OpenAI aliases and also accepts `openai` for compatibility |
| `vvoc completion` | Install shell completions |
| `vvoc upgrade` | Upgrade global package and run follow-up sync; sync failure is reported as a partial upgrade |
| `vvoc version` | Print installed version |

---
---

## Orchestration Profiles

Three concrete policies control how vv-controller delegates work at runtime:

- `single-session`: vv-controller performs exploration, investigation, planning, implementation,
  and verification directly. Independent reviewer subagents remain available when the user
  explicitly requests review or when a materially risky completed change benefits from independent
  cross-model evaluation.
- `balanced`: vv-controller keeps architecture, critical reading, and final synthesis in the
  primary session and may selectively delegate bounded search, investigation, mechanical
  implementation, or review when that is the lightest safe route. Delegation is optional, not
  mechanically mandatory.
- `orchestrated`: vv-controller uses the full tracked implementer/reviewer workflow with
  explicit work items, required reviewers, bounded rounds, and hard stops.

Pick a profile explicitly or let a built-in preset select one:

```bash
vvoc orchestration show --scope effective
vvoc orchestration set single-session --scope project
```

Built-in presets declare an orchestration mapping:

| Preset | Profile |
|---|---|
| `vv-codex` | single-session |
| `vv-osovv` | single-session |
| `vv-osovv-cheap` | single-session |
| `vv-zai` | balanced |
| `vv-minimax` | balanced |
| `vv-deepseek` | balanced |

Applying a built-in preset changes both model roles and the root orchestration profile
atomically. A custom user-defined preset without an orchestration section preserves the current
root profile. `vvoc status` reports the profile resolved from the selected vvoc source; effective
status with no config files reports `balanced`.

### Prompt-only first version

Profiles are enforced through the concrete policy injected into vv-controller at startup —
the model only receives its active work instructions and does not see inactive profile alternatives.
The first version does not disable tools, change permissions, or block subagent types; the policy
is prompt-driven and asynchronous vv-execute classic mode remains available through that skill's
explicit inline/classic selection.

### Restart requirement

Config changes to the orchestration profile take effect after an OpenCode restart. Runtime plugins
resolve the profile once from the startup vvoc config snapshot and do not live-reload.

## Model Roles & Presets

```bash
# View current assignments
vvoc role list
vvoc role list --scope effective

# Assign models to roles
vvoc role set default openai/gpt-5.4
vvoc role set team-review anthropic/claude-sonnet-4-5 --scope project
vvoc role set smart openai/vv-codex-gpt-5.5-xhigh
vvoc role set fast openai/gpt-5.4-mini

# Switch provider presets
vvoc preset vv-codex
vvoc preset vv-zai
vvoc preset vv-deepseek
vvoc preset vv-minimax
vvoc preset vv-osovv
vvoc preset vv-osovv-cheap
```

Built-in role IDs: `default`, `smart`, `fast`, `vision` + any custom lowercase-hyphenated IDs.

Presets are partial — applying one only changes the roles it defines. Managed built-in presets (`vv-*`) are refreshed on every `vvoc install`/`vvoc sync`; user-defined presets are preserved as-is.

---

## Config & Data Layout

Mutating commands default to global for backward compatibility. Add `--scope project` to write a project-local layer. Read/diagnostic commands accept `--scope global|project|effective`, where `effective` resolves in this order:

1. explicit env override (`VVOC_CONFIG` / `OPENCODE_CONFIG` / `OPENCODE_TUI_CONFIG`)
2. nearest project layer
3. global layer
4. built-in defaults when the command/runtime permits defaults

Canonical project-local paths:

```text
OpenCode config          → ./.opencode/opencode.json(c)
OpenCode TUI config      → ./.opencode/tui.json(c)
vvoc config              → ./.vvoc/vvoc.json
Managed agent prompts    → ./.vvoc/agents/*.md
Managed skills           → ./.vvoc/skills/*/SKILL.md
Spec package directory   → ./.vvoc/specs/YYYY-MM-DD-<slug>/
  spec.xml              # normative spec document (required)
  design-context.xml    # curated design memory (optional)
  plan.xml              # implementation plan (created by vv-plan)
Handoff notes            → ./.vvoc/handoff/YYYY-MM-DD-<session-slug>/handoff.xml

```

Legacy root-level `./opencode.json` and `./opencode.jsonc` are intentionally not used as vvoc project layers.

```
Global OpenCode config   → $XDG_CONFIG_HOME/opencode/opencode.json
Global OpenCode TUI      → $XDG_CONFIG_HOME/opencode/tui.json(c)
Global vvoc config       → $XDG_CONFIG_HOME/vvoc/vvoc.json
Managed agent prompts    → $XDG_CONFIG_HOME/vvoc/agents/*.md  (global)
                           ./.vvoc/agents/*.md                 (project)
Managed skills           → $XDG_CONFIG_HOME/vvoc/skills/*/SKILL.md  (global)
                           ./.vvoc/skills/*/SKILL.md               (project)
Spec documents           → ./.vvoc/specs/YYYY-MM-DD-<slug>/spec.xml
Optional design context  → ./.vvoc/specs/YYYY-MM-DD-<slug>/design-context.xml
Implementation plans     → ./.vvoc/specs/YYYY-MM-DD-<slug>/plan.xml
Persisted data           → $XDG_DATA_HOME/vvoc/
Repository memory       → ./.vvoc/lessons/*.xml              (lazy vv-reflect fallback)
                           ./.vvoc/runbooks/*.xml             (lazy vv-reflect fallback)
Session handoff notes   → ./.vvoc/handoff/YYYY-MM-DD-<session-slug>/handoff.xml
```

Schema is versioned and published with the package — source of truth at `schemas/vvoc/v3.json`. The current config contract is strict: `vvoc.json` must be canonical version 3 and include required sections such as `plugins`. Existing v1/v2/pre-role, incomplete, malformed, or otherwise invalid config files fail instead of being migrated or repaired. `vvoc install` and `vvoc sync` may create a fresh canonical config when no config exists, but they refuse to rewrite an invalid existing `vvoc.json`; fix the file manually and rerun `vvoc sync`.

OpenCode intentionally keeps server/runtime plugins and native terminal UI plugins in separate configuration surfaces. `opencode.json(c)` is loaded by the core/server plugin runtime and activates vvoc features such as model roles, Guardian, workflow, hashline edit, and redaction. `tui.json(c)` is loaded by the terminal UI process and activates the package's `./tui` module, currently the `/context` inspector. The same pinned package version appears in both files, but OpenCode selects a different public export for each process; headless/server launches therefore do not need to load the Solid/OpenTUI UI module.

`vvoc install`, `vvoc init`, and `vvoc sync` conservatively add the pinned base package specifier (for example `@osovv/vv-opencode@X.Y.Z`) to dedicated `tui.json(c)`; OpenCode then selects the package's public `./tui` export. Sync migrates the broken legacy `@osovv/vv-opencode/tui` form and older managed pins. Existing comments, unrelated settings, unrelated plugin entries, and `[specifier, options]` tuples are preserved; malformed plugin entries fail without rewrite.

`vvoc status` and `vvoc doctor` are diagnostic exceptions: they report the installed OpenCode version, the `1.18.2` TUI minimum, selected runtime/TUI/vvoc config paths, and validation problems without normalizing or rewriting the files. `vvoc upgrade` can still finish the package installation when the follow-up `vvoc sync` fails; in that case it reports a partial upgrade, leaves config unchanged, and tells you to fix the invalid config manually before rerunning `vvoc sync`.

Runtime compatibility is current-only. Guardian permission replies use the current OpenCode permission reply path (with the current HTTP reply fallback), Hashline edit refs must use current hash/context anchors, and sync writes current managed agents without deleting old pre-rename user or command entries.

Runtime plugins load the effective `vvoc.json` once during OpenCode startup and share the same immutable config snapshot for the lifetime of the process. There is no live reload; restart OpenCode after changing `vvoc.json` or `tui.json(c)`.

### Deterministic local launch

Use `vvoc launch` when you want the vvoc-selected config files to be the only files OpenCode sees for this run:

```bash
vvoc install --scope project
vvoc launch --scope project -- run "hello"
```

`vvoc launch --scope project` is strict and non-mutating: if `.opencode/opencode.json` or `.vvoc/vvoc.json` is missing, it fails with a hint to run `vvoc install --scope project`. When the selected `.opencode/tui.json(c)` exists, launch also sets `OPENCODE_TUI_CONFIG`; a missing TUI file is not synthesized during launch. `--scope effective` follows the layered lookup order, and `--scope global` uses the global config paths.

### Test the local TUI before release

From this repository, launch OpenCode against the freshly built local `dist/tui.js` without publishing or rewriting your selected configs:

```bash
bun run tui:local
bun run tui:local -- -s <session-id>
bun run tui:local -- --scope project
```

The command defaults to `effective` config resolution. It builds the package, copies the selected `tui.json(c)` into a temporary isolated config home, replaces only the managed vv-opencode TUI entry with a local `file://` URL, preserves unrelated TUI settings and tuple options, and forwards remaining arguments to OpenCode. The original OpenCode, TUI, and vvoc config files are not modified, and the temporary config is removed after OpenCode exits. Restart the command after source changes because runtime plugins do not live reload.

---

## Managed Agents

All prompt files are scaffolded by `vvoc install` / `vvoc sync`:

| Agent | When it helps |
|---|---|
| `vv-controller` | Primary agent that follows the concrete work policy selected for the session by the orchestration profile |
| `enhancer` | Improves rough requests before execution when a clearer prompt would help |
| `vv-implementer` | Applies a focused approved change and verifies it before reporting completion |
| `vv-spec-reviewer` | Checks whether implementation matches the requested spec and acceptance criteria |
| `vv-code-reviewer` | Looks for bugs, regressions, maintainability risks, and missing tests |
| `investigator` | Finds the root cause first when behavior is unclear or a failure needs diagnosis |
| `guardian` | Supports GuardianPlugin by auto-approving routine low-risk permission requests and leaving risky ones for manual approval |

---

## Managed Skills

Six workflow skills are scaffolded alongside agents:

| Skill | When to use it | What it gives you |
|---|---|---|
| `vv-spec` | You have a feature or creative request and no agreed contract yet | A guided interview, recommended options, and a saved spec in `.vvoc/specs/YYYY-MM-DD-<slug>/spec.xml` |
| `vv-plan` | A spec is approved and ready to implement | A task-level implementation plan with file targets, contracts, dependencies, and acceptance criteria |
| `vv-execute` | A plan is approved and you want it applied step by step | Ordered execution with verification, explicit inline-or-classic mode choice, and applied spec/plan archival |
| `vv-review` | You want findings, not fixes | A review-only workflow that reports spec/code issues and stops before implementation |
| `vv-reflect` | A long development, debugging, ops, or investigation session produced reusable knowledge | Durable notes in existing docs or `.vvoc/lessons` / `.vvoc/runbooks` for future agents |
| `vv-handoff` | You are ending a session and want the visible context preserved for a future session | A redacted XML note at `.vvoc/handoff/YYYY-MM-DD-<session-slug>/handoff.xml`, without running new checks or collecting fresh context |

Spec and plan artifacts stay XML so requirements, tasks, acceptance criteria, and dependencies remain easy to grep and review.

`vv-reflect` creates `.vvoc/lessons` and `.vvoc/runbooks` lazily only after approved fallback writes. It prefers an existing repository documentation convention when there is a high-confidence match.

`vv-handoff` writes only the project-local XML handoff artifact from context already visible in the session. It records missing git, diff, or verification evidence as not collected in the current session instead of running commands.

Skills are loaded by OpenCode at session start through `config.skills.paths` (registered by the SystemContextInjectionPlugin). The `vv-controller` agent's `<skill_trigger_rule>` ensures they are invoked automatically when the user's request matches their trigger conditions.

---

## Local Development

```bash
bun install             # Install dependencies
bun run check           # Typecheck + lint + format check + test
bun run fmt             # Auto-format source files
bun run release:check   # Verify package/schema release consistency
```

Git hooks managed via `lefthook`.

### Smoke-test the built CLI

```bash
tmpdir="$(mktemp -d)"
bun run build
bun dist/cli.js install --config-dir "$tmpdir"
bun dist/cli.js status --config-dir "$tmpdir"
```

### Full release verification

```bash
bun run release:check
bun run check
bun run pack:check
```

---
## Publishing

The release flow is automated via a local wrapper and an exact-commit, CI-gated GitHub Actions workflow.

### Local bump

```bash
bun run release:bump patch   # or minor, major, prerelease, or explicit semver
```

This will:
1. Reject if the worktree is dirty
2. Bump `package.json` via `npm version --no-git-tag-version`
3. Generate a required AI release summary with `opencode --pure run`
4. Prepend a `### Summary` section plus conventional commit details to `CHANGELOG.md`
5. Update `schemas/vvoc/v3.json` `$id` to the new version
6. Run `release:check` for consistency
7. Create a release commit without creating a tag
8. Push only the current branch to `origin`
9. Dispatch `publish.yml` through `gh` with the exact package version and release commit SHA

Required local release prerequisite:
- `opencode` must be available from `PATH`.
- `gh` must be installed and authenticated with permission to dispatch workflows in the repository.
- The summary model defaults to `deepseek/deepseek-v4-flash`.
- Override with `VVOC_RELEASE_SUMMARY_MODEL=provider/model`.
- Override the per-attempt timeout with `VVOC_RELEASE_SUMMARY_TIMEOUT_MS=120000`.
Run `release:bump` from a checked-out branch with push access to `origin`. A normal branch push never publishes by itself; the wrapper explicitly dispatches the workflow for the exact pushed commit.

The GitHub Actions workflow checks out the requested commit SHA, verifies that its
`package.json` version matches the dispatch input, and runs full validation
(typecheck, lint, fmt check, tests, build, pack check, and `release:check`). Only
after every gate passes does it publish to npm with provenance, create and push the
annotated `vX.Y.Z` tag, and create the GitHub Release. A safe rerun accepts an
already-published version only when its npm `gitHead` matches the exact requested
commit, allowing tag or GitHub Release recovery without publishing different bytes.

### Checking consistency manually

```bash
bun run release:check
```

This verifies that `package.json` name, version, and `schemas/vvoc/v3.json` `$id` and
config format version are all consistent. Run it independently anytime.

### CI publish workflow

The workflow uses npm provenance/trusted publishing (`id-token: write`) and can only publish through an explicit `workflow_dispatch` request. Normal branch and tag pushes do not publish. Configure npm trusted publishing for this GitHub repository/package, or adapt the publish step to use an `NPM_TOKEN` secret if token-based publishing is required.

---

## License

MIT — see [LICENSE](LICENSE).
