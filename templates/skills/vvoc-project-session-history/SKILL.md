---
name: vvoc-project-session-history
description: Use when the user asks what was recently done in this project, where the work stopped, or wants a recap or handoff from recent OpenCode sessions before continuing. Not for token usage, cache, or cost analysis (vvoc-usage-analytics) and not for current repository state.
---

<scope>
Recover recent project context from OpenCode's local SQLite history without mutating the database or the repository. Treat session history as historical evidence, not proof of current state: every stopping-point or deliverable claim is reconciled against fresh Git state before it reaches the user. The extractor is strictly read-only — it connects with a `?mode=ro` SQLite URI — and requires python3 on the host; if either the database or the interpreter is unavailable, say so plainly instead of improvising.
</scope>

<workflow>
1. Run the extractor from the current working directory, with the script path resolved relative to this skill's own directory:

   ```bash
   python3 scripts/project_history.py --project "$PWD" --sessions 6
   ```

   The default database is `~/.local/share/opencode/opencode.db`; pass `--db PATH` to override it.

2. Inspect the newest result. OpenCode V2 writes sessions immediately, so the newest entry is often the currently running session; if it is only this recap request, ignore it, or rerun with `--skip-newest`.

3. Start with top-level sessions. If a parent session mentions delegated work or lacks the decisive result, rerun with `--include-children` and a larger session limit. Do not dump every child session by default.

4. For a Git repository, freshly check the current state before synthesizing:

   ```bash
   git status --short --branch
   git log --oneline -8
   ```

   Inspect a specific artifact only when the history names it as the stopping point or the pending deliverable.

5. Synthesize the answer; do not paste the extractor's raw transcript. Prefer this structure:

   - **Summary** — what the project was pursuing recently.
   - **Recent sessions** — chronological bullets with dates, outcomes, and important decisions.
   - **Where work stopped** — completed work, unfinished work, blockers, uncommitted state, or approvals still needed.
   - **Sensible next steps** — only evidence-backed ones.
</workflow>

<rules>
- Prefer explicit final assistant reports, verification results, commits, and the latest user decisions over stale todo statuses.
- Distinguish completed implementation from a draft spec, draft plan, investigation, or proposed work.
- Mention uncertainty when a session ended without a clear final report or when history conflicts with the current repository.
- Ignore routine progress chatter unless it explains the stopping point.
- Keep dates and session titles when they help orient the user.
- Never reveal credentials, tokens, private tool payloads, or unrelated project history. The extractor reads text messages and summaries only — reasoning and raw tool calls are excluded by design — but still redact any secret-looking text before replying.
- Do not edit files, resume implementation, or run broad verification unless the user separately asks to continue the work.
</rules>

<artifact>
Data source layout — why the extractor sees what it sees:

- Session lists come from the OpenCode V2 `session_v2` table, with a `session` (V1) fallback union for databases that still hold pre-V2 rows; a database with only one of the two tables is also supported.
- History after 2026-10-02 lives only in `session_v2`/`session_message`; older sessions keep their messages in the legacy `message`+`part` tables. The extractor reads both stores and deduplicates.
- Only `type: text` parts are extracted — reasoning, tool transcripts, and synthetic/system rows are excluded by design.
- V2 writes sessions immediately, so the "newest" entry is often the currently running session; use `--skip-newest` with that in mind.
- Sessions without a generated title are shown under their slug (for example `swift-meadow`).

Extractor options:

- `--sessions N` — number of recent matching sessions.
- `--include-children` — include subagent/child sessions.
- `--skip-newest` — omit the newest matching session.
- `--tail-messages N` — number of final text messages retained per session.
- `--message-chars N` — maximum characters retained from one text message.
- `--db PATH` — override the default OpenCode database path.
</artifact>

<done>
The deliverable is a synthesized recap: recent work, stopping points, current-repository reconciliation, and evidence-backed next steps — with the raw transcript, reasoning traces, and secret-looking text left out. If the extractor found no matching sessions, say so plainly instead of generalizing from repository state alone.
</done>
