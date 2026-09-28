# v2 real-host acceptance harness (`scripts/e2e-v2`)

Repeatable, isolated acceptance for the native OpenCode 2.0.18 rewrite of
`@osovv/vv-opencode`. The core tier exercises the **actual packed package** on the
pinned host; it is not a fixture reimplementation of selection, policy, or
permission behavior.

## What it does

1. Builds the package and packs it with `bun pm pack --ignore-scripts` (only the
   declared `files` ship).
2. Extracts the tarball into an isolated project's `node_modules` and symlinks the
   repository dependency tree so the packed package resolves with no registry
   access.
3. Writes an isolated project (`opencode.json`, `.vvoc/vvoc.json`) and a fixture
   plugin that:
   - imports the packed `./plugins/model-roles` subpath and the packed
     `dist/runtime/context.js`;
   - calls the real `ModelRolesPlugin.setup(ctx)`;
   - acquires the same shared `acquireNativeSnapshotRuntime(ctx)` instance;
   - exposes a nonce-protected `127.0.0.1` control plane that only forwards to
     real runtime methods (`snapshots`, `admitWorkload`, `client`, `permissions`).
4. Starts the pinned host with an allow-listed environment and a loopback-only
   OpenAI-compatible provider, then drives cases through the native HTTP API and
   the control plane.
5. Writes machine-readable evidence and tears everything down by exact PID only.

## Pinned inputs

| Input | Value |
| --- | --- |
| Host binary | `/tmp/opencode/vvoc-seam-host-2.0.18/opencode` |
| Host SHA-256 | `10d405161d8b9595f4a2ec31254e961969e6ca3f8239ac9bd55b6ff6431dc24f` |
| Host source commit | `cd9a14a6b688d4021bee381dfd39d2cef9c0f862` |
| Host version | `2.0.18` |
| Evidence | `.grace/changes/active/C-OPENCODE-V2-NATIVE/core-evidence.json` |
| Parity inventory | `scripts/e2e-v2/parity.json` |

Override the binary with `VVOC_E2E_V2_HOST`; override the scratch root with
`VVOC_E2E_SCRATCH`. A binary whose SHA-256 does not match the pin is refused.

## Modes

```bash
bun run e2e:v2                 # full installed-artifact parity (packed core + real-PTY TUI)
bun scripts/e2e-v2.ts --core    # packed core real-host tier
bun scripts/e2e-v2.ts --list    # print the parity inventory by phase/status
bun scripts/e2e-v2.ts --tui     # real-PTY TUI tier for the actual built TUI
bun scripts/e2e-v2.ts           # same as --full
bun scripts/e2e-v2.ts --full --json --keep   # JSON summary, keep the scratch dir
```

`--core` exits non-zero on a missing/invalid host or any failed case. `--tui`
runs the actual built TUI inside a real PTY against an isolated standalone host
and exits non-zero unless every observed scenario passes. `--full` runs both
installed tiers, resolves every parity row, writes
`.grace/changes/active/C-OPENCODE-V2-NATIVE/parity-evidence.json`, and exits
non-zero while any mandatory parity row is unverified. A reduced core matrix is
never reported as full parity.

## Core case matrix (`--core`)

| Case | What is asserted | Negative control |
| --- | --- | --- |
| `activation` | Packed subpath + runtime import, real setup, mandatory http/model guards, same-instance client challenge, fresh sessions unbound/un-staged | A fresh session has no capture and no staged candidate |
| `admission` | Rejected attachment preparation with zero dispatch then a later valid prompt dispatching exactly once and binding | The rejected preparation dispatches nothing and leaves the family unbound |
| `payload-variants` | One model sends two distinct captured variants; the qualified variant is present in native `model.list` | A fabricated variant is absent from `model.list` |
| `lineage-title` | Persistent parented auxiliary child, `vvocAuxiliary` metadata, shared capture; exactly one parent dispatch (native title suppressed) | An extra parent dispatch would be detected |
| `config-mutation` | Changed config binds new work; the already-bound family keeps its variant | Old family variant is unchanged after the change |
| `owned-generate-synthetic` | Real pre-admission publishes before native `session.generate`/`session.synthetic`, which dispatch the captured payload | Raw unbound generate/synthetic produce zero dispatch and no capture |
| `explicit-selection` | Explicit-at-create and explicit switch are preserved and dispatched | Explicit selection wins over the configured default |
| `fork-worktree` | Native fork (empty parentID + `fork.sessionID`) and worktree move keep the root family capture and dispatch its payload | Moved fork resolves the root family, not a new one |
| `permission-guard` | Awaited guard runs zero effects on deny and one on allow, including a fast reply | Deny must run zero effects; fast reply must not lose the event |
| `ordering-first-accepted` | The first-accepted input's policy binds over a first-staged differing policy | A fixture preparation delay (no admission logic) controls ordering |
| `hook-probe` | Which native hooks register on the pinned host | Availability only; no parity claim |
| `replay-restart` | Persisted root and auxiliary families re-bind their snapshot-qualified variants after a real host restart | Post-restart variants must equal the pre-restart variants |

## Isolation and safety

- The host child environment is allow-listed; inherited credentials, proxies, and
  user OpenCode config are dropped.
- The provider and the control plane bind `127.0.0.1` only; the fixture plugin
  refuses any non-loopback provider dispatch before it reaches the network.
- Provider traces never record authorization headers, so even fixture credentials
  stay out of evidence.
- Processes are signalled only by exact owned PID; foreign PIDs are refused and
  `pkill`/name matching is never used.
- The harness uses only `Service.discover`-style reads of the native registration
  password; it never calls service ensure/stop.
- No paid or public model requests are made.
- The packed package is the only source under test; its dependency tree is
  satisfied by symlinks to the repository `node_modules` so the fixture resolves
  offline. That offline-install shortcut is disclosed here and is **not** the
  T-009 installer proof. A full installer/registry proof is a separate T-009 gate.

## Honest coverage limits

The core tier does **not** claim full product parity. Still pending (see
`parity.json`): the other ten plugins, full workflow/cancellation, CLI/config/setup,
presets and managed content, the full TUI, and secrets/SSE restoration product
parity (T-005/T-009). Same-model switches emit no native event and are not a
criterion. The `ordering-first-accepted` case controls same-session input ordering
through a fixture preparation delay after the real prompt hook (it never implements
admission); equal-time ordering **across** sessions remains covered by engine and
integration tests rather than forced on the host. The `--tui` tier drives the
actual built TUI in a real PTY (a narrow fixture composing the actual built
`dist/tui.js` plus the actual server model-roles plugin as the RPC bridge) and
reports only observed scenarios: `/context` Overview/Tools/MCP navigation,
narrow resize, key-driven scrolling, close/reopen, a visible peak-hours banner,
cache indicator and branding footer, a controlled collection failure without the
server bridge, and explicit-disabled negative controls. `--full` aggregates both
installed tiers and fails, with machine-readable evidence, while any mandatory
parity row has no installed-artifact tier; it never promotes a pending row.

## Module map

| File | Responsibility |
| --- | --- |
| `../e2e-v2.ts` | CLI modes, inventory listing, exit codes |
| `host.ts` | Isolation, packing, packed install, owned PIDs, loopback guard, native API |
| `provider.ts` | Loopback OpenAI-compatible provider and redacted request trace |
| `fixtures/plugin.ts` | Real-context fixture plugin and bounded control plane |
| `fixtures/model-catalog.json` | Deterministic loopback model catalog |
| `cases.ts` | Core case descriptors and observable assertions |
| `core.ts` | Core orchestration, driver, and evidence writer |
| `full.ts` | Installed-artifact full runner: tiers, row resolution, evidence |
| `full-cases.ts` | Parity-row/tier mapping and parity-evidence assembly |
| `tui.ts` | Real-PTY TUI tier (actual built TUI, screen-buffer assertions) |
| `parity.json` | Baseline surface inventory with phase and status |
