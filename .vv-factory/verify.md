# Verification protocol: vv-opencode

Every command below has been executed on a clean checkout of `main` (commit and fresh numbers in
`known-flakes.md`). “Green” means actual attached output, not “it should pass”.

## Independent verification order

```bash
# 0. Clean state: git status --short — only expected files.
bun install                                # ~520 packages, seconds

# 1. Main gates (in increasing order of severity):
bun run check                              # typecheck + oxlint + oxfmt + grace markup + tool contracts + bun test
bun run build                              # regenerates dist/
bun run pack:check                         # build + export checks + npm pack --dry-run + packed contracts

# 2. Real-host checks (need the pinned host binary; PATH is not scanned):
export VVOC_E2E_V2_HOST=/path/to/opencode  # must be the pinned 2.0.18 build (sha256-checked)
bun test                                   # all unit + host-smoke tests (after build)
bun scripts/e2e-v2.ts --core               # e2e subset; full run: bun run e2e:v2 (--full, slower)

# 3. If .grace/ artifacts changed:
grace lint --path .
grace status --path .
```

## What green means

- `bun run check`: all static gates error-free; for `bun test` compare against the reference
  numbers in `known-flakes.md`. A fresh clone without dist and without `VVOC_E2E_V2_HOST` skips 9
  host-smoke tests — that is normal. Compare any difference against `known-flakes.md`: known
  pre-existing failures are listed there — do not fix them in someone else's task and do not
  treat them as your regression, but do not hide them either.
- `bun run build`: exit 0, `dist/` regenerated.
- `bun run pack:check`: the line
  `✓ @osovv/vv-opencode@<version> exports and packed artifact are current.`
- `bun test` with a host: a failure of `secrets-redaction ... distinct-context subpath
  registration (secrets-first)` is known pre-existing (see `known-flakes.md`); cite the file.
- e2e core: `core summary: N pass, M fail`; a failure of the `activation` case with the text
  “packed package exposes a semver version (2.3.0-rc.N)” is a known version constraint (the
  assertion requires a stable semver while the repo is in prerelease), see `known-flakes.md`.
- `grace lint`: `No issues found.` IMPORTANT: after an e2e run the harness leaves
  `.grace/changes/active/C-OPENCODE-V2-NATIVE/core-evidence.json` on disk, which makes
  `grace lint` fail (`xml.missing-file spec.xml`). Delete that evidence directory (it is not
  tracked by git) before the lint check, then run lint.

## A scenario that actually exercises the change

For each concrete task: run the narrow test/command that exercises the changed behavior (for a
CLI command, the actual `bun run src/cli.ts <cmd> …` invocation in a scratch environment) and
attach before/after output. General principle: observable evidence that the changed code works,
not just green static gates.
