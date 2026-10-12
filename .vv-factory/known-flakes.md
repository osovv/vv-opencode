# Known failures and verification baseline: vv-opencode

Verifiers: RECONCILE your results against this file. Failures listed here are pre-existing — do
not fix them in someone else's task and do not drown in them; any NEW failure is yours to
investigate.

## Baseline: fresh runs on a clean main

- Commit: `b13a09859c34f4f9acf9eedf7c3f30b6f34d6f3e` == `origin/main`, tree clean.
- Date of runs: 2026-10-12 (bun 1.3.8, node v22.12.0, opencode 2.0.18 with a sha matching the
  pin, npm 10.9.4).
- Historical note: “e2e on b13a098 used to fail ~30 tests” is NOT reproduced by fresh runs; the
  current numbers are below.

| Check | Result | Status |
|---|---|---|
| `bun install` | 519 packages, ok | green |
| `bun run check` | typecheck ✓, oxlint 0/0 ✓, oxfmt ✓, grace markup ✓, tool contracts ✓; `bun test`: **2243 pass / 1 fail / 9 skip** | see flakes 1–2 |
| `bun run build` | exit 0, dist/ regenerated | green |
| `bun run pack:check` | `✓ @osovv/vv-opencode@2.3.0-rc.8 exports and packed artifact are current.` | green |
| `VVOC_E2E_V2_HOST=… bun test` (after build) | **2251 pass / 1 fail / 0 skip** | see failure A |
| `VVOC_E2E_V2_HOST=… bun scripts/e2e-v2.ts --core` | **11 pass / 1 fail** (12 cases) | see failure B |
| `grace lint --path .` (clean tree) | `No issues found.` | green |
| `grace status --path .` (clean tree) | no status degradation before e2e runs | green* |

## Known failures/flakes (all confirmed by fresh runs)

1. **FLAKE (timeout under load)**: `bun test` — `src/commands/orchestration.test.ts:176`
   “registered CLI set and show print profile, source, target, and restart guidance” sometimes
   exceeds the 20s limit during a full parallel run. In isolation it passes in ~0.4s, and a
   repeat full run on the same day finished fully green (**2244 pass / 9 skip / 0 fail**) — the
   flake is intermittent under load, so a fully green `check` is also a valid baseline.
   Action: rerun the file in isolation (`bun test src/commands/orchestration.test.ts`) — green in
   isolation means the same known flake.
2. **9 skips in `bun run check`** — not a failure: host-smoke tests are gated on the
   `VVOC_E2E_V2_HOST` env var (and a built `dist/`). Normal in a fresh clone without a build;
   with a host and a build they execute (see the “bun test after build” row).
3. **FAILURE A (stable, deterministic)**: `bun test` with a host —
   `src/plugins/secrets-redaction/index.test.ts:960` “distinct-context subpath registration
   (secrets-first): preserves core failure evidence for T009”. The test documents an
   inconsistent T009 aggregate mode: it expects `outcome === "failed"` plus a
   `SnapshotAdmissionError` in the host log, while the host actually reports `"succeeded"`. It
   fails in isolation too. Looks like host/environment behavior drift relative to the contract
   captured in the test; NOT a regression of new changes.
4. **FAILURE B (version-related, stable)**: e2e core — the `activation` case “Packed artifact
   import, mandatory guards, and idle registry quiescence”: the assertion `/^\d+\.\d+\.\d+$/`
   requires a stable semver while the repo is in prerelease `2.3.0-rc.8`. On a stable version the
   case passes. The other 11 cases are green. The harness writes its evidence file to
   `.grace/changes/active/C-OPENCODE-V2-NATIVE/core-evidence.json`.
5. **E2E SIDE EFFECT**: after any e2e run the directory
   `.grace/changes/active/C-OPENCODE-V2-NATIVE/` (evidence only, no spec.xml) stays on disk, and
   `grace lint --path .` starts failing with `xml.missing-file …/spec.xml`, while
   `grace status` reports “GRACE artifacts are invalid”. The directory is not tracked by git;
   before grace checks remove it: `rm -rf .grace/changes/active/C-OPENCODE-V2-NATIVE`.
6. **ENVIRONMENT (not the repo)**: `pack:check` needs a real npm on `PATH` (for
   `npm pack --dry-run`); a corepack npm shim is incompatible with `packageManager: bun`. Without
   npm the failure looks like `Executable not found in $PATH: "npm"` — an environment issue, not
   code. See `environment.md`.

## How to cite

In a verification report, reference this file by item: “the failure matches known-flakes #N,
fresh output attached”.
