---
name: vvoc-usage-analytics
description: Use when the user asks about token usage, cache hit rate, cache efficiency, model or provider consumption, session costs, or whether a vvoc release or OpenCode upgrade changed caching behavior. Runs read-only analysis over vvoc analytics (CLI and JSONL) and historical opencode.db data, then reports findings without modifying anything.
---

<scope>
Turn usage questions into evidence-based answers. Know the three data sources, their coverage boundaries, and the exact metric definitions, and never guess a number you did not read from a source. You are an analyst, not a fixer: report findings and leave changes to the user.

OpenCode's database is strictly read-only: always connect with a `?mode=ro` URI (see references/opencode-db-queries.md). Never run UPDATE/INSERT/DELETE/DDL against it, even diagnostically. Never modify, delete, truncate, or "repair" analytics JSONL files, and never suggest doing so as a fix. Read-only also means no config changes: do not toggle plugins, rewrite vvoc.json, or restart anything unless the user explicitly asks for that as a separate task. Report findings only; recommendations are fine, silent "fixes" to telemetry or config are out of scope. If a source is unavailable (no db file, empty JSONL, sqlite3 missing), say so explicitly and continue with the sources that exist instead of implying there was no usage.
</scope>

<workflow>
1. Clarify the question into metric(s), grouping, and time range. If the user's ask is vague ("is my cache ok?"), default to hit rate grouped by day for the last 14 days plus coverage, then offer deeper cuts.
2. Pick the narrowest source that can answer it: CLI first; JSONL only for cuts the CLI lacks; opencode.db only for pre-plugin history or cost-per-session questions. State which source you are using and why.
3. Run the query read-only. For db queries, use the reference snippets; adapt only filters (WHERE/LIMIT), not the hit-rate formula.
4. Sanity-check coverage before answering: how many steps does the range contain, what share is cache-eligible (coverage), and where does each source's data begin. A hit rate over 12 steps means more than one over 12,000.
5. Present findings as a compact table plus 2-4 sentences of interpretation. Every answer names its data source and time range. When mixing sources, state the JSONL start boundary explicitly so the user knows which numbers come from where.
6. Offer the natural follow-up cut (by model, by session, before/after a date) instead of running all of them unasked.
</workflow>

<rules>
- Prefer the vvoc CLI for anything it can answer. It already dedupes, filters, groups, and formats.
- CLI coverage starts when the analytics plugin first ran (JSONL start date), and only steps after an OpenCode restart are recorded.
- Use raw monthly JSONL files only when the question needs something the CLI does not compute (unusual groupings, per-agent or per-message drill-downs, exact record inspection). Lines are JSON objects: `kind` is `usage` (one per step-finish part, dedupe by `partID` keeping the last) or `session` (dedupe by `sessionID`). jq, python, or bun one-liners are all fine — reading only.
- Use OpenCode's own SQLite database for history that predates the plugin and for per-session cost aggregates. It holds months of step-finish parts with tokens, session cost and token totals, and `session.version` — the OpenCode version. Always read it with the validated snippets in references/opencode-db-queries.md (`?mode=ro` URI). This is the only source that can answer "how did caching look before vvoc analytics existed" and "what did sessions cost".
- Tables over prose for any comparison; columns in the CLI's spirit (GROUP, STEPS, COVERAGE, HIT-RATE, CACHE-READ, CACHE-WRITE, FRESH-IN or their subset).
- Every number carries its source (CLI / JSONL / opencode.db) and time range.
- State validation context for db queries: the snippets were validated against OpenCode 1.18.x, and the supported host window is 2.0.18 and newer, below 3.0.0. If columns error out, report the schema mismatch instead of improvising SQL guesses.
- Interpretation stays factual: rising/falling hit rate, coverage share, outliers. Avoid unfounded causal claims; a vvoc version bump and a project switch can co-occur.
</rules>

<artifact>
Data sources, in precedence order:

| Precedence | Source | Use when | Coverage |
|---|---|---|---|
| 1 | vvoc CLI | anything it can answer: trend, release/version comparison, per session/model/provider/project grouping | starts when the analytics plugin first ran; only steps after an OpenCode restart |
| 2 | analytics JSONL (`$XDG_DATA_HOME/vvoc/analytics/usage-YYYY-MM.jsonl`) | cuts the CLI does not compute: unusual groupings, per-agent or per-message drill-downs, exact record inspection | monthly files from the plugin start date |
| 3 | opencode.db (`~/.local/share/opencode/opencode.db`, override via `$OPENCODE_DATA_HOME`) | pre-plugin history and per-session cost aggregates | months of step-finish parts; `session.version` carries the OpenCode version |

CLI examples:
- Trend: `vvoc analytics cache-hit-rate --group-by day|week|month --since 30d`
- Compare vvoc releases: `--group-by vvoc --since 30d`
- Compare OpenCode versions: `--group-by opencode --since 30d`
- Per session / model / provider / project: `--group-by session|model|provider|project`
- Filters and output: `--since`/`--until` accept `Nd`/`Nw`/`Nm` or `YYYY-MM-DD`; `--project` is a case-insensitive substring; `--order steps|hit-rate|date`; `--limit N`; `--json` for machine-readable rows.

Metric definitions:
- cache hit rate — token-weighted: `cacheRead / (cacheRead + cacheWrite + input)` summed over cache-eligible steps. A step is cache-eligible when `cacheRead + cacheWrite > 0`. Identical to the CLI and the SQL reference — do not invent per-step averaging.
- coverage — `eligibleSteps / steps`. Low coverage means the provider rarely reports cache tokens; say that, do not hide it behind a hit rate.
- n/a — groups with zero eligible steps have no hit rate. Report `n/a` — never `0%` — and show coverage so "provider does not report cache" stays distinguishable from "cache misses".
</artifact>

<refs>
- `references/opencode-db-queries.md` — validated read-only opencode.db snippets; load before any database query and adapt only WHERE/LIMIT filters.
</refs>

<done>
The answer presents a compact table plus interpretation, names the data source and time range for every number, states coverage and any source boundary, and offers one natural follow-up cut. No data source or config was modified.
</done>
