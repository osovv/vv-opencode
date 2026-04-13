# @osovv/vv-opencode

Portable OpenCode workflow package with plugins and a Bun CLI for setup, sync, diagnostics, and explicit memory.

## What You Get

- `vvoc` CLI for bootstrap, sync, inspection, model overrides, and named presets
- `GuardianPlugin` for permission review
- `MemoryPlugin` for explicit persistent memory
- `SystemContextInjectionPlugin` for reusable primary-session system guidance
- `SecretsRedactionPlugin` for redacting secrets before LLM requests
- report-only `memory-reviewer` subagent
- vvoc-managed prompt files and OpenCode agent registrations
- managed primary agent `enhancer` for meta-prompting raw intent into structured XML

## Quick Start

Examples below use `vvoc` directly.

Install the package:

```bash
bun add -g @osovv/vv-opencode
```

Bootstrap the default global setup:

```bash
vvoc install
```

Inspect the result:

```bash
vvoc status
```

Use project-local scope instead of global scope:

```bash
vvoc install --scope project
```

`vvoc install` does the following:

- adds a pinned `@osovv/vv-opencode@<installed-version>` entry to the OpenCode `plugin` array
- registers vvoc-managed OpenCode agents, including the primary `enhancer` agent
- creates managed prompt files under `vvoc/agents/` when missing
- creates and fully seeds the canonical `vvoc.json` file at `$XDG_CONFIG_HOME/vvoc/vvoc.json`
- seeds default `openai` and `zai` agent-model presets inside canonical `vvoc.json`
- keeps vvoc-managed config in one canonical file separate from native OpenCode config
- leaves unmanaged files alone unless `--force` is passed

For conversational meta-prompting, use the managed `enhancer` primary agent. It can ask follow-up questions and then return a clean XML prompt in English with semantically unique repeated tags such as `<constraint-1>...</constraint-1>` and `<verification-check-2>...</verification-check-2>`.

Typical workflow:

```text
1. Start a fresh session with the enhancer agent
2. Paste the rough request in plain language
3. Answer any short follow-up questions
4. Copy the final XML prompt into the execution session
```

The OpenCode config entry written by `install` looks like this:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@osovv/vv-opencode@<installed-version>"]
}
```

That package entry points at the package root, which exports `GuardianPlugin`, `MemoryPlugin`, `SystemContextInjectionPlugin`, and `SecretsRedactionPlugin`.

## Common Workflows

### Interactive Bootstrap

Use `init` when you want an interactive setup flow:

```bash
vvoc init
vvoc init --scope project
```

Use `--non-interactive` if you want `init` without prompts:

```bash
vvoc init --non-interactive --scope project
```

### Scripted Install

`install` is the non-interactive bootstrap command and is the best fit for repeatable setup:

```bash
vvoc install
vvoc install --scope project
vvoc install --config-dir /tmp/vvoc-home
```

When `--config-dir` is used for global scope, `vvoc` writes under the supplied root for both `opencode/` and `vvoc/`.

Regardless of scope, vvoc-owned settings are written to the canonical `vvoc.json` file under the effective XDG config root.

### Sync Managed Files

Refresh the pinned package entry, managed agent registrations, managed prompt files, and the canonical `vvoc.json` file:

```bash
vvoc sync
vvoc sync --scope project
```

### Inspect And Validate Setup

```bash
vvoc status
vvoc doctor
vvoc config validate
```

- `status` shows the current installation state
- `doctor` reports parse problems and missing required setup
- `config validate` validates `$XDG_CONFIG_HOME/vvoc/vvoc.json` against the versioned vvoc JSON Schema

### Manage Model Targets

List configured model overrides:

```bash
vvoc agent list
```

Set model overrides:

```bash
vvoc agent set default openai/gpt-5
vvoc agent set small-model openai/gpt-5-mini
vvoc agent set general openai/gpt-5-nano
vvoc agent set explore openai/gpt-5-nano
vvoc agent set enhancer openai/gpt-5
vvoc agent set implementer openai/gpt-5
vvoc agent set code-reviewer anthropic/claude-sonnet-4-20250514
vvoc agent set guardian anthropic/claude-sonnet-4-5:high
vvoc agent set memory-reviewer openai/gpt-5:high
```

Remove overrides:

```bash
vvoc agent unset default
vvoc agent unset small-model
vvoc agent unset spec-reviewer
vvoc agent unset guardian
vvoc agent unset memory-reviewer
```

Supported model target IDs:

- `default`
- `small-model`
- `guardian`
- `memory-reviewer`
- `general`
- `explore`
- `enhancer`
- `implementer`
- `spec-reviewer`
- `code-reviewer`
- `investitagor`

`default` writes OpenCode `model`, and `small-model` writes OpenCode `small_model`.

`guardian` and `memory-reviewer` accept `provider/model[:variant]` syntax. The other targets use `provider/model`.

### Switch Named Presets

List the presets stored in canonical `vvoc.json`:

```bash
vvoc preset list
```

Show a preset definition:

```bash
vvoc preset show openai
```

Apply a preset in one command:

```bash
vvoc preset openai
vvoc preset zai --scope project
vvoc preset minimax
```

Preset rules in v1:

- presets live only in canonical `vvoc.json`
- presets manage only model-target overrides in v1
- presets may be partial
- `vvoc preset <name>` only changes the targets listed in that preset
- targets not listed in the selected preset are left untouched
- `--scope` behaves like `vvoc agent set`: it changes the OpenCode target for OpenCode-managed targets, while canonical `vvoc.json` stays global

This replaces the common workflow of running many `vvoc agent set ...` commands when you want to switch a known group of model targets together.

The canonical config ships with starter `openai`, `zai`, and `minimax` presets and uses this format:

```json
{
  "presets": {
    "openai": {
      "description": "Starter OpenAI overrides for common vvoc model targets.",
      "agents": {
        "default": "openai/gpt-5.4:xhigh",
        "small-model": "openai/gpt-5.4-mini",
        "guardian": "openai/gpt-5.4-mini",
        "explore": "openai/gpt-5.4-mini"
      }
    },
    "zai": {
      "description": "Starter ZAI overrides for common vvoc model targets.",
      "agents": {
        "default": "zai-coding-plan/glm-5.1",
        "small-model": "zai-coding-plan/glm-4.5-air",
        "guardian": "zai-coding-plan/glm-4.5-air",
        "explore": "zai-coding-plan/glm-4.5-air"
      }
    },
    "minimax": {
      "description": "Starter MiniMax overrides for common vvoc model targets.",
      "agents": {
        "default": "minimax-coding-plan/minimax-m2.7",
        "small-model": "minimax-coding-plan/minimax-m2.1",
        "guardian": "minimax-coding-plan/minimax-m2.1",
        "explore": "minimax-coding-plan/minimax-m2.1"
      }
    }
  }
}
```

Preset `agents` support the same target IDs as `vvoc agent set`:

- `default`
- `small-model`
- `guardian`
- `memory-reviewer`
- `general`
- `explore`
- `enhancer`
- `implementer`
- `spec-reviewer`
- `code-reviewer`
- `investitagor`

### Plugin Inspection, Provider Presets, And Shell Completion

```bash
vvoc plugin list
vvoc plugin list --verbose
vvoc path-provider stepfun-ai
vvoc completion
```

- `plugin list` shows plugin entries from OpenCode config
- `path-provider stepfun-ai` patches the global OpenCode provider base URL for StepFun
- `completion` installs completions for the current shell (`bash`, `zsh`, or `fish`)

### Check For Upgrades

```bash
vvoc upgrade
vvoc version
```

- `vvoc upgrade` checks npm for a newer `@osovv/vv-opencode`, runs `bun add -g @osovv/vv-opencode@<latest>` when one exists, and then runs the default global `vvoc sync` flow.
- If the package upgrade succeeds but the follow-up sync cannot run, rerun `vvoc sync` manually.

## Command Reference

| Command | Purpose |
| --- | --- |
| `vvoc init` | Interactive bootstrap flow |
| `vvoc install` | Non-interactive setup and scaffolding |
| `vvoc sync` | Refresh managed config and prompt files |
| `vvoc status` | Show current installation state |
| `vvoc doctor` | Diagnose setup problems |
| `vvoc agent list/set/unset` | Manage model targets and overrides |
| `vvoc preset <name>/list/show <name>` | Switch or inspect declarative named presets |
| `vvoc guardian config` | Print or write the `guardian` section of `vvoc.json` |
| `vvoc config validate` | Validate canonical `vvoc.json` |
| `vvoc plugin list` | List OpenCode plugins from config |
| `vvoc path-provider stepfun-ai` | Patch a global provider endpoint preset |
| `vvoc completion` | Install shell completions |
| `vvoc upgrade` | Check npm, globally install the latest package with Bun, then run `vvoc sync` |
| `vvoc version` | Print the installed `vvoc` version |

## Config And Data Layout

OpenCode config stays in OpenCode-managed paths:

- global: `$XDG_CONFIG_HOME/opencode/opencode.json` or `~/.config/opencode/opencode.json`
- project: `./opencode.json` or `./opencode.jsonc`

vvoc-managed config stays separate from OpenCode config and now has one canonical file:

- canonical config: `$XDG_CONFIG_HOME/vvoc/vvoc.json` or `~/.config/vvoc/vvoc.json`

That canonical config contains the `guardian`, `memory`, `secretsRedaction`, and `presets` sections.

Project scope still uses `./.vvoc/agents/` for managed prompt files, but vvoc's own settings always live in the canonical global config file.

Persisted vvoc data lives under the XDG data root:

- global data root: `$XDG_DATA_HOME/vvoc/` or `~/.local/share/vvoc/`
- project-local memory: `$XDG_DATA_HOME/vvoc/projects/<project-id>/memory/`
- shared memory: `$XDG_DATA_HOME/vvoc/memory/shared/<namespace>/`

Managed prompt files live here:

- global: `~/.config/vvoc/agents/*.md`
- project: `./.vvoc/agents/*.md`

Scope rules:

- vvoc settings are always read from the canonical global `vvoc.json` file
- project scope only changes the OpenCode config target and the managed prompt directory
- existing unmanaged prompt files are not rewritten unless `--force` is passed

## JSON Schema

`vvoc.json` includes a versioned `$schema` URL:

```json
{
  "$schema": "https://cdn.jsdelivr.net/npm/@osovv/vv-opencode@<installed-version>/schemas/vvoc/v2.json",
  "version": 2
}
```

Schema source of truth and hosting strategy:

- the current schema is checked into this repository at `schemas/vvoc/v2.json`
- the legacy schema remains checked in at `schemas/vvoc/v1.json`
- the package publishes that file to npm by shipping the `schemas/` directory
- the canonical hosted schema URL is version-pinned: `https://cdn.jsdelivr.net/npm/@osovv/vv-opencode@<installed-version>/schemas/vvoc/v2.json`
- `v1.json` is immutable once published; breaking schema changes must ship as `v2.json` instead of rewriting `v1.json`
- existing `version: 1` configs still load during the migration window, and `vvoc install` or `vvoc sync` rewrites them to canonical `version: 2`

## Plugins Included

### GuardianPlugin

`GuardianPlugin` reviews OpenCode permission requests with a constrained Guardian agent and safe deny behavior.

Print or rewrite the `guardian` section of canonical `vvoc.json`:

```bash
vvoc guardian config --print
vvoc guardian config --model "anthropic/claude-sonnet-4-5" --variant high
```

Supported Guardian config fields:

- `model`
- `variant`
- `timeoutMs`
- `approvalRiskThreshold`
- `reviewToastDurationMs`

The `guardian` section lives under `$XDG_CONFIG_HOME/vvoc/vvoc.json`.

### MemoryPlugin

`MemoryPlugin` adds explicit persistent memory tools to OpenCode.

Available tools:

- `memory_search`
- `memory_get`
- `memory_put`
- `memory_update`
- `memory_delete`
- `memory_list`

Memory is explicit-only:

- stored entries are never injected into the prompt automatically
- the agent must call memory tools directly when durable context is useful
- settings live in `$XDG_CONFIG_HOME/vvoc/vvoc.json` under the `memory` section

Supported scopes:

- `session` for the current session in the current project
- `branch` for the current git branch in the current project
- `project` for repository-specific memory
- `shared` for cross-project memory

The `memory` section supports these fields:

- `enabled`
- `defaultSearchLimit`
- `reviewerModel`
- `reviewerVariant`

The package also installs a bundled reviewer subagent named `memory-reviewer`.

Example:

```text
@memory-reviewer review the current memory and suggest keep/update/merge/delete actions
```

The reviewer can read memory but cannot modify it.

### SystemContextInjectionPlugin

`SystemContextInjectionPlugin` injects reusable system guidance into primary chat sessions without polluting known subagent prompts.

The default injected guidance tells the main session to proactively use the `explore` subagent when the task depends on unfamiliar code, unclear scope, or multiple candidate implementation areas.

The plugin currently injects guidance through the `chat.message` hook so it can inspect the resolved agent name and skip known subagents such as `general`, `explore`, `implementer`, and `memory-reviewer`.

### SecretsRedactionPlugin

`SecretsRedactionPlugin` redacts secrets from chat content before LLM requests and restores placeholders after the request lifecycle where needed.

`vvoc install` and `vvoc sync` seed the `secretsRedaction` section in canonical `vvoc.json`. The generated config uses:

```json
{
  "secret": "${VVOC_SECRET}"
}
```

Set `VVOC_SECRET` if you want placeholder restoration to stay stable across restarts.

If no canonical config file exists, the plugin falls back to defaults and generates a random secret for the current runtime.

Built-in patterns cover common identifiers and tokens such as:

- email addresses
- UUIDs
- IP and MAC addresses
- OpenAI, Anthropic, GitHub, AWS, and Stripe-style keys
- bearer tokens and generic hex-like tokens

## Managed Prompts And Subagents

`vvoc` manages prompt files for:

- `guardian`
- `memory-reviewer`
- `implementer`
- `spec-reviewer`
- `code-reviewer`
- `investitagor`

`install` and `sync` register these OpenCode subagents in `opencode.json`:

- `implementer`
- `spec-reviewer`
- `code-reviewer`
- `investitagor`

`GuardianPlugin` and `MemoryPlugin` load `guardian.md` and `memory-reviewer.md` from vvoc-managed paths at runtime.

If a managed prompt file is missing, rerun one of these commands:

```bash
vvoc install
vvoc sync
```

## Package API

Root exports:

```ts
import {
  GuardianPlugin,
  MemoryPlugin,
  SystemContextInjectionPlugin,
  SecretsRedactionPlugin,
} from "@osovv/vv-opencode";
```

Subpath exports:

```ts
import { GuardianPlugin } from "@osovv/vv-opencode/plugins/guardian";
import { MemoryPlugin } from "@osovv/vv-opencode/plugins/memory";
import { SystemContextInjectionPlugin } from "@osovv/vv-opencode/plugins/system-context-injection";
import { SecretsRedactionPlugin } from "@osovv/vv-opencode/plugins/secrets-redaction";
```

## Local Development

Install dependencies:

```bash
bun install
```

Run the full local verification stack:

```bash
bun run typecheck
bun run lint
bun run fmt:check
bun test
bun run build
bun run pack:check
```

Format source files:

```bash
bun run fmt
```

Git hooks are managed with `lefthook`.

- `bun install` runs `lefthook install --force` through the `prepare` script
- the `pre-commit` hook runs `bun run lint` and `bun run fmt:check`

Smoke-test the built CLI against a temporary config root:

```bash
tmpdir="$(mktemp -d)"
bun run build
bun dist/cli.js install --config-dir "$tmpdir"
bun dist/cli.js status --config-dir "$tmpdir"
```

## Publishing

This package is published manually from the terminal.

Typical release flow:

```bash
bun run typecheck
bun run lint
bun run fmt:check
bun test
bun run build
bun run pack:check
npm publish
```

## Optional: RTK

[RTK](https://github.com/rtk-ai/rtk) is a CLI proxy that reduces token usage for common developer commands. It works well alongside `vvoc`, and the interactive `vvoc init` flow recommends it after setup.
