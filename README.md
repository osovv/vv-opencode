# @osovv/vv-opencode

Portable OpenCode workflow package with plugins and a Bun CLI for install, sync, and cross-device setup.

Current v1 scope:

- package the `guardian` OpenCode plugin from this repository
- ship a small CLI named `vvoc`
- make local and cross-device setup reproducible

## What is included

- npm package: `@osovv/vv-opencode`
- binary: `vvoc`
- exported plugin: `GuardianPlugin`
- CLI commands:
  - `install`
  - `sync`
  - `status`
  - `doctor`
  - `guardian config`

## Installation

Install into the current project:

```bash
bun add @osovv/vv-opencode
```

If installed locally, run the binary as:

```bash
bun x vvoc --help
```

or:

```bash
bun run vvoc --help
```

Plain `vvoc` only works when the binary is available in your `PATH`, for example after a global install.

## OpenCode usage

The package exports `GuardianPlugin` and can be referenced from OpenCode config as an npm plugin:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@osovv/vv-opencode"]
}
```

The CLI is intended to make this setup easier and to manage `guardian.jsonc`.

## CLI

Show help:

```bash
bun x vvoc --help
```

Install package config and bootstrap Guardian config:

```bash
bun x vvoc install
```

Install into a specific config directory:

```bash
bun x vvoc install --config-dir ~/.config/opencode
```

Use project scope instead of global scope:

```bash
bun x vvoc install --scope project
```

Sync managed config files:

```bash
bun x vvoc sync
```

Inspect current setup:

```bash
bun x vvoc status
bun x vvoc doctor
```

Generate or print `guardian.jsonc`:

```bash
bun x vvoc guardian config --print
bun x vvoc guardian config --model "anthropic/claude-sonnet-4-5" --variant high
```

### Guardian config behavior

`vvoc` creates a managed `guardian.jsonc` with a small header marker.

- managed files can be resynced safely
- existing unmanaged files are not overwritten unless `--force` is passed
- current Guardian values are preserved on sync when the file is managed by `vvoc`

## Package API

Root export:

```ts
import { GuardianPlugin } from "@osovv/vv-opencode";
```

Subpath export:

```ts
import { GuardianPlugin } from "@osovv/vv-opencode/plugins/guardian";
```

## Local development

Install dependencies:

```bash
bun install
```

Run checks:

```bash
bun run typecheck
bun test
bun run build
```

Smoke-test the CLI against a temporary config directory:

```bash
tmpdir="$(mktemp -d)"
bun run build
bun dist/cli.js install --config-dir "$tmpdir"
bun dist/cli.js status --config-dir "$tmpdir"
```

## Publishing

This project is published manually from the terminal. There is no CI publish workflow.

Typical release flow:

```bash
bun run build
npm publish
```

## Repository layout

- `src/plugins/guardian.ts` - Guardian OpenCode plugin
- `src/lib/opencode.ts` - config path resolution and JSONC helpers
- `src/commands/` - `vvoc` commands
- `src/cli.ts` - CLI entrypoint
- `docs/` - GRACE planning, verification, and graph artifacts

## Notes

- `src/` is the source of truth
- `dist/` is generated output for packaging and local smoke tests
- if you change CLI behavior, keep this README in sync
