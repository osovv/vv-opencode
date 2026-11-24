---
name: vv-handoff
description: Use at the end of a session to write a project-local XML handoff note from already-visible context only.
---

<scope>
Preserve the current visible session context as a handoff note for a future agent or human. Write exactly one XML file in the current project. You do not investigate, verify, summarize hidden history, or collect fresh evidence.
</scope>

<workflow>
1. Identify the main session goal from the visible context and derive the date-slug directory name.
2. Draft handoff.xml using only visible/known context and the required sections.
3. Replace every sensitive value with [REDACTED].
4. Create the destination directory with collision suffixing if needed, then write handoff.xml.
5. Reply with the path written and note that no fresh commands or checks were run.
</workflow>

<rules>
- Use only the current visible chat context and facts already known in this session.
- Do not reconstruct hidden, compacted, unavailable, or earlier conversation history.
- Do not run shell commands, tests, lint, build, git status, git diff, web searches, repository scans, or any other fresh context collection step.
- If git status, git diff, verification, or other evidence was not already collected in the current session, record it as not collected in current session rather than collecting it during handoff.
- Write exactly one canonical handoff artifact under the current project: .vvoc/handoff/YYYY-MM-DD-&lt;session-slug&gt;/handoff.xml.
- Derive &lt;session-slug&gt; from the main session goal using lowercase words, hyphens, and only URL/path-safe characters.
- Use the current local date for YYYY-MM-DD when it is already available in the session environment; otherwise use the date visible in system context.
- If the destination directory already exists, choose the first available collision suffix: -2, then -3, and later integers, yielding paths such as .vvoc/handoff/YYYY-MM-DD-&lt;session-slug&gt;-2/.
- Filesystem checks and directory/file creation are allowed only to choose and write the destination path. Do not inspect project files for additional context.
- Before writing handoff.xml, redact secrets from the handoff content. Replace tokens, API keys, passwords, cookies, private URLs, private headers, credentials, private keys, and similar sensitive values with [REDACTED]. If unsure whether a value is sensitive, redact it.
- The XML does not need a formal schema and must not be schema-validated.
- Use clear, grep-friendly element names and concise prose.
- Do not create a CLI command, plugin, runtime hook, automatic writer, schema validator, or handoff.md artifact.
</rules>

<artifact>
Required sections:
- original_request — the user's original goal or request as visible in this session.
- completed_work — work completed in this session, including files changed when already known.
- current_state_and_decisions — current state, important decisions, accepted assumptions, selected route, and any pending lifecycle state.
- important_or_changed_files — important files and changed files already known from the session. If changed files were not collected, say not collected in current session.
- known_commands_and_results — commands, checks, tests, git status, git diff, and verification results already run in this session. For missing evidence, write not collected in current session.
- blockers_risks_unknowns — blockers, risks, unknowns, skipped checks, residual uncertainty, and anything a future session must not assume.
- next_safe_step — the single safest next action for the next session.

Template:
<![CDATA[
<handoff>
  <original_request></original_request>
  <completed_work></completed_work>
  <current_state_and_decisions></current_state_and_decisions>
  <important_or_changed_files></important_or_changed_files>
  <known_commands_and_results></known_commands_and_results>
  <blockers_risks_unknowns></blockers_risks_unknowns>
  <next_safe_step></next_safe_step>
</handoff>
]]>
</artifact>

<done>
handoff.xml is written at the resolved path. The reply names that path and states that no fresh commands or checks were run.
</done>
