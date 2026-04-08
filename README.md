# @osovv/vv-opencode

Portable OpenCode workflow package with plugins and a Bun CLI for setup, sync, diagnostics, and explicit memory.

## What You Get

- `vvoc` CLI for bootstrap, sync, inspection, and model overrides
- `GuardianPlugin` for permission review
- `MemoryPlugin` for explicit persistent memory
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
- creates `guardian.jsonc`, `memory.jsonc`, and `secrets-redaction.config.json` when missing
- keeps vvoc-managed config separate from native OpenCode config
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

That package entry points at the package root, which exports `GuardianPlugin`, `MemoryPlugin`, and `SecretsRedactionPlugin`.

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

### Sync Managed Files

Refresh the pinned package entry, managed agent registrations, managed prompt files, and managed `guardian.jsonc` / `memory.jsonc` files:

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
- `config validate` validates `guardian.jsonc` and `memory.jsonc` in global, project, or both scopes

Validate a specific scope or config type:

```bash
vvoc config validate --scope global
vvoc config validate --scope project --guardian-only
vvoc config validate --scope project --memory-only
```

### Manage Agent Models

List configured model overrides:

```bash
vvoc agent list
```

Set model overrides:

```bash
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
vvoc agent unset spec-reviewer
vvoc agent unset guardian
vvoc agent unset memory-reviewer
```

Supported agent IDs:

- `guardian`
- `memory-reviewer`
- `general`
- `explore`
- `enhancer`
- `implementer`
- `spec-reviewer`
- `code-reviewer`
- `investitagor`

`guardian` and `memory-reviewer` accept `provider/model[:variant]` syntax. The other agent targets use `provider/model`.

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

## Command Reference

| Command | Purpose |
| --- | --- |
| `vvoc init` | Interactive bootstrap flow |
| `vvoc install` | Non-interactive setup and scaffolding |
| `vvoc sync` | Refresh managed config and prompt files |
| `vvoc status` | Show current installation state |
| `vvoc doctor` | Diagnose setup problems |
| `vvoc agent list/set/unset` | Manage model overrides |
| `vvoc guardian config` | Print or write `guardian.jsonc` |
| `vvoc config validate` | Validate `guardian.jsonc` and `memory.jsonc` |
| `vvoc plugin list` | List OpenCode plugins from config |
| `vvoc path-provider stepfun-ai` | Patch a global provider endpoint preset |
| `vvoc completion` | Install shell completions |
| `vvoc upgrade` | Check npm for a newer package version |
| `vvoc version` | Print the installed `vvoc` version |

## Config And Data Layout

OpenCode config stays in OpenCode-managed paths:

- global: `$XDG_CONFIG_HOME/opencode/opencode.json` or `~/.config/opencode/opencode.json`
- project: `./opencode.json` or `./opencode.jsonc`

vvoc-managed config stays separate:

- global: `$XDG_CONFIG_HOME/vvoc/` or `~/.config/vvoc/`
- project: `./.vvoc/`

Persisted vvoc data lives under the XDG data root:

- global data root: `$XDG_DATA_HOME/vvoc/` or `~/.local/share/vvoc/`
- project-local memory: `$XDG_DATA_HOME/vvoc/projects/<project-id>/memory/`
- shared memory: `$XDG_DATA_HOME/vvoc/memory/shared/<namespace>/`

Managed prompt files live here:

- global: `~/.config/vvoc/agents/*.md`
- project: `./.vvoc/agents/*.md`

Common managed config files:

- global Guardian config: `~/.config/vvoc/guardian.jsonc`
- project Guardian config: `./.vvoc/guardian.jsonc`
- global Memory config: `~/.config/vvoc/memory.jsonc`
- project Memory config: `./.vvoc/memory.jsonc`
- global Secrets Redaction config: `~/.config/vvoc/secrets-redaction.config.json`
- project Secrets Redaction config: `./.vvoc/secrets-redaction.config.json`

Scope rules:

- project config overrides global config for vvoc-managed settings
- managed files include a marker header so `vvoc` can recognize them safely
- existing unmanaged files are not rewritten unless `--force` is passed

## Plugins Included

### GuardianPlugin

`GuardianPlugin` reviews OpenCode permission requests with a constrained Guardian agent and safe deny behavior.

Generate or rewrite a managed `guardian.jsonc` file:

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

`guardian.jsonc` is only auto-rewritten when it is clearly vvoc-managed, unless you pass `--force`.

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
- settings live in `./.vvoc/memory.jsonc` or `$XDG_CONFIG_HOME/vvoc/memory.jsonc`

Supported scopes:

- `session` for the current session in the current project
- `branch` for the current git branch in the current project
- `project` for repository-specific memory
- `shared` for cross-project memory

`memory.jsonc` supports these fields:

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

### SecretsRedactionPlugin

`SecretsRedactionPlugin` redacts secrets from chat content before LLM requests and restores placeholders after the request lifecycle where needed.

`vvoc install` scaffolds a managed `secrets-redaction.config.json` file. The generated config uses:

```json
{
  "secret": "${VVOC_SECRET}"
}
```

Set `VVOC_SECRET` if you want placeholder restoration to stay stable across restarts.

If no config file exists, the plugin falls back to defaults and generates a random secret for the current runtime.

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
  SecretsRedactionPlugin,
} from "@osovv/vv-opencode";
```

Subpath exports:

```ts
import { GuardianPlugin } from "@osovv/vv-opencode/plugins/guardian";
import { MemoryPlugin } from "@osovv/vv-opencode/plugins/memory";
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
