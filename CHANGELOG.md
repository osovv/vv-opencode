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