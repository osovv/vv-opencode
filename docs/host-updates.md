# Updating to a new OpenCode host

This document is the operating procedure for keeping vv-opencode compatible with the
current OpenCode 2.x line without publishing a package release for every upstream patch.

## Compatibility model

Three levels, evaluated in order:

| Level | Meaning | User-visible behavior |
|---|---|---|
| `verified` | The exact version is listed in `src/hosts.json` and passed the live gates | No warning |
| `tolerated` | Inside the supported window but without fresh evidence | One warning on install/init/sync/launch; `vvoc status` shows `tolerated` |
| `unsupported` | Outside the window (1.x, 3.x, prereleases) | Fail closed before any config write |

The window is **major-bounded**: `>=2.0.18 <3.0.0` (`src/lib/host-compat.ts`,
`package.json` `engines.opencode`). A 3.x host is never accepted implicitly; it needs a
migration change like the one that produced the native v2 plugin line.

Two different pins must not be confused:

- **Build pins** (`dependencies` / `devDependencies`) are exact. They are the SDK the
  bundle is compiled against and guarantee one copy of `effect` for schema identity.
  They move in a bump train, not per upstream patch.
- **Host acceptance** is the window above plus the verified list. It is what decides
  whether an already-installed host is allowed to run vvoc.

`tolerated` exists so an upstream patch never bricks an installation: the plugin still
loads, the CLI still reports, and config writes proceed best-effort.

## Routine: upstream published a patch (2.x.y)

1. Run `bun run host:check`.
2. If it prints `newestStable=<version> (verified)` — nothing to do.
3. If it prints `(tolerated)`, the window covers the release. Nothing must be published.
   Optionally run the live probe to promote it:
   ```bash
   bun run host:check --download <version>
   # copy the printed run: line (VVOC_HOST_VERSION / VVOC_E2E_V2_HOST / ..._SHA256)
   bun run contracts:host --probe
   ```
4. If the probe fails, treat the patch as a real change: fix, bump, publish.

## Bump train: a new minor (2.N.0) or a promoted patch

1. `bun add --exact @opencode/{ai,client,plugin,protocol,schema}@<version> effect@<peer>`
   (the peer version is declared by `@opencode/schema`), and the matching `@opentui/*`
   versions when their peer floors move.
2. Update `NATIVE_PINNED_DEPENDENCIES` / `NATIVE_PINNED_DEV_DEPENDENCIES` in
   `scripts/check-tool-contracts-host.ts` to the same versions.
3. `bun install && bun run typecheck` — fix compile breaks (host API changes).
4. `bun run build`.
5. Run the live gates against the exact host:
   ```bash
   bun run host:check --download <version>
   # run the printed contracts:host command (probe first, then the full matrix)
   bun run contracts:host
   ```
6. Add the version to `src/hosts.json` when the probe passes; record in the release
   notes whether the full matrix passed, is partial, or is unexercised.
7. `bun run check && bun run pack:check && bun run release:check`.
8. `bun run release:bump patch` (or `minor`) — one release for the whole train.

## Known observations on 2.2.5

Measured by `bun run contracts:host --probe` on 2026-11-04:

- `schemaArgumentDescriptions=dropped` — the host converts tool input schemas through a
  Standard Schema pass that does not carry per-argument `.describe()` text. Tool and
  argument names still reach the model; argument descriptions do not.
- `hostArgNormalization=host-normalized` — unknown keys are stripped and defaults are
  applied before the plugin tool sees the arguments. Type-invalid values are still
  rejected by the plugin contract layer (`INVALID_INPUT`), which the probe verifies.
- The full nine-tool matrix on 2.2.5 is partial: registration and probes pass, four
  workflow rows report no host tool result. This is tracked as a follow-up gate, not as
  verified coverage.

## Where things live

| Concern | File |
|---|---|
| Window, classification | `src/lib/host-compat.ts` |
| Verified host list (data) | `src/hosts.json` |
| Drift reporter | `scripts/host-check.ts` (`bun run host:check`) |
| Live contract gate | `scripts/check-tool-contracts-host.ts` (`bun run contracts:host`) |
| Installed-package parity | `scripts/e2e-v2.ts` (`bun run e2e:v2`) |
| Runtime discovery predicate | `src/runtime/client.ts`, `src/runtime/types.ts` |
