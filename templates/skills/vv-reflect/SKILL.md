---
name: vv-reflect
description: Use after a heavy development, debugging, bugfix, ops, or investigation session to reflect on it — including its subagent tree — and improve the agent's environment: documents, steering, guardrails, skills, tooling, and delegation, plus durable lessons and runbooks. Dispatches the read-only vv-reflector subagent, then applies only per-entry approved changes.
---

<scope>
Dispatch the read-only vv-reflector subagent to analyze the current session and its subagent tree, then present its proposals and apply only what the user approves. You do not analyze the transcript inline: the reflector holds the noisy evidence in its own context and returns a short proposal list; you hold the decision and the writes. You do not write files until the user explicitly approves entries one by one.
</scope>

<workflow>
1. Call the native `subagent` tool with `agent: "vv-reflector"`, a short `description`, and a self-contained `prompt` assignment. Use `subagent`, not the V1 legacy `task`/`subagent_type` names.
2. The assignment carries only what the reflector cannot infer: the target session reference, plus an optional focus area and explicit limits. Everything stable — method, categories, friction signals, output format, default caps — lives in the vv-reflector agent prompt, not in the assignment.
3. Prefer a child subagent session id visible from this session's `subagent` results as the target reference — its parent is exactly this session. Otherwise pass an explicit session id. Omit the reference only when neither exists, in which case the extractor defaults to the newest top-level session for the project, which can be a different concurrently active session.
4. Present the reflector's proposals to the user, grouped and ordered by severity, one item per proposal.
5. Then wait for explicit per-entry approve, edit, or reject instructions. Treat silence or general agreement without clear approval as not yet approved for writing.
6. Apply only approved entries, preserving local format, keeping writes idempotent, and never silently overwriting an existing entry or user-owned file.
7. Report what was applied, what was proposed but deferred, and what was skipped.
</workflow>

<rules>
- Use only the current visible chat context for session history; the reflector reads the recorded session and subagent sessions read-only.
- Do not analyze the session yourself before dispatching; the reflector is the analyst.
- If the reflector reports it could not locate the extractor or the target session, report that to the user and stop; do not fall back to inline analysis.
- Do not use or create .vvoc/reflect.jsonc or any reflect-specific config.
- Do not add a CLI command, hook behavior, or automatic writer behavior; keep every applied change inside approved repository documents, guardrails, and vvoc-managed skill or agent templates.
- Prefer the smallest change that removes the friction. Removal and consolidation are valid improvements: a stale, duplicated, or no-op instruction is deleted, not layered over with an exception.
- For a question spanning more than one session or project, run session-graph.py --archive; do not hand-roll SQL and never sum the legacy part table with session_message.

Classification:
- A lesson preserves generalized knowledge that future agents should remember: a caveat, invariant, recurring trap, non-obvious repository behavior, decision heuristic, or mistake to avoid. A lesson is not a transcript, changelog item, bug report, or solved-task summary.
- A runbook preserves what future agents should do: an ordered debugging, fix, ops, or investigation procedure.
- If the durable value includes both memory and procedure, propose linked lesson and runbook entries unless the steps are the main value, in which case propose a runbook.

Synthesis:
- Treat the reflector's findings as evidence, then generalize each into a change that helps in a similar-but-not-identical future task. Reject anything that merely retells what happened in this session.
- Treat explicit user explanations as first-class evidence. Include durable user-provided knowledge when the user explained business context, domain semantics, product intent, repository policy, terminology, constraints, or rationale that is not already visible in repository files and should affect future work.
- Prefer lessons that change future behavior: what to inspect first, what assumption to avoid, which repository convention dominates, which abstraction boundary matters, or which verification evidence is required.
- Do not preserve arbitrary user chatter, temporary preferences, or private/personal details unless they materially affect the repository, product behavior, domain interpretation, or future engineering decisions.
- Prefer runbooks when the reusable value is an ordered procedure with a clear trigger, evidence to collect, stopping condition, and common traps.
- If the best candidate title would be "what we fixed today" or "the problem in this session", it is probably not a durable lesson. Generalize it or skip it.
- If generalization would remove the only useful content, report that nothing durable should be written.

Destination routing:
- Prefer existing repository-owned documentation only when the match is high-confidence, such as an existing troubleshooting document, runbook directory, ADR area, package-local README, established docs convention, guardrail configuration, or a vvoc-managed skill or agent template.
- Never invent a new docs directory or repository documentation convention when the repository does not already provide a high-confidence home.
- If destination ownership or format is ambiguous, propose the .vvoc fallback for knowledge and list plausible alternatives. Ask the user only when the fit is genuinely ambiguous.
- Existing repository docs keep their local format, even when that format is Markdown.
- Changes to a vvoc-managed skill or agent are proposed against the bundled template under templates/, never against an installed copy under a vvoc config root.
- Do not modify user-owned configuration or runtime source behavior. Route a change that needs runtime code or an architectural decision to vv-spec or vv-plan instead.

Fallback memory:
- .vvoc/lessons/lesson-&lt;topic-slug&gt;.xml and .vvoc/runbooks/runbook-&lt;topic-slug&gt;.xml are the entry files; .vvoc/lessons/index.xml and .vvoc/runbooks/index.xml are their indexes.
- Create fallback directories and indexes lazily only after an approved fallback write.
- Use one durable entry per file.
- The root tag, file stem, and index slug must match exactly, such as lesson-managed-skills-must-update-registration.
- If the slug already exists, propose either updating the existing entry for the same durable topic or creating a more specific new slug for a distinct topic. Never silently overwrite.
- After writing fallback memory, update the corresponding index in the same change.

Write rules:
- Write no files before explicit per-entry approval.
- If no durable findings remain after filtering, report that nothing should be written.
- If proposed content reads like a current-session recap, stop and rewrite it as generalized knowledge. If it cannot be generalized without losing the useful content, skip it.
- If approved content is malformed or materially vague, tighten it before writing. If tightening changes meaning, show the revised content and ask again.
- If the root tag, file stem, or index slug would not match, stop before writing and revise the proposal.
- For an environment change, preserve the target file's local structure, keep the diff minimal, and name any unrelated cleanup before doing it.
</rules>

<artifact>
Proposal fields:
category, severity, finding with evidence, proposed improvement or durable entry, durability or impact reason, future-use trigger, destination, why this destination, proposed content, alternatives if destination is ambiguous, collision handling if slug or file exists.

For an environment improvement, state the friction, the smallest change that removes it, and why the existing environment did not already prevent it.

Lesson schema:
<![CDATA[
<lesson-example-topic>
  <summary>Short scan-friendly generalized lesson, not a session recap.</summary>
  <description>Durable explanation of the transferable pattern, why it matters, and how it should change future agent behavior.</description>
  <context>Brief concrete context that produced the lesson; keep this as evidence, not the main content.</context>
  <applies-when>Signals that a future, similar-but-not-identical task should load this lesson.</applies-when>
  <avoid>Wrong assumptions, traps, or actions to avoid in that broader class of tasks.</avoid>
  <evidence>Commands, files, errors, traces, review findings, or observed behavior that support the lesson.</evidence>
</lesson-example-topic>
]]>

Runbook schema:
<![CDATA[
<runbook-example-topic>
  <summary>Short scan-friendly procedural purpose.</summary>
  <description>What this procedure is for and why it exists.</description>
  <when-to-use>Signals that this runbook applies.</when-to-use>
  <steps>Ordered diagnostic or fix workflow.</steps>
  <evidence-to-collect>What to inspect before changing code.</evidence-to-collect>
  <common-traps>Known false paths or mistakes.</common-traps>
  <related-lessons>Optional related lesson slugs or paths.</related-lessons>
</runbook-example-topic>
]]>

Lesson index schema:
<![CDATA[
<vvoc-lessons-index>
  <entry>
    <slug>lesson-example-topic</slug>
    <path>.vvoc/lessons/lesson-example-topic.xml</path>
    <summary>Short scan-friendly summary.</summary>
    <applies-when>Signals that this lesson is relevant.</applies-when>
  </entry>
</vvoc-lessons-index>
]]>

Runbook index schema:
<![CDATA[
<vvoc-runbooks-index>
  <entry>
    <slug>runbook-example-topic</slug>
    <path>.vvoc/runbooks/runbook-example-topic.xml</path>
    <summary>Short scan-friendly procedural purpose.</summary>
    <when-to-use>Signals that this runbook applies.</when-to-use>
  </entry>
</vvoc-runbooks-index>
]]>
</artifact>

<refs>
- `references/session-graph.py` — run with `--archive` when the question spans more than one session or project; read-only extractor over the recorded session graph.
</refs>

<done>
Every reflected proposal is presented, and each one is approved and applied, rejected, or deferred with a stated reason.

Stop when the reflector's report has been handled; do not expand into unrelated improvements or a general repository audit. When blocked, report the missing evidence or decision, what was gathered, and the smallest next action. When ambiguity materially changes the destination or result, ask one focused question; otherwise choose the narrowest reasonable destination, state it, and continue.
</done>
