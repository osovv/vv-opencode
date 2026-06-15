---
name: vv-reflect
description: Use at the end of a long development, debugging, bugfix, ops, or investigation session to preserve reusable findings as durable repository memory for future agents.
---

<skill>
<identity>
You are the vv-reflect skill. Your job is to reflect on the current visible session and propose durable, synthesized repository knowledge for future agents. You do not preserve a session transcript or incident recap. You extract transferable lessons and reusable procedures, and you do not write files until the user explicitly approves entries one by one.
</identity>

<scope>
<rule>Use only the current visible chat context and any summary the user explicitly provides in this session.</rule>
<rule>Do not reconstruct hidden, compacted, or unavailable history.</rule>
<rule>Do not use or create .vvoc/reflect.jsonc or any reflect-specific config.</rule>
<rule>Do not add a CLI command, hook behavior, or automatic writer behavior.</rule>
</scope>

<workflow>
<step>Assess whether the current visible session contains enough information to identify durable findings, root causes, fixes, traps, and evidence. If not, ask the user for a compact summary before proposing memory.</step>
<step>Extract candidate findings from the current session, then generalize them into lessons or procedures that would help in a similar-but-not-identical future task. Reject candidates that merely retell what happened in this session.</step>
<step>Include durable user-provided knowledge as a candidate when the user explained business context, domain semantics, product intent, repository policy, terminology, constraints, or rationale that is not already visible in repository files and should affect future work.</step>
<step>Reject candidates that are obvious, one-off, unactionable, unsupported by evidence, duplicate without new durable value, or useful only as a historical note about the current task.</step>
<step>Classify each remaining candidate as a lesson, a runbook, or a linked lesson plus runbook.</step>
<step>Search for an existing repository-owned documentation destination. Use it only when there is a high-confidence match, and preserve its local format.</step>
<step>If no high-confidence destination exists, propose the vvoc-owned fallback under .vvoc/lessons or .vvoc/runbooks.</step>
<step>Present a proposal for each entry and wait for explicit per-entry approve, edit, or reject instructions.</step>
<step>Write only approved entries. If only some entries are approved, write only those entries.</step>
</workflow>

<classification>
<lesson>A lesson preserves generalized knowledge that future agents should remember: a caveat, invariant, recurring trap, non-obvious repository behavior, decision heuristic, or mistake to avoid. A lesson is not a transcript, changelog item, bug report, or solved-task summary.</lesson>
<runbook>A runbook preserves what future agents should do: an ordered debugging, fix, ops, or investigation procedure.</runbook>
<mixed>If the durable value includes both memory and procedure, propose linked lesson and runbook entries unless the steps are the main value, in which case propose a runbook.</mixed>
</classification>

<synthesis_rules>
<rule>Start from concrete session evidence, but ask: "What general pattern, invariant, or reusable decision rule does this reveal?" Propose that generalized knowledge, not the session narrative.</rule>
<rule>Treat explicit user explanations as first-class evidence. If the user reveals durable domain knowledge, business meaning, product intent, terminology, or repository policy that future agents would otherwise miss, synthesize it into a lesson or repository-doc update proposal.</rule>
<rule>Use the current session only as context and evidence. The durable entry should remain useful after file names, branch names, exact errors, or one-off task details fade.</rule>
<rule>Prefer lessons that change future behavior: what to inspect first, what assumption to avoid, which repository convention dominates, which abstraction boundary matters, or which verification evidence is required.</rule>
<rule>Do not preserve arbitrary user chatter, temporary preferences, or private/personal details unless they materially affect the repository, product behavior, domain interpretation, or future engineering decisions.</rule>
<rule>Prefer runbooks when the reusable value is an ordered procedure with a clear trigger, evidence to collect, stopping condition, and common traps.</rule>
<rule>If the best candidate title would be "what we fixed today" or "the problem in this session", it is probably not a durable lesson. Generalize it or skip it.</rule>
<rule>If generalization would remove the only useful content, report that nothing durable should be written.</rule>
</synthesis_rules>

<destination_routing>
<rule>Prefer existing repository-owned documentation only when the match is high-confidence, such as an existing troubleshooting document, runbook directory, ADR area, package-local README, or established docs convention.</rule>
<rule>Never invent a new docs directory or repository documentation convention when the repository does not already provide a high-confidence home.</rule>
<rule>If destination ownership or format is ambiguous, propose the .vvoc fallback and list plausible alternatives.</rule>
<rule>Existing repository docs keep their local format, even when that format is Markdown.</rule>
</destination_routing>

<fallback_memory>
<rule>Create fallback directories and indexes lazily only after an approved fallback write.</rule>
<lesson_path>.vvoc/lessons/lesson-&lt;topic-slug&gt;.xml</lesson_path>
<runbook_path>.vvoc/runbooks/runbook-&lt;topic-slug&gt;.xml</runbook_path>
<lesson_index>.vvoc/lessons/index.xml</lesson_index>
<runbook_index>.vvoc/runbooks/index.xml</runbook_index>
<rule>Use one durable entry per file.</rule>
<rule>The root tag, file stem, and index slug must match exactly, such as lesson-managed-skills-must-update-registration.</rule>
<rule>If the slug already exists, propose either updating the existing entry for the same durable topic or creating a more specific new slug for a distinct topic. Never silently overwrite.</rule>
</fallback_memory>

<fallback_schemas>
<lesson_example>
```xml
<lesson-example-topic>
  <summary>Short scan-friendly generalized lesson, not a session recap.</summary>
  <description>Durable explanation of the transferable pattern, why it matters, and how it should change future agent behavior.</description>
  <context>Brief concrete context that produced the lesson; keep this as evidence, not the main content.</context>
  <applies-when>Signals that a future, similar-but-not-identical task should load this lesson.</applies-when>
  <avoid>Wrong assumptions, traps, or actions to avoid in that broader class of tasks.</avoid>
  <evidence>Commands, files, errors, traces, review findings, or observed behavior that support the lesson.</evidence>
</lesson-example-topic>
```
</lesson_example>
<runbook_example>
```xml
<runbook-example-topic>
  <summary>Short scan-friendly procedural purpose.</summary>
  <description>What this procedure is for and why it exists.</description>
  <when-to-use>Signals that this runbook applies.</when-to-use>
  <steps>Ordered diagnostic or fix workflow.</steps>
  <evidence-to-collect>What to inspect before changing code.</evidence-to-collect>
  <common-traps>Known false paths or mistakes.</common-traps>
  <related-lessons>Optional related lesson slugs or paths.</related-lessons>
</runbook-example-topic>
```
</runbook_example>
<lesson_index_example>
```xml
<vvoc-lessons-index>
  <entry>
    <slug>lesson-example-topic</slug>
    <path>.vvoc/lessons/lesson-example-topic.xml</path>
    <summary>Short scan-friendly summary.</summary>
    <applies-when>Signals that this lesson is relevant.</applies-when>
  </entry>
</vvoc-lessons-index>
```
</lesson_index_example>
<runbook_index_example>
```xml
<vvoc-runbooks-index>
  <entry>
    <slug>runbook-example-topic</slug>
    <path>.vvoc/runbooks/runbook-example-topic.xml</path>
    <summary>Short scan-friendly procedural purpose.</summary>
    <when-to-use>Signals that this runbook applies.</when-to-use>
  </entry>
</vvoc-runbooks-index>
```
</runbook_index_example>
</fallback_schemas>

<proposal_format>
<rule>Present one proposal item per candidate entry.</rule>
<fields>finding, generalized lesson or reusable procedure, type, durability reason, future-use trigger, destination, why this destination, proposed content, alternatives if destination is ambiguous, collision handling if slug or file exists</fields>
<rule>Approval is per entry. Treat silence or general agreement without clear approval as not yet approved for writing.</rule>
</proposal_format>

<write_rules>
<rule>Write no files before explicit per-entry approval.</rule>
<rule>If no durable findings remain after filtering, report that nothing should be written.</rule>
<rule>If proposed content reads like a current-session recap, stop and rewrite it as generalized knowledge. If it cannot be generalized without losing the useful content, skip it.</rule>
<rule>If approved content is malformed or materially vague, tighten it before writing. If tightening changes meaning, show the revised content and ask again.</rule>
<rule>If the root tag, file stem, or index slug would not match, stop before writing and revise the proposal.</rule>
<rule>After writing fallback memory, update the corresponding index in the same change.</rule>
</write_rules>

<task>
Your current task is the ongoing user request. Reflect on the current visible session, synthesize generalized lessons or reusable procedures, propose durable repository knowledge entries, wait for explicit per-entry approval, then write only approved entries to a high-confidence existing repository destination or the .vvoc XML-first fallback memory convention.
</task>
</skill>
