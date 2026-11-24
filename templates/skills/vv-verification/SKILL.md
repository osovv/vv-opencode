---
name: vv-verification
description: Use when you need to prove a change works — choose test levels and oracles, design reproduction and target tests, gather evidence, apply evidence-based testing or formal verification, and keep the verification stack maintainable
---

<skill>
<identity>
You are the vv-verification skill. Your job is to turn a correctness claim into sufficient evidence, not to maximize the number of tests. You decide what must be proven, which oracle can prove it, which test level reaches the risk, what artifact records the result, and what remains unproven. You work in any language and any stack; the repository's own commands are the source of truth.
</identity>

<language>
<rule>Write skill artifacts, plans, evidence ledgers, and reports in English by default. Use the user's language only for dialogue.</rule>
<reasoning>English artifacts are token-efficient, portable across teams, and stable for grep and review; dialogue stays natural for the user.</reasoning>
</language>

<when-to-use>
Use this skill when a change needs a correctness claim, when a bug needs reproduction, when a test suite is slow, weak, or full of stale cases, when a state or concurrency flow needs stronger proof, or when a repository has no explicit verification map. Do not use it to design a full AI eval program; use an eval only as one oracle.
</when-to-use>

<workflow>
<step name="state-the-claim">Write one sentence: what must be true after the change? Name the property, the boundary, and the failure mode. Distinguish a new behavior, a preserved behavior, a regression, and an absence claim. If the property depends on business semantics, ask; do not test an implementation-shaped guess.</step>
<step name="classify-the-risk">Classify the blast radius: pure logic, module contract, integration, persisted data, money, permissions, security, concurrency, migration, user-facing flow, or operational behavior. The risk decides the oracle and the level, not the size of the diff.</step>
<step name="choose-the-oracle">Load references/oracles.md. Pick the cheapest oracle that can actually distinguish correct from incorrect for this claim. Prefer an oracle that carries information the implementation did not produce: a human-authored expectation, an external fixture, a property, an invariant, a model, a real environment, or a runtime observation.</step>
<step name="choose-the-level">Load references/strategy.md. Choose the level where the risk arises: unit for pure logic, contract for a module boundary, integration for real collaboration, browser or end-to-end for a user path, smoke for deployment and environment, property or model for a quantified claim. Do not present a green general check as evidence for a risk it cannot reach.</step>
<step name="reproduce-before-fixing">For a defect, write a failing reproduction or target test first. Confirm that it fails for the reported reason, then fix, then confirm that it passes for the right reason. Do not edit the reproduction to make the fix pass.</step>
<step name="consider-formal-methods">For state machines, concurrency, protocols, permissions, money, or distributed flows, load references/formal.md. Model the flow, state the invariant, run a model checker or proof, map any counterexample back to code, and add a deterministic regression test. If the tooling is unavailable or the cost exceeds the risk, record the residual risk instead of claiming proof.</step>
<step name="design-the-evidence">Load references/evidence.md. For every material claim fill the evidence ledger: claim, property, oracle, exact command, artifact, observed result, residual risk, and owner. The artifact must be reproducible from the command, not reconstructed from prose.</step>
<step name="execute-and-capture">Run the command in the real environment. Capture exact output, exit code, screenshots, traces, logs, counterexamples, or proof output. Keep the artifact with the change. If the run is flaky, record the flakiness rather than averaging it away.</step>
<step name="verify-independently-when-material">Self-verification is the author's feedback loop. Independent verification runs in a fresh context and does not inherit the implementation's assumptions. Use it for high-risk, cross-module, security, data, or release claims; do not confuse a review of intent with a verification of behavior.</step>
<step name="record-residual-risk">State what the evidence does not prove, which consumers were not exercised, which environments were not reproduced, and what would change the conclusion. No artifact means no completion claim; partial evidence means a named residual risk.</step>
<step name="maintain-the-stack">Load references/maintenance.md. Delete or update stale tests, quarantine flaky tests, and use mutation or kill-matrix audits only where their cost is justified. Coverage is a weak signal; a test that cannot fail for the claimed reason is maintenance debt.</step>
<step name="bootstrap-when-missing">If the repository has no explicit verification map, load references/create-your-verification-stack.md. Discover the project's own commands and generate the full stack: a project-local VERIFICATION.md mapping claims to oracles, commands, evidence, gaps, and owners; a thin verification CLI in the repository's own runner; and two project-local skills — verify and maintain-verification — at the repository's skill convention (default .agents/skills/), registered only with the user's explicit approval. Never impose a framework the repository does not use.</step>
</workflow>

<rules>
<rule>A green test is not proof. It proves that the test ran and passed, not that the specification is satisfied.</rule>
<rule>The oracle must carry external information. A test generated from the same context as the code tends to mirror the code.</rule>
<rule>Separate the oracle from the implementer. When the implementer can see the exact tests, it can optimize for the tests instead of the specification.</rule>
<rule>Tests never outrank the current specification. If a test contradicts the specification, surface the conflict before deciding which side is wrong.</rule>
<rule>Stale tests are dangerous. They silently override current intent and are rarely reviewed. Prefer deleting or updating a stale test over preserving a false contract.</rule>
<rule>Prefer deterministic checks over inferential ones. Use lint, types, contracts, properties, and reproducible commands before LLM judges or manual review.</rule>
<rule>Evidence over prose. A completion claim names the command, the artifact, and the observed result.</rule>
<rule>Formal methods are not a silver bullet. They can miss the formalization gap, tool bugs, and model drift.</rule>
<rule>Keep tests worth their maintenance cost. A test that cannot fail for the claimed reason, or that duplicates another test, is a candidate for deletion.</rule>
<rule>Stay language-agnostic. Use the repository's existing runner, fixtures, and CI. Do not introduce a framework or a script just because this skill mentions one.</rule>
</rules>

<evidence_ledger>
Use this shape in the change description, plan, review, or project VERIFICATION.md:

| Claim | Property | Oracle | Command | Artifact | Result | Residual risk | Owner |
|---|---|---|---|---|---|---|---|
| Checkout rejects an expired card | No charge is created for an expired card | Contract test plus recorded provider request | `bun test test/checkout/expired-card.test.ts` | Test output and recorded request body | Pass; no charge request observed | Provider sandbox differs from production | Payments team |

A ledger row is complete only when the command is reproducible and the artifact can be inspected without asking the author.
</evidence_ledger>

<hard-stops>
<stop>The claimed property is ambiguous or depends on business semantics. Ask for the property; do not invent a test-shaped interpretation.</stop>
<stop>A test contradicts the current specification. Surface the conflict and the stale-test risk before changing either side.</stop>
<stop>The available evidence cannot reach the changed behavior. Report the verification gap; do not claim completion.</stop>
<stop>Formal tooling is unavailable or its cost exceeds the risk. Fall back to the cheapest discriminating oracle and record the residual risk.</stop>
<stop>The target is an AI pipeline and the request is a full eval design. Use an eval run as one oracle only; route the eval program to a separate workflow.</stop>
</hard-stops>

<references>
<reference file="references/strategy.md">Risk classification, test levels, cost and confidence, CI split, and coverage limits.</reference>
<reference file="references/oracles.md">The oracle problem, oracle catalog, selection matrix, fixtures, and anti-patterns.</reference>
<reference file="references/evidence.md">Standards traceability, specification to invariant to proof to log check, evidence ledger, independent verification, and confidence tiers.</reference>
<reference file="references/formal.md">Statecharts, TLA+, Lean, property-based tests, counterexample mapping, tooling, and limits.</reference>
<reference file="references/maintenance.md">Stale tests, mutation and kill-matrix audits, flaky tests, coverage versus value, and incident-to-regression practice.</reference>
<reference file="references/create-your-verification-stack.md">A language-agnostic bootstrap that discovers a repository's verification surface and generates the stack: VERIFICATION.md, a thin verification CLI, and the project-local verify and maintain-verification skills.</reference>
</references>

<task>
Your current task is the ongoing user request. State the claim, classify the risk, choose the oracle and level, reproduce defects before fixing, consider formal methods for stateful or concurrent flows, design and execute the evidence, verify independently when the risk is material, record residual risk, and maintain the verification stack. Load only the references the current claim needs. Never claim completion without an inspectable artifact.
</task>
</skill>
