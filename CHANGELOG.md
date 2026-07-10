## <small>1.0.2 (2026-07-10)</small>

### Summary

This release fixes the fast role alias in the built-in osovv presets by replacing the unavailable GPT-5.6 Luna Low model with GPT-5.4 Mini Low, restoring functionality for users relying on that role assignment without affecting the Terra and Sol models.

* fix(models): use GPT-5.4 mini for fast role ([5068545](https://github.com/osovv/vv-opencode/commit/5068545))

## <small>1.0.1 (2026-07-10)</small>

### Summary

The osovv presets in `vvoc patch-provider` now replace the deprecated StepFun model with GPT-5.6 aliases (Luna Low, Terra High, Sol XHigh), delivering consistently higher throughput for the explore subagent after StepFun performance degraded from over 150 TPS to approximately 25 TPS. The `vv-osovv` and `vv-osovv-cheap` preset role assignments are updated to use these new fast and smart models, and the `patch-provider openai` preset now includes all three GPT-5.6 variants alongside the existing GPT-5.4 and GPT-5.5 aliases, ensuring users get reliable performance without manual reconfiguration.

* feat(models): adopt GPT-5.6 in osovv presets ([fd36444](https://github.com/osovv/vv-opencode/commit/fd36444))

## 1.0.0 (2026-07-03)

### Summary

vv-opencode reaches version 1.0, establishing a daily-driver baseline for the curated OpenCode workflow. The release formalizes a stability posture where setup commands, managed skill names, public package exports, schema v3, and the spec artifact layout are treated as compatibility surfaces, meaning breaking changes to these areas will be explicitly documented in future release notes. User-owned config is never silently clobbered, and invalid config continues to fail loudly. This marks the transition from iterative development to a practical, documented baseline for real project use.

* docs: declare 1.0 stability posture ([8a3e590](https://github.com/osovv/vv-opencode/commit/8a3e590))

## <small>0.35.33 (2026-06-26)</small>

### Summary

This release removes the harmful RTK (rtk-ai/rtk) recommendation from the interactive `vvoc init` outro and the README, because RTK proxies developer commands and distorts their output shape, causing automated sessions to receive unexpected responses and work around RTK instead of completing the intended work. Users will now see a clean init success message and no longer be directed to install a proxy that interferes with standard command output.

* fix(init): drop harmful RTK recommendation that distorted command output ([cd5c12a](https://github.com/osovv/vv-opencode/commit/cd5c12a))

## <small>0.35.32 (2026-06-26)</small>

### Summary

Workflow result preservation is now implemented: when a tracked subagent returns BLOCKED or NEEDS_CONTEXT, the controller receives the actual explanation in the error and can inspect it later through work_item_list, significantly improving recovery after hard stops. Protocol parsing now extracts the freeform result body after the required blank line, and if a subagent forgets that blank line, the error provides an actionable diagnostic with a corrected format example instead of a confusing generic message. The repair system also gains missing-blank-line guidance, increasing the chance of automatic format recovery without changing the subagent's outcome. All excerpts are bounded and explicitly truncated to prevent unbounded storage in persisted workflow state.

* docs(grace): add workflow result preservation spec and plan ([c4f05fa](https://github.com/osovv/vv-opencode/commit/c4f05fa))
* docs(grace): archive workflow result preservation change ([6efdc37](https://github.com/osovv/vv-opencode/commit/6efdc37))
* feat(workflow): preserve tracked result context ([078e926](https://github.com/osovv/vv-opencode/commit/078e926))

## <small>0.35.31 (2026-06-25)</small>

### Summary

This release adds the `vv-handoff` managed skill, a lightweight end-of-session tool that writes a project-local XML handoff note from already-visible session context—recording the original request, completed work, current state and decisions, important files, known command results, blockers, and the next safe step—without running shell commands or collecting fresh evidence, and with automatic secret redaction and collision-safe directory naming. The `vv-spec` skill documentation was also clarified to ensure spec package date prefixes remain date-only, excluding any time or timezone components.

* docs(grace): add vv-handoff skill spec and plan ([490c96e](https://github.com/osovv/vv-opencode/commit/490c96e))
* docs(vv-spec): clarify date-only spec package prefix ([cba76f5](https://github.com/osovv/vv-opencode/commit/cba76f5))
* feat(skills): add vv-handoff managed skill ([a386c5a](https://github.com/osovv/vv-opencode/commit/a386c5a))

## <small>0.35.30 (2026-06-24)</small>

### Summary

Spec packages created by the vv-spec skill now use date-prefixed directory names (YYYY-MM-DD-slug) so active packages sort by creation date and are easier to identify, with corresponding updates to the vv-spec, vv-plan, and vv-controller skill and agent templates. The project documentation has been fully migrated to the GRACE 4 artifact model, replacing legacy XML sources under docs/ with the current .grace/ directory structure, and all GRACE context artifacts—requirements, technology, principles, deployment, and UX guidelines—have been refined for clarity and accuracy. Legacy GRACE 3 XML documents and superseded workflow plan handoff notes have been removed, and stale migration references have been cleaned up from graph and verification indexes.

* feat(vv-spec): date-prefix spec packages ([0dba659](https://github.com/osovv/vv-opencode/commit/0dba659))
* docs: drop migration report artifact ([327812d](https://github.com/osovv/vv-opencode/commit/327812d))
* docs: finalize GRACE migration cleanup ([496236f](https://github.com/osovv/vv-opencode/commit/496236f))
* docs: migrate project to GRACE 4 ([ba3e162](https://github.com/osovv/vv-opencode/commit/ba3e162))
* docs: refine GRACE context requirements ([73245b1](https://github.com/osovv/vv-opencode/commit/73245b1))
* docs: refine GRACE deployment context ([cd2da0f](https://github.com/osovv/vv-opencode/commit/cd2da0f))
* docs: refine GRACE principles context ([ad1b050](https://github.com/osovv/vv-opencode/commit/ad1b050))
* docs: refine GRACE technology context ([eeff4d2](https://github.com/osovv/vv-opencode/commit/eeff4d2))
* docs: refine GRACE UX guidelines ([09d075a](https://github.com/osovv/vv-opencode/commit/09d075a))
* docs: remove legacy GRACE 3 artifacts ([c9b910d](https://github.com/osovv/vv-opencode/commit/c9b910d))
* docs: remove stale GRACE migration references ([6ad640a](https://github.com/osovv/vv-opencode/commit/6ad640a))

## <small>0.35.29 (2026-06-22)</small>

### Summary

This release adds the `vv-osovv-cheap` preset, which provides a more cost-effective set of model role assignments by combining deepseek, stepfun, minimax, and zai models, and updates the project documentation to clarify vvoc's role as a curated, opinionated plugin set that adds a structured spec-to-code process layer for safer, more portable agentic development—including formalized trajectories, review-driven execution, and long-run safety features.

* feat(preset): add vv-osovv-cheap preset with zai smart and deepseek reviewer ([dfe1efe](https://github.com/osovv/vv-opencode/commit/dfe1efe))
* docs: clarify vvoc process positioning ([3d78927](https://github.com/osovv/vv-opencode/commit/3d78927))
* docs: explain plugin user benefits ([baf716b](https://github.com/osovv/vv-opencode/commit/baf716b))
* docs: update project positioning ([7af2865](https://github.com/osovv/vv-opencode/commit/7af2865))

## <small>0.35.28 (2026-06-21)</small>

### Summary

This release completes the strict cutover from legacy behavior: vvoc config parsing now rigidly enforces canonical schema v3 with the `plugins` section as required, rejecting old, incomplete, or malformed `vvoc.json` files instead of silently migrating or repairing them; `vvoc status` and `vvoc doctor` report parse errors without mutating the file, and `vvoc upgrade` treats a failed post-install sync as a reported partial upgrade requiring manual config fix. Runtime compatibility fallbacks have been removed — Guardian permission replies use only the current OpenCode permission API or HTTP reply, Hashline edit anchors accept only current hashing algorithms, and `vvoc sync` no longer deletes old managed-agent names or managed command entries, leaving them untouched while writing current registrations. Users with existing v1/v2 configs must manually update to schema v3 before any sync, install, or plugin runtime will proceed.

* feat(preset): add vv-osovv-cheap preset with zai smart and deepseek reviewer ([c2b7fb0](https://github.com/osovv/vv-opencode/commit/c2b7fb0))
* docs: complete launch polish pass ([b026a79](https://github.com/osovv/vv-opencode/commit/b026a79))
* docs: document strict legacy cutover ([cf99ccf](https://github.com/osovv/vv-opencode/commit/cf99ccf))
* feat(config): enforce strict vvoc config parsing ([299a398](https://github.com/osovv/vv-opencode/commit/299a398))
* feat(upgrade): report partial sync failures ([fad286c](https://github.com/osovv/vv-opencode/commit/fad286c))
* refactor(runtime): remove legacy compatibility fallbacks ([7517d0d](https://github.com/osovv/vv-opencode/commit/7517d0d))

## <small>0.35.27 (2026-06-20)</small>

### Summary

Runtime plugins now load the effective vvoc configuration once during startup and share an immutable snapshot for the lifetime of the process, replacing the previous pattern where each plugin independently discovered and loaded the config. This internal refactor ensures all plugins see the same configuration values, eliminates redundant filesystem reads, and makes plugin toggle checks a pure operation on the already-loaded config object. Users should restart OpenCode after changing <code>vvoc.json</code> — there is no live reload — but otherwise no behavioral changes are expected; this change primarily improves consistency and startup efficiency across Guardian, Hashline Edit, Model Roles, Secrets Redaction, System Context Injection, and Workflow plugins.

* refactor(config): load vvoc runtime config once ([04e414e](https://github.com/osovv/vv-opencode/commit/04e414e))

## <small>0.35.26 (2026-06-19)</small>

### Summary

This release memoizes config resolution to eliminate a 5–10 second startup delay on slow filesystems, and introduces explicit intent review rounds in the WorkflowPlugin, giving users deterministic control over implementation and review-only pipelines—work items now require a <code>mode</code> and <code>requiredReviewers</code> set, reviewers launch in parallel with collect-all round aggregation, and review-only failures are treated as completed findings rather than routing back to the implementer. It also restores the OpenAI patch‑preset context limit to 1.05M after a brief compliance adjustment.

* chore: bump version from 0.35.24 to 0.35.25 with changelog ([70854dc](https://github.com/osovv/vv-opencode/commit/70854dc))
* perf(config): memoize loadEffectiveVvocConfigForRuntime to fix startup regression ([a83c73c](https://github.com/osovv/vv-opencode/commit/a83c73c))

## <small>0.35.25 (2026-06-19)</small>

### Summary

This release introduces explicit intent review rounds to the WorkflowPlugin, giving users deterministic control over implementation and review-only pipelines—work items now require a `mode` and `requiredReviewers` set, reviewers launch in parallel with collect-all round aggregation, and review-only failures are treated as completed findings rather than routing back to the implementer. It also memoizes config resolution to eliminate a 5–10 second startup regression on slow filesystems, and restores the OpenAI patch-preset context limit to 1.05M after a brief compliance adjustment.

* perf(config): memoize loadEffectiveVvocConfigForRuntime to fix startup regression ([6ef4f4e](https://github.com/osovv/vv-opencode/commit/6ef4f4e))
* fix: restore 1.05M openai patch-preset limits ([9d5df8a](https://github.com/osovv/vv-opencode/commit/9d5df8a))
* fix: set openai patch-preset context to 400K for ChatGPT Pro plan compliance ([0177f03](https://github.com/osovv/vv-opencode/commit/0177f03))
* fix: use 400K context limit for openai patch-preset (ChatGPT Pro plan) ([84c6029](https://github.com/osovv/vv-opencode/commit/84c6029))
* feat(workflow): add explicit intent review rounds ([f02e784](https://github.com/osovv/vv-opencode/commit/f02e784))

## <small>0.35.24 (2026-06-18)</small>

### Summary

This release restores the 1.05M context limit for the openai patch-preset after a brief adjustment to 400K for ChatGPT Pro plan compliance, and introduces explicit intent review rounds to the WorkflowPlugin: work items now require `mode` (implementation or review_only) and `requiredReviewers` (spec, code, or both), reviewers are launched and tracked in parallel, results are collected into a full review round before deciding the next lifecycle state, and review-only mode treats reviewer FAIL as a completed finding without routing to the implementer—giving users more deterministic and flexible pipeline control.

* fix: restore 1.05M openai patch-preset limits ([9d5df8a](https://github.com/osovv/vv-opencode/commit/9d5df8a))
* fix: set openai patch-preset context to 400K for ChatGPT Pro plan compliance ([0177f03](https://github.com/osovv/vv-opencode/commit/0177f03))
* fix: use 400K context limit for openai patch-preset (ChatGPT Pro plan) ([84c6029](https://github.com/osovv/vv-opencode/commit/84c6029))
* feat(workflow): add explicit intent review rounds ([f02e784](https://github.com/osovv/vv-opencode/commit/f02e784))

## <small>0.35.23 (2026-06-18)</small>

### Summary

This release improves compatibility and model configuration by adding explicit 1.05M context and 128k output limits to OpenAI patch-preset models (GPT-5.4 and GPT-5.5), ensuring those models operate at their intended capacity, and by switching the sync, read, and guardian config paths to use lenient config parsing so that older 4-role configurations without the reviewer role are gracefully upgraded with defaults instead of causing errors. This prevents upgrade breakage for users with legacy configs and ensures the new reviewer role is automatically populated.

* fix: add 1.05M context / 128k output limits to openai patch-preset models ([8c5b48c](https://github.com/osovv/vv-opencode/commit/8c5b48c))
* fix: use lenient config parsing in sync/read paths to handle old 4-role configs ([ae11b70](https://github.com/osovv/vv-opencode/commit/ae11b70))

## <small>0.35.22 (2026-06-18)</small>

### Summary

This release removes the orchestrator role, simplifying the built-in role system to five roles with a clean smart and reviewer split. The vv-controller agent has been re-bound to the smart role, and all built-in presets have been updated to drop the orchestrator entry. Additionally, the vv-zai preset now correctly assigns the GLM-5.1 model to the reviewer role and the GLM-5-turbo model to the orchestrator role before its removal, ensuring proper review model selection. This reduces configuration complexity and clarifies the separation between primary smart agents and dedicated reviewers.

* refactor: remove orchestrator role, keep only smart + reviewer split ([86779bd](https://github.com/osovv/vv-opencode/commit/86779bd))
* fix: swap zai reviewer/orchestrator models — glm-5.1 for review, glm-5-turbo for orchestration ([877a57b](https://github.com/osovv/vv-opencode/commit/877a57b))
* feat: add reviewer and orchestrator roles, split smart role bindings ([42baa72](https://github.com/osovv/vv-opencode/commit/42baa72))

## <small>0.35.21 (2026-06-16)</small>

### Summary

This maintenance release removes the dead `.vvoc/plans/` directory path and stale `vv-analyst` and `vv-architect` agent references, as planning artifacts now live exclusively under the `.vvoc/specs/<id>/` layout. The GRACE documentation (development plan, verification plan, knowledge graph, and requirements) has been updated to reflect the current architecture, and several module contracts, maps, and change summaries have been corrected or added. These changes reduce code surface, eliminate confusion from outdated references, and ensure that project documentation accurately describes the managed skills and spec-driven planning flow.

* chore: refresh GRACE artifacts after full integrity scan ([e0df404](https://github.com/osovv/vv-opencode/commit/e0df404))
* refactor: remove dead .vvoc/plans/ code path and stale vv-analyst/vv-architect references ([f4076e1](https://github.com/osovv/vv-opencode/commit/f4076e1))

## <small>0.35.20 (2026-06-16)</small>

### Summary

This release introduces layered project-scope configuration, allowing users to isolate vv-opencode setup to individual projects with `vvoc install --scope project`, while the new `vvoc launch` command launches OpenCode with deterministic config sources for sandboxed testing. Complex spec sessions now support an optional `design-context.xml` companion that preserves decision rationale and rejected alternatives for planners and reviewers without expanding the normative spec, and the skill sync system gains config-safety rules that prevent silent overwrites of user-owned reference files. Documentation and templates have been cleaned up by removing stale references to legacy sub-agents and folder layouts, consolidating the spec package directory as the canonical organizational unit and making the user-facing workflow documentation more accurate.

* docs: remove legacy folder references from docs and templates ([10879d4](https://github.com/osovv/vv-opencode/commit/10879d4))
* docs: remove stale vv-analyst/vv-architect references ([30e9bab](https://github.com/osovv/vv-opencode/commit/30e9bab))
* feat(config): support layered project scope ([beaaa4b](https://github.com/osovv/vv-opencode/commit/beaaa4b))
* feat(skills): add spec package design context ([5181cdf](https://github.com/osovv/vv-opencode/commit/5181cdf))

## <small>0.35.19 (2026-06-15)</small>

### Summary

The vv-reflect skill now synthesizes generalized lessons and reusable procedures instead of session recaps, capturing durable domain knowledge, business context, and product intent so that future agents can apply insights to similar-but-not-identical tasks rather than replaying what happened in a single session.

* feat(skills): improve vv-reflect lesson synthesis ([d458c15](https://github.com/osovv/vv-opencode/commit/d458c15))

## <small>0.35.18 (2026-06-15)</small>

### Summary

Updated the vv-osovv preset's smart agent to use `openai/vv-gpt-5.5-xhigh`, replacing the previous DeepSeek-based model, to deliver higher-quality responses for complex reasoning tasks while continuing to use existing fast, vision, and default agents for other workloads.

* feat(preset): update vv-osovv smart model to openai/vv-gpt-5.5-xhigh ([89752e2](https://github.com/osovv/vv-opencode/commit/89752e2))

## <small>0.35.17 (2026-06-14)</small>

### Summary

This release improves the accuracy of automatically generated changelog summaries by feeding the full textual diff of each commit into the summary generation prompt, so the model can ground its output in the actual file changes rather than relying solely on commit titles and metadata. This means release notes are now more faithful to what was really modified, reducing the risk of invented or misleading descriptions in the changelog.

* fix(release): include commit diffs in summaries ([f1c930c](https://github.com/osovv/vv-opencode/commit/f1c930c))

## <small>0.35.16 (2026-06-14)</small>

### Summary

This release introduces lifecycle statuses for skills specs and plans, giving users clearer visibility into the state of their skill workflows—whether a spec is being drafted, reviewed, or finalized, and whether a plan is in progress, completed, or blocked—making it easier to track progress and identify next steps in skills-based automation.

* feat(skills): add spec and plan lifecycle statuses ([5c7c095](https://github.com/osovv/vv-opencode/commit/5c7c095))
* chore: add typecheck to lefthook pre-commit ([cca0f03](https://github.com/osovv/vv-opencode/commit/cca0f03))

## <small>0.35.15 (2026-06-14)</small>

### Summary

This release fixes a test issue by adding a missing `id` field to an inline type in the patch-provider test, ensuring test accuracy and preventing potential false failures during validation.

* fix: add missing id field to inline type in patch-provider test ([6f6e33c](https://github.com/osovv/vv-opencode/commit/6f6e33c))

## <small>0.35.14 (2026-06-14)</small>

### Summary

This release adds the `reasoning: true` flag to the `vv-gpt-5.4-xhigh` and `vv-gpt-5.5-xhigh` OpenAI model configurations in the provider patch, enabling reasoning capabilities for these high-capacity models and ensuring consistent behavior with other models in the lineup.

* fix(patch-provider): add reasoning:true to vv-gpt-5.4-xhigh and vv-gpt-5.5-xhigh openai models ([88975ec](https://github.com/osovv/vv-opencode/commit/88975ec))

## <small>0.35.13 (2026-06-14)</small>

### Summary

This release introduces interview UX guardrails to the vv-spec module, adding a roadmap preview, per-section progress markers, honest depth estimates that expand rather than limit context, and a standardized question-card format with per-section recap. These changes make decision-tree walks more transparent and predictable while ensuring critical forks are never skipped. Additionally, the project metadata is polished with an MIT LICENSE, live CI/coverage badges, and aligned repository topics for improved discoverability.

* feat(vv-spec): add interview UX guardrails — roadmap, progress, depth estimate, recap ([d05aef9](https://github.com/osovv/vv-opencode/commit/d05aef9))
* docs: polish repo metadata, add LICENSE, live badges, and aligned topics ([4fbe4e7](https://github.com/osovv/vv-opencode/commit/4fbe4e7))

## <small>0.35.12 (2026-06-13)</small>

### Summary

This release introduces an inline execution mode choice for the vv-execute plugin, giving you more control over how commands are launched. The release process now automatically generates a changelog summary for each version, ensuring every release includes a clear, user-friendly overview of changes. Additionally, several fixes improve the reliability of summary generation, including support for single-line summary envelopes and corrected configuration handling.

* fix(release): accept single-line summary envelopes ([f2b7b93](https://github.com/osovv/vv-opencode/commit/f2b7b93))
* fix(release): use valid opencode summary config ([9b8b38d](https://github.com/osovv/vv-opencode/commit/9b8b38d))
* feat(release): add mandatory AI-generated release changelog summary ([592615d](https://github.com/osovv/vv-opencode/commit/592615d))
* feat(vv-execute): add inline execution mode choice ([4822a7a](https://github.com/osovv/vv-opencode/commit/4822a7a))

## <small>0.35.11 (2026-06-13)</small>

### Summary

This release makes the release and upgrade path easier to trust by tightening changelog validation and improving compatibility with generated conventional-changelog output. Users get clearer upgrade notes backed by GitHub Releases and jsDelivr, while maintainers get stronger automated checks around the artifacts that ship each release.

* fix(release): make changelog patterns compatible with conventional-changelog format ([582c2f4](https://github.com/osovv/vv-opencode/commit/582c2f4))
* test(upgrade): add multi-version changelog, graceful degradation, and prerelease tests ([3f634db](https://github.com/osovv/vv-opencode/commit/3f634db))
* feat(release): add CHANGELOG.md validation to release-check ([2e37a77](https://github.com/osovv/vv-opencode/commit/2e37a77))
* feat(release): add GitHub Releases and jsDelivr-based changelog for vvoc upgrade ([e0f9863](https://github.com/osovv/vv-opencode/commit/e0f9863))
* feat(release): integrate changelog generation into release-bump ([b90a079](https://github.com/osovv/vv-opencode/commit/b90a079))
* chore(config): add changelog and commitlint configuration ([88dc806](https://github.com/osovv/vv-opencode/commit/88dc806))
* chore(config): add commitlint commit-msg hook ([888abf1](https://github.com/osovv/vv-opencode/commit/888abf1))