# @osovv/vv-opencode

**An opinionated agentic development layer for OpenCode** — spec-first when it matters, review-driven execution, portable model roles, safer tools, and long-run safety. Under the hood it ships as a set of OpenCode plugins, managed agents, skills, and the `vvoc` CLI.

<p>
  <a href="https://www.npmjs.com/package/@osovv/vv-opencode"><img src="https://img.shields.io/npm/v/%40osovv%2Fvv-opencode?style=flat&label=npm&color=blue" alt="npm"></a>
  <a href="https://github.com/osovv/vv-opencode/actions/workflows/publish.yml"><img src="https://github.com/osovv/vv-opencode/actions/workflows/publish.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/osovv/vv-opencode/releases"><img src="https://img.shields.io/github/v/release/osovv/vv-opencode?style=flat&label=release" alt="release"></a>
  <a href="https://github.com/osovv/vv-opencode"><img src="https://img.shields.io/github/stars/osovv/vv-opencode?style=flat&color=yellow" alt="stars"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-bun-%23f9f9f9?style=flat&logo=bun" alt="bun"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/osovv/vv-opencode?style=flat&color=green" alt="MIT"></a>
</p>

OpenCode owns the mechanics: streaming, model invocation, sandboxing, permissions. The development *process* — when to clarify, when to plan, when to review, how to survive long runs — it leaves up to you.

vv-opencode adds that process layer. It is a hand-picked workflow crystallized from a year and a half of daily agentic development: you run `vvoc install`, learn three skills (`vv-spec`, `vv-plan`, `vv-execute`), and get a disciplined spec-to-code pipeline with review gates, portable model roles, and long-run safety — without needing to know how any of it works inside.

The spec pipeline is the most visible part, but it is only one layer. Everything underneath runs on every session whether or not you ever write a spec: each model edits files through the tool it knows best, routine permissions are approved without interrupting your run, secrets never reach the model, and multi-agent work is held together by an explicit state machine instead of prompt luck. If you already have your own spec tooling, keep it — the runtime layers below apply anyway.

---

## Why vv-opencode?

OpenCode is a strong, flexible base, but it intentionally leaves the development process up to you. Left to itself, agentic work tends to drift: requirements get skipped, one agent silently implements and "reviews" itself, multi-agent loops churn through "one more final review", long runs stall on permission prompts, and model choices are hardcoded everywhere.

vv-opencode addresses each of these:

- **Formalized trajectories** — small changes stay direct, unclear bugs start with investigation, large changes go through spec and plan, risky implementation uses review loops.
- **Spec-first by default** — broad requests become explicit specs, plans, and review gates before implementation, and every artifact is saved as grep-able XML.
- **Review-driven execution** — implementation, spec review, and code review are separate steps with bounded retries, not one agent silently doing everything.
- **A state machine for multi-agent work** — explicit work items, required reviewers, round limits, and hard stops instead of free-form subagent loops.
- **Portable model choices** — agents reference roles like `vv-role:smart` and `vv-role:fast`; you map roles to concrete models per machine or project and switch stacks with one preset command.
- **Per-model editing** — each model edits through the tool it knows best: DeepSeek gets its `str_replace_editor` contract, GLM/Qwen/Kimi use the host built-in `edit`, GPT keeps the host `apply_patch` path, and unmatched models get the plugin's `hashline_edit`. Routing is resolved dynamically per session and exposes exactly one edit tool to each model.
- **Provider-neutral web tools** — agents get one canonical `web_search` and `web_fetch` contract backed by Exa, Brave, Z.AI, native retrieval, or Spider, instead of provider-specific search and reader schemas leaking into your prompts.
- **Long-run safety** — Guardian auto-approves routine low-risk permissions (risky ones stay in OpenCode's manual approval flow), and secrets are redacted before they reach the model.
- **Reproducible setup** — `vvoc install` / `vvoc sync` recreate the same workflow on any machine or project.

---

## You just talk to OpenCode normally

You don't need to learn a command surface first. Ask for what you want — `vv-controller` picks the lightest appropriate trajectory, and explicit skills take over only when the work needs them:

```text
> Rename this field and update its tests.
→ handled directly

> Why does auth occasionally return 401 after a token refresh?
→ root-cause investigation first → targeted fix → verification

> Add organizations with role-based access.
→ vv-spec → approval → vv-plan → approval → vv-execute
                               ├─ implement
                               ├─ spec review
                               └─ code review
```

Every managed skill can also be invoked explicitly when you want to drive the process yourself.

---

## Quick start

```bash
bun add -g opencode-ai
bun add -g @osovv/vv-opencode
vvoc install
```

`vvoc install` does four things:

- pins `@osovv/vv-opencode` as an OpenCode runtime plugin and registers the same pinned package as the OpenCode TUI plugin;
- scaffolds the managed agents and skills;
- writes the canonical `vvoc.json` config;
- sets `vv-controller` as your default OpenCode agent, with the spec, planning, review, reflection, and handoff skills auto-triggered by request type.

The TUI integration requires OpenCode `1.18.2` or newer; `vvoc status` and `vvoc doctor` report the installed host version and fail compatibility checks for older releases.

**Want to try it without touching your global setup?** Scope everything to one project:

```bash
vvoc install --scope project
vvoc launch --scope project
```

Project scope writes only to `./.opencode/` and `./.vvoc/`. A plain `opencode` launch may still apply OpenCode's native config discovery and merge behavior; `vvoc launch --scope project` is the hard sandbox path — it starts OpenCode with `OPENCODE_CONFIG`, `OPENCODE_TUI_CONFIG`, and `VVOC_CONFIG` pinned to the selected local files, so you can smoke-test vv-opencode in one repository without mutating your primary global setup.

> **Already installed?** Run `vvoc sync` anytime to refresh plugins, prompts, skills, and presets.

---

## How it works: spec → plan → execute

vvoc keeps larger agentic work from jumping straight into edits. A request first becomes explicit artifacts; only the approved plan gets executed, with bounded implementation and review loops. This trajectory is opt-in per request: small changes never go through it, and if you already run your own spec workflow, you can keep it — nothing else in vv-opencode depends on these skills.

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

Inside `vv-execute`, each plan task goes through a tracked loop:

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

Package ids are date-prefixed (`YYYY-MM-DD-<slug>`, for example `2026-06-24-cache-store`) so active packages sort by creation date; the prefix is date-only, never a full timestamp. Spec and plan lifecycle runs through a top-level status: `draft` while being written, `approved` after explicit user approval, `applied` after successful execution. `vv-execute` archives applied packages by moving the whole directory to `.vvoc/specs/archive/YYYY-MM-DD-<slug>-<timestamp>/`.

Specs and plans are XML, so requirements, tasks, acceptance criteria, and dependencies stay grep-able. Task and wave identity lives in unique element names (`<TASK-T-001>…</TASK-T-001>`, `<WAVE-1>…</WAVE-1>`), so grep/sed extraction stays exact without a separate query language:

```bash
grep '<TASK-T-' .vvoc/specs/*/plan.xml      # task ids
grep '<criterion>' .vvoc/specs/*/plan.xml   # acceptance criteria
grep '<task_id>' .vvoc/specs/*/plan.xml     # dependency graph
```

`vv-controller` explicitly routes `vv-spec`, `vv-plan`, and `vv-review`; `vv-execute`, `vv-reflect`, and `vv-handoff` are available as managed skills for plan execution, durable repository memory, and end-of-session handoff notes.

---

## What's inside

### The eleven plugins

| Plugin | What it does |
|---|---|
| **WorkflowPlugin** | A state machine over multi-agent work: explicit work items, required reviewers, bounded implementation/review rounds, and hard stops when more context is needed. |
| **ModelRolesPlugin** | Semantic model roles (`vv-role:smart`, `vv-role:fast`, …) instead of hardcoded model IDs in agents, subagents, and commands — resolved per machine or project at startup. |
| **GuardianPlugin** | Keeps long or AFK runs moving by auto-approving routine low-risk permission requests; anything risky stays in OpenCode's normal manual approval flow. |
| **HashlineEditPlugin** | Routes each model to exactly one native edit tool (host `edit` for GLM/Qwen/Kimi, host `apply_patch` for GPT, `str_replace_editor` for DeepSeek, `hashline_edit` for unmatched models) and hides the other edit tools per session. |
| **SystemContextInjectionPlugin** | Injects the work policy selected by the orchestration profile into vv-controller at startup, plus skill discovery; subagents stay unpolluted. |
| **SecretsRedactionPlugin** | Redacts tokens, keys, emails, and other sensitive values before messages reach the model, restoring them only where local execution needs the originals. |
| **WebToolsPlugin** | Two provider-neutral tools — `web_search` and `web_fetch` — over Exa, Brave, Z.AI, native retrieval, or Spider, with permission checks and normalized output. |
| **ToolHistoryCompactionPlugin** | Shrinks the context replayed to the model by compacting old tool outputs non-destructively, without touching on-disk history. |
| **AnalyticsPlugin** | Local-only token and cache telemetry per model step, a live `cache NN%` indicator in the TUI, and `vvoc analytics cache-hit-rate` for retrospective comparison. |
| **PeakHoursPlugin** | Warns or blocks models whose provider is in peak-priced hours right now, suggests connected off-peak providers, and shows a persistent orange banner in the TUI. |
| **ContextTuiPlugin** | The `/context` inspector: an honest, scrollable TUI dialog showing context-window usage by category, tool, and MCP server. |

### Managed agents

All prompt files are scaffolded by `vvoc install` / `vvoc sync`:

| Agent | When it helps |
|---|---|
| `vv-controller` | Primary agent that follows the concrete work policy selected for the session by the orchestration profile |
| `enhancer` | Improves rough requests before execution when a clearer prompt would help |
| `vv-implementer` | Applies a focused approved change and verifies it before reporting completion |
| `vv-spec-reviewer` | Checks whether implementation matches the requested spec and acceptance criteria |
| `vv-code-reviewer` | Looks for bugs, regressions, maintainability risks, and missing tests |
| `investigator` | Finds the root cause first when behavior is unclear or a failure needs diagnosis |
| `guardian` | Supports GuardianPlugin by reviewing permission requests and auto-approving only routine low-risk ones |

### Managed skills

Two families: `vv-*` skills guide the work protocol, while `vvoc-*` skills operate and observe the vvoc/OpenCode tooling itself.

| Skill | When to use it | What it gives you |
|---|---|---|
| `vv-spec` | You have a feature or creative request and no agreed contract yet | A guided interview, recommended options, and a saved spec in `.vvoc/specs/YYYY-MM-DD-<slug>/spec.xml` |
| `vv-plan` | A spec is approved and ready to implement | A task-level implementation plan with file targets, contracts, dependencies, and acceptance criteria |
| `vv-execute` | A plan is approved and you want it applied step by step | Ordered execution with verification, an explicit inline-or-classic mode choice, and applied spec/plan archival |
| `vv-review` | You want findings, not fixes | A review-only workflow that reports spec/code issues and stops before implementation |
| `vv-reflect` | A long development, debugging, ops, or investigation session produced reusable knowledge | Durable notes in existing docs or `.vvoc/lessons` / `.vvoc/runbooks` for future agents |
| `vv-handoff` | You are ending a session and want the visible context preserved | A redacted XML note at `.vvoc/handoff/YYYY-MM-DD-<session-slug>/handoff.xml`, written from already-visible context only |
| `vvoc-usage-analytics` | You ask about token usage, cache hit rate, costs, or caching regressions | Read-only analysis across `vvoc analytics`, the analytics JSONL, and historical `opencode.db` data |

Skills are loaded by OpenCode at session start through `config.skills.paths` (registered by SystemContextInjectionPlugin); the `vv-controller` agent's skill-trigger rules invoke them automatically when a request matches their conditions.

---

## CLI at a glance

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
| `vvoc guardian config` | Print or write the guardian section |
| `vvoc plugin list` | List OpenCode plugin entries |
| `vvoc plugin enable\|disable` | Toggle a vvoc-managed plugin on or off |
| `vvoc orchestration show\|set` | Show or set the vv-controller orchestration profile |
| `vvoc patch-provider stepfun-ai\|codex\|deepseek\|kimi\|alibaba\|all` | Patch OpenCode providers; `codex` adds subscription-safe OpenAI aliases (also accepts `openai`), `deepseek`/`kimi`/`alibaba` add vv- reasoning-effort aliases, `all` patches every provider at once |
| `vvoc completion` | Install shell completions |
| `vvoc upgrade` | Upgrade the global package and run follow-up sync; sync failure is reported as a partial upgrade |
| `vvoc analytics cache-hit-rate` | Aggregate persisted cache hit rate by day, week, month, session, model, provider, project, vvoc version, or OpenCode version |
| `vvoc version` | Print installed version |

Guardian duration overrides use positive whole milliseconds. Both `--timeout-ms` and `--review-toast-duration-ms` reject zero, negative, fractional, missing, or malformed values:

```bash
vvoc guardian config --print --timeout-ms 30000 --review-toast-duration-ms 5000
```

---

## Configuration

Mutating commands default to global scope for backward compatibility; add `--scope project` to write a project-local layer. Read and diagnostic commands accept `--scope global|project|effective`, where `effective` resolves in this order:

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
Handoff notes            → ./.vvoc/handoff/YYYY-MM-DD-<session-slug>/handoff.xml
Repository memory        → ./.vvoc/lessons/*.xml, ./.vvoc/runbooks/*.xml
```

Legacy root-level `./opencode.json` and `./opencode.jsonc` are intentionally not used as vvoc project layers.

Global paths:

```text
OpenCode config          → $XDG_CONFIG_HOME/opencode/opencode.json
OpenCode TUI config      → $XDG_CONFIG_HOME/opencode/tui.json(c)
vvoc config              → $XDG_CONFIG_HOME/vvoc/vvoc.json
Managed agent prompts    → $XDG_CONFIG_HOME/vvoc/agents/*.md
Managed skills           → $XDG_CONFIG_HOME/vvoc/skills/*/SKILL.md
Persisted data           → $XDG_DATA_HOME/vvoc/
Usage analytics          → $XDG_DATA_HOME/vvoc/analytics/usage-YYYY-MM.jsonl
```

### Two config surfaces, one pinned package

OpenCode keeps server/runtime plugins and native TUI plugins in separate configuration surfaces. `opencode.json(c)` is loaded by the core/server plugin runtime and activates vvoc features such as model roles, Guardian, workflow, hashline edit, redaction, and web tools. `tui.json(c)` is loaded by the terminal UI process and activates the package's `./tui` module (the `/context` inspector). The same pinned package version appears in both files, but OpenCode selects a different public export for each process; headless/server launches therefore never load the UI module.

`vvoc install`, `vvoc init`, and `vvoc sync` conservatively add the pinned base package specifier (for example `@osovv/vv-opencode@X.Y.Z`) to `tui.json(c)`; sync also migrates the broken legacy `@osovv/vv-opencode/tui` form and older managed pins. Existing comments, unrelated settings, unrelated plugin entries, and `[specifier, options]` tuples are preserved; malformed plugin entries fail without rewrite.

Runtime plugins load the effective `vvoc.json` once during OpenCode startup and share one immutable config snapshot for the lifetime of the process. There is no live reload: restart OpenCode after changing `vvoc.json` or `tui.json(c)`.

### Strict schema, loud failures

The config contract is versioned and published with the package — source of truth at `schemas/vvoc/v3.json`. `vvoc.json` must be canonical version 3 and include required sections such as `plugins`. Existing v1/v2/pre-role, incomplete, malformed, or otherwise invalid config files fail instead of being migrated or repaired. `vvoc install` and `vvoc sync` may create a fresh canonical config when no config exists, but they refuse to rewrite an invalid existing `vvoc.json`; fix the file manually and rerun `vvoc sync`.

The optional schema-v3 `web` section follows the same layer precedence and is omitted from generated defaults — see [Web tools](#web-tools) for provider selection:

```json
"web": {
  "search": { "provider": "exa", "apiKey": "optional-exa-key" },
  "fetch": { "provider": "native" }
}
```

### Diagnostics never mutate

`vvoc status` and `vvoc doctor` report the installed OpenCode version, the `1.18.2` TUI minimum, selected runtime/TUI/vvoc config paths, and validation problems without normalizing or rewriting files. `vvoc upgrade` can still finish the package installation when the follow-up `vvoc sync` fails; it then reports a partial upgrade, leaves config unchanged, and tells you to fix the invalid config before rerunning `vvoc sync`.

Runtime compatibility is current-only: Guardian permission replies use the current OpenCode permission reply path (with the current HTTP reply fallback), hashline edit refs must use current hash/context anchors, and sync writes current managed agents without deleting old pre-rename user or command entries.

### Release channels

The package publishes through npm dist-tags with exactly one pre-release channel, `rc`. A default `vvoc upgrade` resolves only the stable `latest` dist-tag and never offers a release candidate; pre-release versions are published with `--tag rc`, so `latest` can never move onto a candidate.

Opt in explicitly when you want candidates:

```bash
vvoc upgrade --rc                # upgrade to the version currently on the rc dist-tag
vvoc upgrade --allow-prerelease  # same behavior, kept as an alias
```

When the `rc` dist-tag has no published candidate yet, the command reports it and installs nothing. If you sit on `1.4.0-rc.1` and the stable `1.4.0` ships, the default `vvoc upgrade` moves you onto the stable release — semver orders `1.4.0` above its candidates. Plugin consumers can install the channel directly with `npm i -g @osovv/vv-opencode@rc`.

Maintainers release candidates through the same exact-SHA CI-gated flow, with the channel derived from the bumped version:

```bash
bun run release:bump -- prerelease --preid rc   # 1.4.0-rc.1, published to the rc dist-tag, GitHub Release marked pre-release
bun run release:bump -- prerelease --preid rc   # next candidate: 1.4.0-rc.2
bun run release:bump -- 1.4.0                   # final stable release, published to latest
```

An explicit `--channel latest|rc` argument may only confirm the derived channel; a contradicting value aborts the bump before any commit or publication.

### Stability and compatibility

Since 1.0, vv-opencode treats the daily-driver surface as stable. The compatibility surfaces are: `vvoc install` / `vvoc sync` / `vvoc launch`, the managed skill names (`vv-spec`, `vv-plan`, `vv-execute`, `vv-review`, `vv-reflect`, `vv-handoff`), the published package exports, canonical vvoc schema v3, and the date-prefixed `.vvoc/specs/YYYY-MM-DD-<slug>/` artifact layout. Breaking workflow or config changes are documented in release notes. The project still prefers conservative, explicit changes over hidden migration magic: user-owned config is never silently clobbered, and invalid current config fails loudly.

### Deterministic local launch

Use `vvoc launch` when the vvoc-selected config files should be the only files OpenCode sees for this run:

```bash
vvoc install --scope project
vvoc launch --scope project -- run "hello"
```

`vvoc launch --scope project` is strict and non-mutating: if `.opencode/opencode.json` or `.vvoc/vvoc.json` is missing, it fails with a hint to run `vvoc install --scope project`. When the selected `.opencode/tui.json(c)` exists, launch also sets `OPENCODE_TUI_CONFIG`; a missing TUI file is not synthesized. `--scope effective` follows the layered lookup order, and `--scope global` uses the global config paths.

---

## Deep dives

### Model roles & presets

```bash
# View current assignments
vvoc role list
vvoc role list --scope effective

# Assign models to roles
vvoc role set default deepseek/deepseek-v4-flash
vvoc role set smart openai/vv-codex-gpt-5.6-sol-xhigh
vvoc role set fast openai/vv-codex-gpt-5.6-luna-low
vvoc role set reviewer zai-coding-plan/glm-5.2 --scope project

# Switch provider presets
vvoc preset vv-codex
vvoc preset vv-zai
vvoc preset vv-deepseek
vvoc preset vv-kimi
vvoc preset vv-alibaba
vvoc preset vv-osovv-sol
vvoc preset vv-osovv-flash
vvoc preset vv-osovv-kimi
vvoc preset vv-osovv-qwen
```

Built-in role IDs: `default`, `smart`, `fast`, `reviewer`, plus any custom lowercase-hyphenated IDs. Presets are partial — applying one only changes the roles it defines. Managed built-in presets (`vv-*`) are refreshed on every `vvoc install`/`vvoc sync`; user-defined presets are preserved as-is.

### Orchestration profiles

Three concrete policies control how vv-controller delegates work at runtime:

- `single-session` — vv-controller performs exploration, investigation, planning, implementation, and verification directly. Independent reviewer subagents remain available when the user explicitly requests review or when a materially risky completed change benefits from independent cross-model evaluation.
- `balanced` — vv-controller keeps architecture, critical reading, and final synthesis in the primary session and may selectively delegate bounded search, investigation, mechanical implementation, or review when that is the lightest safe route. Delegation is optional, not mechanically mandatory.
- `orchestrated` — vv-controller uses the full tracked implementer/reviewer workflow with explicit work items, required reviewers, bounded rounds, and hard stops.

Pick a profile explicitly or let a built-in preset select one:

```bash
vvoc orchestration show --scope effective
vvoc orchestration set single-session --scope project
```

Built-in presets declare an orchestration mapping:

| Preset | Profile |
|---|---|
| `vv-codex` | single-session |
| `vv-kimi` | single-session |
| `vv-alibaba` | single-session |
| `vv-osovv-sol` | single-session |
| `vv-osovv-flash` | single-session |
| `vv-osovv-kimi` | single-session |
| `vv-osovv-qwen` | single-session |
| `vv-zai` | balanced |
| `vv-deepseek` | balanced |

Applying a built-in preset changes both model roles and the root orchestration profile atomically. A custom user-defined preset without an orchestration section preserves the current root profile. `vvoc status` reports the profile resolved from the selected vvoc source; effective status with no config files reports `balanced`.

Profiles are enforced through the concrete policy injected into vv-controller at startup — the model only receives its active work instructions and never sees inactive profile alternatives. The first version does not disable tools, change permissions, or block subagent types; the policy is prompt-driven, and asynchronous vv-execute classic mode remains available through that skill's explicit inline/classic selection. Profile changes take effect after an OpenCode restart, like all vvoc config changes.

### Workflow work items

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

### Edit format routing

`HashlineEditPlugin` resolves an edit mode per session model and exposes exactly one native edit tool to that model — either a host-owned tool or one of the plugin profiles:

- `edit` — the host built-in edit (`filePath`/`oldString`/`newString`/`replaceAll`) with its native matching layers, prior-read enforcement, and unified diff output. Served to `qwen`, `kimi`, and `glm` cohorts; the plugin registers no `edit` tool, so the host runtime stays in charge.
- `apply_patch` — the host built-in patch tool, shown by the host gate to `gpt`/`codex` models; the plugin never overrides or hides it.
- `str_replace_editor` — the plugin's DeepSeek dsh contract (`view`/`create`/`str_replace`/`insert`) with exact-verbatim matching.
- `hashline_edit` — the plugin's hash-anchored tool with `LINE#HASH#ANCHOR` references and anchored read output (default for unmatched models).

The default routing table sends `deepseek` to `str_replace_editor`, `kimi`, `qwen`, and `glm` to `edit`, and `gpt`/`codex` to `apply_patch`; everything else stays on `hashline_edit`. Patterns match case-insensitively as substrings of the session `modelID` only; the first matching rule wins. For every mode the plugin hides the other edit tools from the model — including the host `edit` for the `str_replace_editor`/`hashline_edit` cohorts — so each session sees exactly one editing tool.

`vvoc sync` and `vvoc init` write this default table into `vvoc.json` so it is visible and editable. Materialization is conservative: a routing value you have changed is never overwritten; the table is only filled in where it is missing. Override routing in `vvoc.json` (schema v3) — the `plugins["hashline-edit"]` entry accepts a boolean or an object:

```json
"plugins": {
  "hashline-edit": {
    "enabled": true,
    "routing": {
      "default": "hashline",
      "rules": { "qwen": "hashline", "deepseek": "str_replace_editor" }
    }
  }
}
```

Routing changes require an OpenCode restart, like other runtime plugin settings.

### Tool history compaction

`ToolHistoryCompactionPlugin` shrinks the context replayed to the model on every turn without touching on-disk storage. It rewrites only the in-memory message copy through the `experimental.chat.messages.transform` hook, and only the `output` of old completed tool parts — `input` and part structure (callID/type/order) are never changed, so provider tool_use/tool_result stitching stays intact.

The recent working context is never touched: the newest message and the last `protectRecentMessages` messages (default 8, measured by message recency time with array-order fallback) are always replayed verbatim, regardless of call count, output size, tool class, or parallel batching. Compaction only applies to messages older than that window.

Compaction is tool-classified, not blanket:

- **Retained (never compacted):** results that stay relevant for the whole session — `webfetch`/`web_fetch`/web readers, web/search tools, `skill`, and subagent (`task`/`agent`) outputs. Retained tools also never consume the per-call protection budget.
- **Old reads** collapse to `[Read <file>, lines X-Y]` (range recovered from the line-numbered output; missing file or range falls back to head/tail pruning, never a fabricated summary).
- **Other ephemeral outputs** (`bash`, `grep`, `glob`, …) past `outputMaxChars` are pruned to `headChars` + a fixed marker + `tailChars`. With `savePrunedOutput` (default on), the full output is written once to `$XDG_DATA_HOME/vvoc/tool-output/tool-<callID>.txt` and the marker embeds `Full output saved to: <path>`, so the model can re-read the full content instead of reconstructing it from fragments.

Outside the recent window, the last `protectLastCalls` completed calls are also protected; error parts and parts already compacted by OpenCode are skipped. Rewrites are deterministic and idempotent (each part is rewritten at most once, and the saved path is deterministic per callID), and a `minSavingsChars` guard skips rewrites that would churn the prompt cache for a tiny gain.

Config lives in `vvoc.json` under `plugins["tool-history-compaction"]` (boolean or object) and is conservatively materialized by `vvoc sync`/`init`:

```json
"plugins": {
  "tool-history-compaction": {
    "enabled": true,
    "protectLastCalls": 3,
    "protectRecentMessages": 8,
    "savePrunedOutput": true,
    "minSavingsChars": 2000,
    "outputMaxChars": 2048,
    "headChars": 1200,
    "tailChars": 400,
    "readSlim": true,
    "retainTools": ["webfetch", "web_fetch", "web-reader", "webreader", "search", "brave", "skill", "task", "agent"]
  }
}
```

Set `outputMaxChars` to `0` to disable pruning, `protectRecentMessages` to `0` to disable the message window (only the newest message stays protected), `savePrunedOutput` to `false` to skip disk persistence, or `"enabled": false` to disable the plugin entirely. Changes require an OpenCode restart.

### Cache hit rate analytics

`AnalyticsPlugin` records one line per completed model step — fresh input, cache read, cache write, output, reasoning, recorded cost — to `$XDG_DATA_HOME/vvoc/analytics/usage-YYYY-MM.jsonl`, attributed with the vvoc version, the OpenCode version (from session telemetry), project, provider, model, and agent. Telemetry never leaves the machine; disable collection with `"plugins": { "analytics": false }` and delete old monthly files freely.

In the TUI you get a live `cache NN%` indicator next to the session prompt (green at 80%+, yellow at 50%+, red below, muted `n/a` before the first cache-eligible step) and a combined footer line `• OpenCode <version> · vvoc vX.Y.Z` in the sidebar. The indicator is per-session and computed in memory.

Retrospective analysis lives in the CLI:

```bash
vvoc analytics cache-hit-rate --group-by day                       # daily trend
vvoc analytics cache-hit-rate --group-by vvoc --since 30d         # compare vvoc releases
vvoc analytics cache-hit-rate --group-by opencode --since 30d     # compare OpenCode upgrades
vvoc analytics cache-hit-rate --group-by session|model|provider|project|week|month
vvoc analytics cache-hit-rate --project my-repo --order hit-rate --limit 10 --json
```

The hit rate is token-weighted: `cacheRead / (cacheRead + cacheWrite + input)` over cache-eligible steps; `COVERAGE` shows the share of steps whose provider reported cache tokens at all, so providers without prompt caching read as `n/a` instead of a misleading `0%`. `--since`/`--until` accept `Nd`/`Nw`/`Nm` or `YYYY-MM-DD`; `--order` accepts `date`, `steps`, or `hit-rate`.

Agents can run this analysis conversationally too: the managed `vvoc-usage-analytics` skill answers usage, cache, and cost questions inside a session — including historical comparisons from `opencode.db` that predate the analytics plugin.

### Peak hours

Several providers (DeepSeek, Z.AI, Qwen) bill higher rates during daily or weekday peak windows. `PeakHoursPlugin` matches the provider of each outgoing message against local schedules and either warns or blocks — it never switches the model for you and never fetches pricing from the network.

Behavior per mode:

- **soft** (default): the message goes through, the model receives a one-line cost notice, and the TUI shows a persistent orange banner in the bottom slot: `⚠ PEAK deepseek until 10:00 UTC · elevated pricing · off-peak now: z-ai, qwen`.
- **hard**: the LLM request is rejected with the window end, the wait time, and the connected providers that are currently outside peak (`PEAK_HOURS_BLOCK: provider "deepseek" is in peak hours until 10:00 UTC (about 3 h). … Connected providers outside peak hours right now: z-ai, qwen. …`). The block fires in `chat.params`, after the message is stored: your message stays in the session history and the block renders as a regular error entry, not a dropped message.

Nothing already in flight is ever killed:

- a session created before the current window started is grandfathered to soft for its lifetime (`graceActiveSessions`, on by default — decisions come from persisted session data, so they survive restarts);
- subagent sessions, managed subagents, and `guardian` are always soft — the decision to work was already admitted at the parent level;
- internal OpenCode agents (`compaction`, `title`, `summary`) are exempt entirely.

Schedules match **providers, not models**. Subscription plan provider ids from the OpenCode catalog (models.dev) are gated: `zai-coding-plan` and `zhipuai-coding-plan` map to the `z-ai` schedule, `alibaba-token-plan` and `alibaba-token-plan-cn` map to the `qwen` schedule. Bare pay-per-token API providers (`zai`, `zhipuai`, `alibaba`, `alibaba-cn`, `openai`, …) publish no peak surcharge and are never gated. Unknown providers are never warned about or blocked, and a malformed schedule logs a warning and disables that provider's schedule instead of blocking anything (fail-open).

Config lives in `vvoc.json` under `plugins["peak-hours"]` and is conservatively materialized by `vvoc sync`/`init` — your edits are never overwritten. The built-in defaults carry a revision date because providers move these clocks (verified 2026-08-21: DeepSeek ×2 surcharge effective 2026-08-16; Z.AI weekday coding-plan clock; Qwen 22:00–08:00 UTC+8 off-peak plan window):

```json
"plugins": {
  "peak-hours": {
    "enabled": true,
    "mode": "soft",
    "graceActiveSessions": true,
    "schedules": {
      "deepseek": { "windows": [{ "start": "01:00", "end": "04:00", "tz": "UTC" }, { "start": "06:00", "end": "10:00", "tz": "UTC" }] },
      "z-ai": { "windows": [{ "start": "06:00", "end": "10:00", "tz": "UTC", "days": [1, 2, 3, 4, 5] }] },
      "qwen": { "windows": [{ "start": "00:00", "end": "14:00", "tz": "UTC" }] }
    }
  }
}
```

Windows use `HH:MM` in an explicit timezone (default UTC), may cross midnight (`"start": "22:00", "end": "02:00"`), and accept an optional `days` restriction (0=Sunday … 6=Saturday, default all days). A provider entry may override the global mode with `"mode": "hard"`. Set the top-level `"mode": "hard"` to enforce blocking everywhere, or `"enabled": false` to disable the plugin entirely. Changes require an OpenCode restart, like other runtime plugin settings.

### Web tools

`WebToolsPlugin` exposes exactly two canonical model-facing tools:

- `web_search` requests the `web_search` permission and returns ranked titles, URLs, snippets, and publication dates. Search uses Exa by default, Brave when configured, or the direct Z.AI/Zhipu Tool API for an explicitly selected region.
- `web_fetch` requests the `web_fetch` permission and retrieves a known HTTP or HTTPS URL as Markdown, text, raw HTML, or a direct JPEG, PNG, GIF, WebP, or PDF attachment. Fetch uses local native retrieval by default, Spider for configured textual extraction, or the direct Z.AI/Zhipu Reader Tool API.

The `web-tools` vvoc plugin toggle is enabled by default. Provider selection belongs to `vvoc.json`, not to individual model calls:

```json
"web": {
  "search": { "provider": "zai", "region": "international" },
  "fetch": { "provider": "zai", "region": "china" }
}
```

Supported search providers are `exa` (default), `brave`, and `zai`. Supported fetch providers are `native` (default, no credential required), `spider`, and `zai`. A `zai` section must set `region` to either `international` or `china`; the plugin never guesses or falls back to another region.

Direct Z.AI endpoint routing:

| Region | Search | Reader | Search engine |
|---|---|---|---|
| `international` | `https://api.z.ai/api/paas/v4/web_search` | `https://api.z.ai/api/paas/v4/reader` | `search-prime` |
| `china` | `https://open.bigmodel.cn/api/paas/v4/web_search` | `https://open.bigmodel.cn/api/paas/v4/reader` | `search_pro` |

The `zai` provider calls these documented REST Tool APIs directly. It does not use MCP, install or manage Z.AI MCP servers, or consume GLM Coding Plan MCP quota. Direct requests require ordinary Z.AI/Zhipu API entitlement and may use paid API balance. For fetch, supported image and PDF URLs still return direct attachments; textual targets are sent to the selected regional Reader endpoint.

Credentials resolve in this order:

1. `EXA_API_KEY`, `BRAVE_API_KEY`, `SPIDER_API_KEY`, or `ZAI_API_KEY` for the selected provider
2. `web.search.apiKey` or `web.fetch.apiKey` in the effective `vvoc.json`

Environment variables win when both sources exist; config changes take effect after restarting OpenCode. Configured `apiKey` values become exact-match SecretsRedactionPlugin rules for provider-bound message flows, and WebToolsPlugin diagnostics report only the credential source (`env` or `config`), never the value. If a project-layer `.vvoc/vvoc.json` containing an `apiKey` is tracked by Git, startup logs warn with the file name only. Prefer environment variables or the global vvoc layer; do not commit credentials.

While `web-tools` is enabled, its runtime config hook denies the built-in `webfetch` and `websearch` permission ids in memory, leaving only `web_fetch` and `web_search` in the normal tool surface. It does not rewrite OpenCode files or remove MCP servers. An explicit user permission entry for `webfetch` or `websearch` is respected and may intentionally keep that built-in visible. Disable the plugin and restart to restore stock behavior:

```bash
vvoc plugin disable web-tools
```

Unrelated MCP search or reader tools are not removed automatically; disable those separately if you want only the two canonical tools visible.

### `/context` inspector

Run `/context` inside an active session. Its bounded host-owned dialog has three tabs: **Overview**, **Tools**, and **MCP**. Use left/right arrows or `1`, `2`, and `3` to switch tabs and up/down to scroll long detail; the measured header remains visible on every tab. Top-line used/remaining values come from the latest assistant turn's provider-reported input, cache-read, and output token counts when OpenCode exposes them.

Overview category rows are provider-neutral estimates derived from observable TUI/SDK state: system instructions, skill catalog, loaded skills, tool schemas, user and assistant messages, tool calls and results, files, and the latest compaction summary. Percentages are always `estimated tokens / current model contextLimit`; if OpenCode does not expose a positive current limit, the percentage is shown as an em dash rather than using another denominator. Numeric percentages may exceed 100% when estimates drift, while visual bars clamp only their fill at 100%.

The Tools tab separates each observable current tool's persistent **schema** estimate from its active **history** estimate, call count, combined total, source, and percentages. When a schema catalog is unavailable, the row says `schema unavailable` and labels the history-only subtotal as `known total` rather than presenting a false zero. History includes only tool parts in the active context: the latest compaction summary and subsequent turns. The `skill` tool remains visible in detail, but its history belongs to Overview's `Loaded skill results` category so it is not double-counted.

The MCP tab aggregates observable current schema and retained active history by server and nests the attributed tools. OpenCode 1.18.x does not expose connected MCP tool definitions through its public TUI/SDK tool catalog, so connected servers show `current tools unavailable` and `schema unavailable`; their `known total` includes retained history only, while the unexposed schema overhead remains in `Unknown/provider-only`. Attribution follows OpenCode's sanitized `<server>_<tool>` naming contract with unique longest-prefix matching; sanitized collisions or other ambiguous ownership fail closed under **Other external/plugin** with a bounded warning instead of being guessed.

The plugin does **not** claim to reconstruct the exact final provider request or provide provider-exact tokenization. Hidden provider transformations, plugin-added data, or otherwise unattributable content appears as `Unknown/provider-only`; when visible estimates exceed provider usage, the dialog reports estimation drift instead of forcing totals to match. Collection reuses OpenCode's existing tool catalog, active parts, model metadata, and MCP status snapshot without issuing extra MCP requests.

The `context` vvoc plugin toggle defaults to enabled. Disable it with `vvoc plugin disable context`, then restart OpenCode.

---

## Local development

```bash
bun install             # Install dependencies
bun run check           # Typecheck + lint + format check + GRACE markup check + test
bun run fmt             # Auto-format source files
bun run release:check   # Verify package/schema release consistency
```

Git hooks are managed via `lefthook`.

Smoke-test the built CLI against an isolated config home:

```bash
tmpdir="$(mktemp -d)"
bun run build
bun dist/cli.js install --config-dir "$tmpdir"
bun dist/cli.js status --config-dir "$tmpdir"
```

Test the local TUI against a freshly built `dist/tui.js` without publishing or rewriting your selected configs:

```bash
bun run tui:local
bun run tui:local -- -s <session-id>
bun run tui:local -- --scope project
```

The command defaults to `effective` config resolution. It builds the package, copies the selected `tui.json(c)` into a temporary isolated config home, replaces only the managed vv-opencode TUI entry with a local `file://` URL, preserves unrelated TUI settings and tuple options, and forwards remaining arguments to OpenCode. The original OpenCode, TUI, and vvoc config files are not modified, and the temporary config is removed after OpenCode exits. Restart the command after source changes because runtime plugins do not live reload.

Full release verification:

```bash
bun run release:check
bun run check
bun run pack:check
```

---

## Publishing

The release flow is automated via a local wrapper and an exact-commit, CI-gated GitHub Actions workflow.

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
10. Wait for the dispatched CI run to finish successfully
11. Retry npm metadata propagation, then verify that npm reports the exact release commit as the published `gitHead`
12. Create and push the annotated tag locally, then create the GitHub Release through `gh`

Local prerequisites:

- `opencode` must be available from `PATH`.
- `gh` must be installed and authenticated with permission to dispatch/watch workflows and create releases in the repository. `gh run watch` does not support fine-grained PAT authentication; use a supported `gh` login such as OAuth or a classic token.
- The summary model defaults to `deepseek/deepseek-v4-flash`; override with `VVOC_RELEASE_SUMMARY_MODEL=provider/model` and the per-attempt timeout with `VVOC_RELEASE_SUMMARY_TIMEOUT_MS=120000`.
- Run `release:bump` from a checked-out branch with branch and tag push access to `origin`. A normal branch push never publishes by itself; the wrapper explicitly dispatches the workflow for the exact pushed commit.

The GitHub Actions workflow checks out the requested commit SHA, verifies that its `package.json` version matches the dispatch input, and runs full validation (typecheck, lint, fmt check, tests, build, pack check, and `release:check`). Only after every gate passes does it publish to npm with provenance. The local wrapper waits for that CI result, retries registry metadata propagation, verifies npm `gitHead`, and only then uses the maintainer's authenticated `git` and `gh` clients to create the annotated `vX.Y.Z` tag and GitHub Release. This avoids GitHub App token restrictions on tagging commits that contain workflow changes while preserving verification-before-tagging.

The workflow uses npm provenance/trusted publishing (`id-token: write`) and read-only repository contents access. It can only publish through an explicit `workflow_dispatch` request; normal branch and tag pushes do not publish. Tag and GitHub Release creation happen locally only after the workflow succeeds. Configure npm trusted publishing for this GitHub repository/package, or adapt the publish step to use an `NPM_TOKEN` secret if token-based publishing is required.

`bun run release:check` verifies independently that `package.json` name, version, and `schemas/vvoc/v3.json` `$id` and config format version are all consistent; run it anytime.

---

## License

MIT — see [LICENSE](LICENSE).
