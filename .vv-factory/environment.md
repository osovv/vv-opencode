# Isolated execution: vv-opencode

Principle: never touch production or real user configs. The repo already provides isolation
mechanisms — use them instead of hand-rolled workarounds.

## Runner-provided environment

- The task runner exports `FACTORY_RUN_PORT_OFFSET` (a per-attempt port shift, for example 120).
  Apply it when starting any server manually (dev server, test HTTP mock, `opencode serve`):
  `PORT=$((BASE + FACTORY_RUN_PORT_OFFSET))`.
- Unit tests and the e2e harness mostly pick ephemeral ports (`port: 0`) and need no offset.
  EXCEPTION: the host-smoke test `src/plugins/model-roles.integration.test.ts` listens on the
  fixed ports 39247 and 42947 — if another process occupies them, the test fails in a way that
  looks like a test failure, not a port error.

## Config and data isolation

- Never run `vvoc install` / `vvoc sync` in global mode against a real user profile: global
  entries go to `$XDG_CONFIG_HOME/opencode` and `$XDG_CONFIG_HOME/vvoc`. For sandboxed tasks use
  either project scope (writes only inside `.opencode/` and `.vvoc/` of the chosen project) or
  temporary XDG directories:

  ```bash
  XDG_CONFIG_HOME=$scratch/cfg XDG_DATA_HOME=$scratch/data bun run src/cli.ts install --project .
  ```

- `vvoc launch` is the safe way to bring up a host: it preflights the host window and pins
  `OPENCODE_CONFIG`, `VVOC_CONFIG`, and `OPENCODE_CONFIG_DIR` for a deterministic sandboxed
  start. Prefer it over a bare `opencode` when you just need to check the host.
- The e2e and host-contract checks are fully self-isolating: they create a scratch
  HOME/cfg/data/state/cache and install the packed package there; they never need to write to
  user configs. The scratch parent for contracts:host is `/tmp/opencode/tool-contracts-host`.

## The real host (opencode) for checks

- A pinned binary is required: version 2.0.18, with sha256 verified against `PINNED_HOST_SHA256`
  in `scripts/e2e-v2/host.ts` (the harness refuses a mismatch — that is by design).
- The harness looks for the host only in `VVOC_E2E_V2_HOST` or in
  `/tmp/opencode/vvoc-seam-host-2.0.18/opencode`; it does not scan `PATH`. Export
  `VVOC_E2E_V2_HOST` with the path to your local pinned build.
- After an e2e run, remove the evidence directory
  `.grace/changes/active/C-OPENCODE-V2-NATIVE/`, otherwise `grace lint` fails (details in
  `verify.md`).

## Tooling requirements

- bun >= 1.3.8, node >= 22, opencode exactly 2.0.18 (sha must match the pin).
- npm: a real npm 10.x must be on `PATH` (needed by `pack:check`/release scripts for
  `npm pack --dry-run`). A corepack npm shim does not work in this repo (`packageManager` is bun;
  the shim answers “Unsupported package manager specification”).
- grace CLI: use the installed stable binary per “GRACE CLI Checks” in AGENTS.md.

## Delivery constraints

- Never push task branches and never run `gh pr create`: delivery is owner-gated. Keep all work
  as commits on the local task branch; publication is a maintainer decision.

## What not to do

- Do not touch user/production configs and data; do not run commands that publish the package
  (`release:bump`, npm publish) — not even “just to check”.
- Do not leave processes listening on ports or scratch directories outside your own temp folders.
