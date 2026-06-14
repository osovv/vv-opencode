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