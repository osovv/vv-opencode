# Change-time verification evidence — C-BUNDLE-SESSION-HISTORY-SKILL

Recorded 2026-11-25. Change-time evidence, not a CI gate: deterministic delivery
is asserted by the test suites; this file records the manual checks that require
a live host.

## Smoke run of the shipped extractor (spec AC-11, plan T-009)

Command:

```bash
python3 templates/skills/vvoc-project-session-history/scripts/project_history.py \
  --project ~/dev/vv-opencode --sessions 3
```

The script in `templates/` is the byte-identical source of the installed script
(md5 `09a533b18b7ed4794de118d2041b9fc4`, asserted by the plan's T-001 gate and
`bun test src/lib/managed-agents.test.ts`). Observed output header:

```
# OpenCode project session history
- Project root: `/home/al/dev/vv-opencode`
- Sessions returned: 3
## Прочитать handoff vv-opencode/-6
- Updated: 2026-11-25T09:25+00:00
## Просмотр активного спека в vv-opencode
- Updated: 2026-11-25T05:46+00:00
## swift-meadow
- Updated: 2026-11-25T05:40+00:00
```

The host database is pure V2 (no `session`/`message`/`part` tables), so this
exercises the `session_v2`-only branch: recent sessions are listed, the NULL
title renders as the slug (`swift-meadow`), and no reasoning text appears in the
selected conversation evidence.

## Packed archive contents (spec AC-11)

`npm pack --dry-run` lists both shipped files:

```
npm notice 18.1kB templates/skills/vvoc-project-session-history/scripts/project_history.py
npm notice 5.1kB  templates/skills/vvoc-project-session-history/SKILL.md
```

## Derived install/sync surface totals (spec AC-06, plan T-006)

`expectedManagedSkillResultCount` re-derived on the implemented tree:
35 files total, 33 in the vv-spec-skip case (12 SKILL.md + 22 references +
1 script; vv-spec skip drops its 2 references, it ships no scripts). Matches the
spec assumption and the updated V-M-CLI-MANAGED-SKILLS scenario.

## Gate runs

- `bun run check` — pass (2390 pass, 0 fail across 144 files; typecheck, oxlint,
  oxfmt, GRACE markup, tool-contract gate included).
- `bun run build` — pass (dist regenerated, non-TS assets mirrored).
- `bun run pack:check` — pass (run by the target assertion gate).
- `grace lint --path . --change C-BUNDLE-SESSION-HISTORY-SKILL --assertions target
  --run-commands` — pass, 0 errors / 0 warnings, all four MustPassCommands green.
