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
- **Safer edits** — per-model edit routing gives each model its native editing tool: hashline-anchored edits, exact oldString/newString replace, or the DeepSeek `str_replace_editor`, all tied to fresh `read` output so agents rarely write against stale content

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
| **Unified Web Tools** | Replace provider-specific search and reader schemas with the canonical `web_search` and `web_fetch` tools, configurable for Exa, Brave, native retrieval, or Spider extraction |
| **Context Inspector** | Run `/context` in an active OpenCode TUI session for Overview, Tools, and MCP tabs with provider-reported usage, approximate context-window percentages, active post-compaction tool history, and deterministic source attribution |
| **Cache Analytics** | Watch a live per-session `cache NN%` indicator in the TUI and compare cache hit rates across vvoc releases, OpenCode versions, models, and projects with `vvoc analytics cache-hit-rate` |

---

## The Ten Plugins

| Plugin | What it helps you do |
|---|---|
| **WorkflowPlugin** | Keep multi-agent work structured with explicit work items, bounded implementation/review loops, reviewer result collection, and safe stops when more context is needed. |
| **ModelRolesPlugin** | Use semantic model roles instead of hardcoded model IDs in OpenCode agents, subagents, and command configs — e.g. `vv-role:smart`, `vv-role:fast` — then map those roles per machine or project. |
| **GuardianPlugin** | Keep long or AFK agent runs moving by auto-approving routine low-risk permission requests. If something looks risky, Guardian does not auto-approve it and leaves the decision to OpenCode's normal manual approval flow. |
| **HashlineEditPlugin** | Route each model to its native editing tool (hashline anchors, exact replace, or DeepSeek `str_replace_editor`), tying changes to fresh `read` output to reduce wrong-line and stale-context edits. |
| **SystemContextInjectionPlugin** | Inject universal primary guidance plus one startup-resolved orchestration policy into vv-controller, with skill discovery and subagent-only explore worker prompts. |
| **SecretsRedactionPlugin** | Reduce accidental secret leakage by redacting tokens, keys, emails, and other sensitive values before messages are sent to the model. |
| **WebToolsPlugin** | Register the provider-neutral `web_search` and `web_fetch` tools, return direct image/PDF attachments, and hide OpenCode's built-in web tools at runtime unless the user explicitly configured their permissions. |
| **ContextTuiPlugin** | Add a native scrollable `/context` dialog with measured usage plus detailed observable per-tool and per-MCP schema/history estimates, explicitly marking data that OpenCode does not expose. |
| **ToolHistoryCompactionPlugin** | Shrink the replayed conversation context non-destructively by compacting old tool outputs in the model replay (old reads to `[Read <file>, lines X-Y]`, over-budget ephemeral outputs pruned), while retaining web/search/skill knowledge results. |
| **AnalyticsPlugin** | Persist per-step token and cache telemetry with vvoc/OpenCode version attribution, show a live `cache NN%` indicator next to the session prompt plus a combined OpenCode/vvoc version line in the sidebar footer, and answer "did my cache optimizations help?" via `vvoc analytics cache-hit-rate`. |

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

### Edit Format Routing

`HashlineEditPlugin` resolves an edit mode per session model and exposes only the matching edit tool to that model:

- `hashline` — the `hashline_edit` tool with `LINE#HASH#ANCHOR` references and anchored read output (default for unmatched models).
- `replace` — the `edit` tool with exact `oldString`/`newString` replacement, prior-read enforcement, and visible unicode/trailing-whitespace fallbacks.
- `str_replace_editor` — the DeepSeek dsh contract (`view`/`create`/`str_replace`/`insert`) with exact-verbatim matching.
- `passthrough` — no vvoc edit tool is exposed; the host-provided editing path stays in charge.

The default routing table sends `deepseek` to `str_replace_editor`, `kimi`, `qwen`, and `glm` to `replace`, and `gpt`/`codex` to `passthrough`; everything else stays on `hashline`. Patterns match case-insensitively against the session `providerID` first, then `modelID`; the first matching rule wins.

`vvoc sync` and `vvoc init` write this default table into `vvoc.json` so it is visible and editable. Materialization is conservative: a routing value you have changed is never overwritten; the table is only filled in where it is missing.

Override routing in `vvoc.json` (schema v3). The `plugins["hashline-edit"]` entry accepts a boolean or an object:

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

### Tool History Compaction

`ToolHistoryCompactionPlugin` shrinks the context replayed to the model on every turn without touching on-disk storage. It rewrites only the in-memory message copy through the `experimental.chat.messages.transform` hook, and only the `output` of old completed tool parts — `input` and part structure (callID/type/order) are never changed, so provider tool_use/tool_result stitching stays intact.

The **recent working context is never touched**: the newest message and the last `protectRecentMessages` messages (default 8, measured by message recency time with array-order fallback) are always replayed verbatim, regardless of call count, output size, tool class, or parallel batching. Compaction only applies to messages older than that window.

Compaction is tool-classified, not blanket:

- **Retained (never compacted):** results that stay relevant for the whole session — `webfetch`/`web_fetch`/web readers, web/search tools, `skill`, and subagent (`task`/`agent`) outputs. Retained tools also never consume the per-call protection budget.
- **Old reads** collapse to `[Read <file>, lines X-Y]` (range recovered from the line-numbered output; missing file or range falls back to head/tail pruning, never a fabricated summary).
- **Other ephemeral outputs** (`bash`, `grep`, `glob`, …) past `outputMaxChars` are pruned to `headChars` + a fixed marker + `tailChars`, DeepSeek-Harness style. With `savePrunedOutput` (default on), the full output is written once to `$XDG_DATA_HOME/vvoc/tool-output/tool-<callID>.txt` and the marker embeds `Full output saved to: <path>`, so the model can re-read the full content instead of reconstructing it from fragments.

Outside the window, the last `protectLastCalls` completed calls are also protected; error parts and parts already compacted by OpenCode are skipped. Rewrites are deterministic and idempotent (each part is rewritten at most once, and the saved path is deterministic per callID), and a `minSavingsChars` guard skips rewrites that would churn the prompt cache for a tiny gain.

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

### Cache Hit Rate Analytics

`AnalyticsPlugin` records one line per completed model step — fresh input, cache read, cache write, output, reasoning, recorded cost — to `$XDG_DATA_HOME/vvoc/analytics/usage-YYYY-MM.jsonl`, attributed with the vvoc version, the OpenCode version (from session telemetry), project, provider, model, and agent. Telemetry never leaves the machine; disable collection with `"plugins": { "analytics": false }` and delete old monthly files freely.

In the TUI you get a live `cache NN%` indicator next to the session prompt (green at 80%+, yellow at 50%+, red below, muted `n/a` before the first cache-eligible step) and a combined footer line `• OpenCode <version> · vvoc vX.Y.Z` in the sidebar (the stock version line, extended with the vvoc version). The indicator is per-session and computed in memory.

Retrospective analysis lives in the CLI:

```bash
vvoc analytics cache-hit-rate --group-by day                       # daily trend
vvoc analytics cache-hit-rate --group-by vvoc --since 30d         # compare vvoc releases
vvoc analytics cache-hit-rate --group-by opencode --since 30d     # compare OpenCode upgrades
vvoc analytics cache-hit-rate --group-by session|model|provider|project|week|month
vvoc analytics cache-hit-rate --project my-repo --order hit-rate --limit 10 --json
```

The hit rate is token-weighted: `cacheRead / (cacheRead + cacheWrite + input)` over cache-eligible steps; `COVERAGE` shows the share of steps whose provider reported cache tokens at all, so providers without prompt caching read as `n/a` instead of a misleading `0%`. `--since`/`--until` accept `Nd`/`Nw`/`Nm` or `YYYY-MM-DD`.

Agents can run this analysis conversationally too: the managed `vvoc-usage-analytics` skill answers usage, cache, and cost questions inside a session — including historical comparisons from `opencode.db` that predate the analytics plugin (see Managed Skills).

### Web Tools

`WebToolsPlugin` exposes exactly two canonical model-facing tools:

- `web_search` requests the `web_search` permission and returns ranked titles, URLs, snippets, and publication dates. Search uses Exa by default, Brave when configured, or the direct Z.AI/Zhipu Tool API for an explicitly selected region.
- `web_fetch` requests the `web_fetch` permission and retrieves a known HTTP or HTTPS URL as Markdown, text, raw HTML, or a direct JPEG, PNG, GIF, WebP, or PDF attachment. Fetch uses local native retrieval by default, Spider for configured textual extraction, or the direct Z.AI/Zhipu Reader Tool API.

The `web-tools` vvoc plugin toggle is enabled by default.

Provider selection belongs to `vvoc.json`, not to individual model calls. Add this optional property fragment to an otherwise valid canonical schema-v3 config:

```json
"web": {
  "search": { "provider": "zai", "region": "international" },
  "fetch": { "provider": "zai", "region": "china" }
}
```

Supported search providers are `exa` (default), `brave`, and `zai`. Supported fetch providers are `native` (default, no credential required), `spider`, and `zai`. A `zai` section must set `region` to either `international` or `china`; the plugin never guesses or falls back to another region.

Direct Z.AI endpoint routing is:

| Region | Search | Reader | Search engine |
|---|---|---|---|
| `international` | `https://api.z.ai/api/paas/v4/web_search` | `https://api.z.ai/api/paas/v4/reader` | `search-prime` |
| `china` | `https://open.bigmodel.cn/api/paas/v4/web_search` | `https://open.bigmodel.cn/api/paas/v4/reader` | `search_pro` |

The `zai` provider calls these documented REST Tool APIs directly. It does not use MCP, install or manage Z.AI MCP servers, or consume GLM Coding Plan MCP quota. Direct requests require ordinary Z.AI/Zhipu API entitlement and may use paid API balance. For fetch, supported image and PDF URLs still return direct attachments; textual targets are sent to the selected regional Reader endpoint.

Credentials resolve in this order:

1. `EXA_API_KEY`, `BRAVE_API_KEY`, `SPIDER_API_KEY`, or `ZAI_API_KEY` for the selected provider
2. `web.search.apiKey` or `web.fetch.apiKey` in the effective `vvoc.json`

Environment variables win when both sources exist. Config changes take effect after restarting OpenCode. Configured `apiKey` values become exact-match SecretsRedactionPlugin rules for provider-bound message flows, and WebToolsPlugin diagnostics report only the credential source (`env` or `config`), never the value. If a project-layer `.vvoc/vvoc.json` containing an `apiKey` is tracked by Git, startup logs warn with the file name only. Prefer environment variables or the global vvoc layer; do not commit credentials.

While `web-tools` is enabled, its runtime config hook denies the built-in `webfetch` and `websearch` permission ids in memory, leaving only `web_fetch` and `web_search` in the normal tool surface. It does not rewrite OpenCode files or remove MCP servers. An explicit user permission entry for `webfetch` or `websearch` is respected and may intentionally keep that built-in visible. Disable the plugin and restart to restore stock behavior:

```bash
vvoc plugin disable web-tools
```

Unrelated MCP search or reader tools are not removed automatically; disable those separately if you want only the two canonical tools visible.

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
| `vvoc patch-provider stepfun-ai\|codex\|deepseek\|kimi\|alibaba\|all` | Patch OpenCode providers; `codex` adds subscription-safe OpenAI aliases (also accepts `openai`), `deepseek`/`kimi`/`alibaba` add vv- reasoning-effort aliases, `all` patches every provider at once |
| `vvoc completion` | Install shell completions |
| `vvoc upgrade` | Upgrade global package and run follow-up sync; sync failure is reported as a partial upgrade |
| `vvoc analytics cache-hit-rate` | Aggregate persisted cache hit rate by day, week, month, session, model, provider, project, vvoc version, or OpenCode version |
| `vvoc version` | Print installed version |

Guardian duration overrides use positive whole milliseconds. Both `--timeout-ms` and
`--review-toast-duration-ms` reject zero, negative, fractional, missing, or malformed values:

```bash
vvoc guardian config --print --timeout-ms 30000 --review-toast-duration-ms 5000
```

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
| `vv-kimi` | single-session |
| `vv-alibaba` | single-session |
| `vv-osovv-sol` | single-session |
| `vv-osovv-flash` | single-session |
| `vv-osovv-kimi` | single-session |
| `vv-osovv-qwen` | single-session |
| `vv-zai` | balanced |
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
vvoc role set default openai/gpt-5.6-terra
vvoc role set team-review anthropic/claude-sonnet-4-5 --scope project
vvoc role set smart openai/vv-codex-gpt-5.6-sol-xhigh
vvoc role set fast openai/gpt-5.6-luna

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

Built-in role IDs: `default`, `smart`, `fast`, `reviewer` + any custom lowercase-hyphenated IDs.

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
Usage analytics          → $XDG_DATA_HOME/vvoc/analytics/usage-YYYY-MM.jsonl  (local-only cache telemetry)
Repository memory       → ./.vvoc/lessons/*.xml              (lazy vv-reflect fallback)
                           ./.vvoc/runbooks/*.xml             (lazy vv-reflect fallback)
Session handoff notes   → ./.vvoc/handoff/YYYY-MM-DD-<session-slug>/handoff.xml
```

Schema is versioned and published with the package — source of truth at `schemas/vvoc/v3.json`. The current config contract is strict: `vvoc.json` must be canonical version 3 and include required sections such as `plugins`. Existing v1/v2/pre-role, incomplete, malformed, or otherwise invalid config files fail instead of being migrated or repaired. `vvoc install` and `vvoc sync` may create a fresh canonical config when no config exists, but they refuse to rewrite an invalid existing `vvoc.json`; fix the file manually and rerun `vvoc sync`.

The optional schema-v3 `web` section follows the same layer precedence as the rest of `vvoc.json` and is omitted from generated defaults:

```json
"web": {
  "search": { "provider": "exa", "apiKey": "optional-exa-key" },
  "fetch": { "provider": "native" }
}
```

Use `brave` instead of `exa` for Brave Web Search, or `spider` instead of `native` for Spider textual extraction. The matching environment variable takes precedence over `apiKey` fields.

OpenCode intentionally keeps server/runtime plugins and native terminal UI plugins in separate configuration surfaces. `opencode.json(c)` is loaded by the core/server plugin runtime and activates vvoc features such as model roles, Guardian, workflow, hashline edit, redaction, and web tools. `tui.json(c)` is loaded by the terminal UI process and activates the package's `./tui` module, currently the `/context` inspector. The same pinned package version appears in both files, but OpenCode selects a different public export for each process; headless/server launches therefore do not need to load the Solid/OpenTUI UI module.

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

Managed skills come in two families: `vv-*` skills guide the work protocol (spec, plan, execute, review, reflect, handoff), while `vvoc-*` skills operate and observe the vvoc/OpenCode tooling itself. Seven skills are scaffolded alongside agents:

| Skill | When to use it | What it gives you |
|---|---|---|
| `vv-spec` | You have a feature or creative request and no agreed contract yet | A guided interview, recommended options, and a saved spec in `.vvoc/specs/YYYY-MM-DD-<slug>/spec.xml` |
| `vv-plan` | A spec is approved and ready to implement | A task-level implementation plan with file targets, contracts, dependencies, and acceptance criteria |
| `vv-execute` | A plan is approved and you want it applied step by step | Ordered execution with verification, explicit inline-or-classic mode choice, and applied spec/plan archival |
| `vv-review` | You want findings, not fixes | A review-only workflow that reports spec/code issues and stops before implementation |
| `vv-reflect` | A long development, debugging, ops, or investigation session produced reusable knowledge | Durable notes in existing docs or `.vvoc/lessons` / `.vvoc/runbooks` for future agents |
| `vv-handoff` | You are ending a session and want the visible context preserved for a future session | A redacted XML note at `.vvoc/handoff/YYYY-MM-DD-<session-slug>/handoff.xml`, without running new checks or collecting fresh context |
| `vvoc-usage-analytics` | You ask about token usage, cache hit rate, costs, or whether a vvoc/OpenCode upgrade changed caching | An agent-run read-only analysis across `vvoc analytics`, the analytics JSONL, and historical `opencode.db` data (validated SQL snippets included) |

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
10. Wait for the dispatched CI run to finish successfully
11. Retry npm metadata propagation, then verify that npm reports the exact release commit as the published `gitHead`
12. Create and push the annotated tag locally, then create the GitHub Release through `gh`

Required local release prerequisite:
- `opencode` must be available from `PATH`.
- `gh` must be installed and authenticated with permission to dispatch/watch workflows and create releases in the repository.
- `gh run watch` does not support fine-grained PAT authentication; use a supported `gh` login such as OAuth or a classic token.
- The summary model defaults to `deepseek/deepseek-v4-flash`.
- Override with `VVOC_RELEASE_SUMMARY_MODEL=provider/model`.
- Override the per-attempt timeout with `VVOC_RELEASE_SUMMARY_TIMEOUT_MS=120000`.
Run `release:bump` from a checked-out branch with branch and tag push access to `origin`. A normal branch push never publishes by itself; the wrapper explicitly dispatches the workflow for the exact pushed commit.

The GitHub Actions workflow checks out the requested commit SHA, verifies that its
`package.json` version matches the dispatch input, and runs full validation
(typecheck, lint, fmt check, tests, build, pack check, and `release:check`). Only
after every gate passes does it publish to npm with provenance. The local wrapper
waits for that CI result, retries registry metadata propagation, verifies npm
`gitHead`, and only then uses the maintainer's authenticated `git` and `gh` clients
to create the annotated `vX.Y.Z` tag and GitHub Release. This avoids GitHub App
token restrictions on tagging commits that contain workflow changes while preserving
verification-before-tagging.

### Checking consistency manually

```bash
bun run release:check
```

This verifies that `package.json` name, version, and `schemas/vvoc/v3.json` `$id` and
config format version are all consistent. Run it independently anytime.

### CI publish workflow

The workflow uses npm provenance/trusted publishing (`id-token: write`) and read-only repository contents access. It can only publish through an explicit `workflow_dispatch` request; normal branch and tag pushes do not publish. Tag and GitHub Release creation happen locally only after the workflow succeeds. Configure npm trusted publishing for this GitHub repository/package, or adapt the publish step to use an `NPM_TOKEN` secret if token-based publishing is required.

---

## License

MIT — see [LICENSE](LICENSE).
