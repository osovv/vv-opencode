# Change-time verification evidence — C-SESSION-PART-EXTRACTOR

Recorded 2026-11-25. Change-time evidence, not a CI gate: deterministic
extraction behavior is asserted by src/lib/session-history.test.ts; this file
records the manual checks that require the live migrated host.

## Live smoke run (spec AC-08, plan T-004)

Command:

```bash
python3 templates/skills/vvoc-project-session-history/scripts/project_history.py \
  --project . --sessions 3 --include-children
```

Host database: the real `~/.local/share/opencode/opencode.db` after the
2026-11-25 storage migration (assistant parts in `session_part`, assistant
`session_message` rows with `content=[]`). Observed:

- ASSISTANT lines: **22** (the predecessor's frozen script produced 0 on the
  same input — reproduced at review time as 13 USER / 0 ASSISTANT).
- Sample evidence (post-migration session, assistant text joined from
  `session_part`): "Принято: successor change в PR #63. Начинаю с живых
  данных — формы частей в `session_part`…"
- Reasoning leak check: 0 matches for reasoning-style markers.
- "Files mentioned by recorded patches" lists exactly the files edited or
  written by the current session (SKILL.md, README.md, the managed-skills and
  opencode sources and tests, both change bundles), sourced from `session_part`
  edit/write tool parts; read-only tool paths are absent.

## URI encoding check (spec AC-05)

A fixture database created at a path containing `?` and `#`
(`/tmp/…/q?mark#hash.db`) opens through `connect_readonly` without error after
the percent-encoding fix; the synthetic suite also names its fixture database
`history?mark.db`, so every test run exercises the encoded URI.

## Gate runs

- `bun test src/lib/session-history.test.ts` — 2 pass / 0 fail (python3-gated
  synthetic three-era schema: post-migration extraction, typed exclusion,
  inline-wins transition precedence, V1 legacy path, edit/write file
  collection, other tools excluded).
- `bun run check` — pass (2392 pass, 0 fail across 145 files; typecheck,
  oxlint, oxfmt, GRACE markup, tool-contract gate included).
- `bun run build` / `bun run pack:check` — pass (pack:check ran inside the
  target assertion gate; both skill files remain in the packed archive).
- `grace lint --change C-SESSION-PART-EXTRACTOR --assertions target
  --run-commands` — 0 errors / 0 warnings, all four MustPassCommands green.

## Supersession record

This change supersedes the byte-identity freeze of
C-BUNDLE-SESSION-HISTORY-SKILL (md5 09a533b18b7ed4794de118d2041b9fc4): that
layout ceased to exist when OpenCode migrated storage at ~09:51 on 2026-11-25,
after the predecessor's smoke run (09:25) and before the independent code
review that caught the gap. The predecessor bundle stays immutable; behavior
markers in this change's plan replace the md5 pin.
