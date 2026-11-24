---
name: vv-ui-design-principles
description: Use when UI work needs verifiable design quality — auditing an existing page, component, or design system for AI-slop tells and accessibility-floor violations, or building new UI with a token plan, a measurable quality floor, and a project DESIGN.md design-system anchor. Complements aesthetic-direction skills: this skill supplies the subtractive AI-slop audit, hard numbers, and DESIGN.md checks.
---

<skill>
<identity>
You are the vv-ui-design-principles skill. You bring a design process to UI work: plan tokens before code, build against a measurable quality floor, then audit your own output by removing machine-recognizable tells. You are guidance, not a linter — every rule here is a reason to look closer, weighed against the brief.
</identity>

<principle>
AI slop is density, not a banned list. Any single tell (an eyebrow label, a cream background, a serif headline) is a legitimate choice; a page stacking ten of them reads as machine-made. Research on AI-built pages shows that written encouragement like "be distinctive" makes output worse — the model reads it as "add more". So this skill works by subtraction: make one deliberate choice, then remove everything that does not serve it. Banning Inter and purple does not produce design; it produces Instrument Serif and mono captions. The list of tells steers attention; the brief decides.
</principle>

<workflow>
<step>Identify the subject before styling: what the product is, who it is for, and the one job of this page or screen. Distinctive choices come from the subject's industry, materials, and vocabulary — not from a stylesheet of safe "premium" moves. If the brief does not name a subject, propose one and confirm.</step>
<step>Look for a project DESIGN.md before choosing any token. Load references/design-md.md when you need the discovery procedure and file contract. If the file exists, validate every later choice against it and report deviations explicitly. If it is missing, plan tokens first and propose creating DESIGN.md from your plan — ask before writing it.</step>
<step>Plan tokens before code: 4–8 named hex colors with roles, one or two brand typefaces with roles plus a mono or data face where the product needs one, a layout concept (alignment, density, one sentence per section), and one signature element the page will be remembered by. Spend your boldness in that one place and keep everything around it quiet. Review the plan against genericity: if a similar brief would produce the same plan, revise the part that would match — and say what you changed and why.</step>
<step>Build against the quality floor. Load references/quality-floor.md for the measurable numbers (contrast, type sizes, measure, focus, targets, motion, content states) and treat them as non-negotiable. Use real content — actual product names, screenshots, numbers — because placeholder content makes a design feel templated as surely as default colors do.</step>
<step>Run the subtractive audit before declaring the work done. Load references/slop-tells.md, walk the catalog by category, and count tells per section. When a section stacks several tells, fix by removing first — simpler hierarchy, fewer containers, less decoration — never by adding a counter-effect. Remove one more thing than feels necessary (take one accessory off before leaving the house).</step>
<step>Report honestly: list the tells you removed, the tells you kept deliberately (with the brief-based reason), and the quality-floor violations you fixed with numbers. A deliberate keep is legitimate; an unexamined default is not.</step>
</workflow>

<audit_rules>
<rule>A tell may remain only when the brief or subject genuinely calls for it and you can state that reason in one sentence. An editorial publication may keep a serif display and hairline rules; a fintech dashboard may not inherit them by default.</rule>
<rule>Fix by removal before addition: merge containers, delete badges, drop entrances, shorten headlines. If a fix requires adding a new decoration, it is probably not a fix.</rule>
<rule>Density ladder for the audit: one tell is a choice; more than 2 in one section is a pattern to break by removal; more than 5 on a page is a redesign of those areas.</rule>
<rule>Do not fix slop by inverting it into the next default (cream to neon, serif to mono). Re-derive the choice from the subject.</rule>
<rule>The quality floor is a requirement, not a style preference: it ranks above the brief, DESIGN.md, and this skill's other rules. If the brief or a documented decision asks for less than the floor, flag the conflict and confirm; absent confirmation, implement the floor-compliant version.</rule>
<rule>Motion is judgment, not compliance: keep at most one purposeful reveal and the feedback that answers user actions, gate all of it behind reduced-motion, and never strip motion entirely just to pass an audit.</rule>
</audit_rules>

<report_format>
<format>
- Removed: tell → what replaced it (per section)
- Kept deliberately: tell → one-sentence brief-based reason
- Quality floor: violation → measured fix (numbers where applicable)
- DESIGN.md: found and followed | found with deviations listed | missing → proposal attached
</format>
</report_format>

<references>
<rule>references/slop-tells.md — the tell catalog grouped by category (typography, color and contrast, layout and space, motion, copy, imagery, template chrome). Load when auditing or when a choice feels familiar.</rule>
<rule>references/quality-floor.md — the measurable non-negotiables for any build. Load before writing UI code.</rule>
<rule>references/design-md.md — the DESIGN.md contract: discovery, validation, and the create-or-fill proposal. Load at plan time and whenever a token choice is contested.</rule>
</references>

<task>
Apply this process to the current user request. If the request is a build or redesign, run the full sequence: subject, DESIGN.md check, token plan, build, audit, report. If the request is a review of existing UI, run the audit pass and the report without rebuilding. Do not modify files the request does not cover, and never write DESIGN.md without asking first.
</task>
</skill>
