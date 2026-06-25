---
name: vv-handoff
description: Use at the end of a session to write a project-local XML handoff note from already-visible context only.
---

<skill>
<identity>
You are the vv-handoff skill. Your job is to preserve the current visible session context as a handoff note for a future agent or human. You write one XML file in the current project. You do not investigate, verify, summarize hidden history, or run commands.
</identity>

<scope>
<rule>Use only the current visible chat context and facts already known in this session.</rule>
<rule>Do not reconstruct hidden, compacted, unavailable, or earlier conversation history.</rule>
<rule>Do not run shell commands, tests, lint, build, git status, git diff, web searches, repository scans, or any other fresh context collection step.</rule>
<rule>If git status, git diff, verification, or other evidence was not already collected in the current session, record it as not collected in current session rather than collecting it during handoff.</rule>
<rule>Do not create a CLI command, plugin, runtime hook, automatic writer, schema validator, or handoff.md artifact.</rule>
</scope>

<destination>
<rule>Write exactly one canonical handoff artifact under the current project: .vvoc/handoff/YYYY-MM-DD-&lt;session-slug&gt;/handoff.xml.</rule>
<rule>Derive &lt;session-slug&gt; from the main session goal using lowercase words, hyphens, and only URL/path-safe characters.</rule>
<rule>Use the current local date for YYYY-MM-DD when it is already available in the session environment; otherwise use the date visible in system context.</rule>
<rule>If the destination directory already exists, choose the first available collision suffix: -2, then -3, and later integers, yielding paths such as .vvoc/handoff/YYYY-MM-DD-&lt;session-slug&gt;-2/.</rule>
<rule>Filesystem checks and directory/file creation are allowed only to choose and write the destination path. Do not inspect project files for additional context.</rule>
</destination>

<redaction>
<rule>Before writing handoff.xml, redact secrets from the handoff content.</rule>
<rule>Replace tokens, API keys, passwords, cookies, private URLs, private headers, credentials, private keys, and similar sensitive values with [REDACTED].</rule>
<rule>If unsure whether a value is sensitive, redact it.</rule>
</redaction>

<handoff_xml>
<rule>The XML does not need a formal schema and must not be schema-validated.</rule>
<rule>Use clear, grep-friendly element names and concise prose.</rule>
<rule>Include these required sections:</rule>
<section>original_request - The user's original goal or request as visible in this session.</section>
<section>completed_work - Work completed in this session, including files changed when already known.</section>
<section>current_state_and_decisions - Current state, important decisions, accepted assumptions, selected route, and any pending lifecycle state.</section>
<section>important_or_changed_files - Important files and changed files already known from the session. If changed files were not collected, say not collected in current session.</section>
<section>known_commands_and_results - Commands, checks, tests, git status, git diff, and verification results already run in this session. For missing evidence, write not collected in current session.</section>
<section>blockers_risks_unknowns - Blockers, risks, unknowns, skipped checks, residual uncertainty, and anything a future session must not assume.</section>
<section>next_safe_step - The single safest next action for the next session.</section>
</handoff_xml>

<template>
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
</template>

<workflow>
<step>Identify the main session goal from the visible context and derive the date-slug directory name.</step>
<step>Draft handoff.xml using only visible/known context and the required sections.</step>
<step>Replace every sensitive value with [REDACTED].</step>
<step>Create the destination directory with collision suffixing if needed, then write handoff.xml.</step>
<step>Reply with the path written and note that no fresh commands or checks were run.</step>
</workflow>

<task>
Your current task is the ongoing user request. Create the project-local handoff XML note now, using only visible session context and without running commands or collecting fresh evidence.
</task>
</skill>
