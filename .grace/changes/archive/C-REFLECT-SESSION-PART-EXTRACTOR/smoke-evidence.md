# Change-time verification evidence — C-REFLECT-SESSION-PART-EXTRACTOR

Recorded 2026-11-25. Change-time evidence, not a CI gate: deterministic
extraction behavior is asserted by the extended session-graph.test.ts; this
file records the manual checks against the live migrated host.

## Measurement before the change (problem evidence)

`session-graph.py --session <id> --project . --format json` on 2026-11-25:

| Session | Era | tool_calls | errors | test_runs | files | tail |
|---|---|---|---|---|---|---|
| ses_dedda6929ffejII1QtOWIPyYUG (reviewer, dozens of real calls) | post-migration | 0 | 0 | 0 | 0 | empty |
| ses_df227688effeJPesobCiatRQb0 (yesterday) | pre-migration | 509 | 11 | 49 | 20 | 3 messages |

## Live re-measurement after the change (spec AC-07)

Same commands, same database:

| Session | tool_calls | errors | test_runs | files | tail |
|---|---|---|---|---|---|
| ses_dedda6929ffejII1QtOWIPyYUG | 47 | 0 | 3 | 0 (review-only session: no mutating tools — honest) | 1 (the review verdict text) |
| ses_df227688effeJPesobCiatRQb0 | 509 | 11 | 49 | 20 | 3 — identical to before, regression preserved |

A file-editing post-migration session (this session,
ses_dee2b39dfffeCJw6E1SLWjIwNk) reports 274 tool calls and 20 changed files
collected from session_part edit/write tool parts.

Archive aggregate for 2026-11-25 on this project: 6 sessions, 432 calls,
13 errors — post-migration calls are now counted in the machine-wide view.

## Gate runs

- `bun test src/lib/session-graph.test.ts` — 12 pass / 0 fail (10 existing
  fixtures unchanged as regression pins; 2 new post-migration tests covering
  tree mode and the archive call-id union).
- `bun run check` — pass (2394 pass, 0 fail across 145 files).
- `bun run build` / `bun run pack:check` — pass (pack:check ran inside the
  target assertion gate).
- `grace lint --change C-REFLECT-SESSION-PART-EXTRACTOR --assertions target
  --run-commands` — 0 errors / 0 warnings, all four MustPassCommands green.
