## <small>1.3.6-rc.4 (2026-08-26)</small>

### Summary

This release improves edit reliability by routing edit cohorts to the host's built-in edit tool. The hashline-edit plugin no longer registers its own `edit` tool or replace engine, so qwen, kimi, and glm sessions now edit through OpenCode's native matching layers, prior-read enforcement, and unified diff output instead of the shadowing replace profile that caused duplicated lines and false "not read/drifted" rejections. Routing now uses native tool names (`apply_patch | edit | str_replace_editor | hashline_edit`), with deepseek mapped to `str_replace_editor`, gpt/codex to `apply_patch`, and unmatched models to `hashline_edit`; each session exposes exactly one edit tool, the removed `replace`/`passthrough` values are rejected loudly, and the vvoc.json schema and README are updated to match.

* feat(hashline-edit): route edit cohorts to the host built-in edit ([d6bdc2f](https://github.com/osovv/vv-opencode/commit/d6bdc2f))

## <small>1.3.6-rc.3 (2026-08-25)</small>

### Summary

The peak-hours cost-gating plugin now defaults to soft mode, so by default a message to a provider inside a peak-pricing window still goes through with a one-line cost notice and the orange TUI banner, with per-provider `mode` overrides and a top-level `"mode": "hard"` available for users who want stricter enforcement. When hard mode is enabled, blocking now occurs in `chat.params` after the user message has been persisted, which means blocked messages remain visible in session history and the rejection renders as a standard message error part naming the provider, window end, wait time, and off-peak provider suggestions instead of being dropped with a transient toast. This makes peak-hour enforcement less disruptive by default and prevents message loss when strict blocking is configured.

* fix(peak-hours): default to soft mode and block in chat.params so messages persist ([51ee91a](https://github.com/osovv/vv-opencode/commit/51ee91a))

## <small>1.3.6-rc.2 (2026-08-25)</small>

### Summary

This release moves all Kimi presets and provider patches from the previous provider to the kimi-for-coding subscription provider, updating the vv-kimi role assignments for default, fast, smart, and reviewer agents with the correct provider-scoped model IDs (such as k3 instead of the older kimi-k3 ID) and refreshed context and output limits. This matters to users because applying a Kimi preset now resolves to the intended subscription models directly, with accurate limits and routing behavior, so configured agents connect to the right endpoints without stale provider or model identifiers.

* feat(presets): move kimi presets and patches to the kimi-for-coding subscription provider ([0029fda](https://github.com/osovv/vv-opencode/commit/0029fda))

## <small>1.3.6-rc.1 (2026-08-25)</small>

### Summary

This release fixes the peak-hours plugin so peak-hour surcharge scheduling is applied only to subscription plan provider ids verified in the OpenCode provider registry (models.dev). GLM Coding Plan ids (`zai-coding-plan`, `zhipuai-coding-plan`) map to the Z.AI schedule, while Alibaba Token Plan ids (`alibaba-token-plan`, `alibaba-token-plan-cn`) map to the Qwen schedule; bare pay-per-token API providers such as `zai`, `zhipuai`, `alibaba`, `alibaba-cn`, and `openai` are never gated because their tariffs publish no peak surcharge. This prevents users on pay-per-token APIs from being incorrectly warned about or blocked by peak-hour windows, while unknown providers remain unblocked and malformed schedules still fail open.

* fix(peak-hours): gate subscription plan provider ids only with registry-verified aliases ([61b84bb](https://github.com/osovv/vv-opencode/commit/61b84bb))

## <small>1.3.6-rc.0 (2026-08-21)</small>

### Summary

This release adds the PeakHoursPlugin, which makes peak-priced billing windows visible and optionally gates new work: in hard mode a message whose provider is inside a configured peak window is rejected before any LLM request with the window end, wait time, and connected providers currently outside peak, while soft mode appends a bounded cost notice and keeps a persistent orange TUI banner visible; sessions created before a window started, subagent-like agents, and internal OpenCode agents are never hard-blocked, revision-dated default schedules for DeepSeek, Z.AI, and Qwen are materialized into vvoc.json by sync/init without overwriting user edits, and unknown providers are never gated. The release also makes the npm publication channel explicit end to end: pre-release versions now publish to a dedicated rc dist-tag with pre-release-marked GitHub Releases instead of silently moving the latest tag, so default `vvoc upgrade` stays on stable releases, and users can deliberately opt into candidates with `vvoc upgrade --rc` (or `--allow-prerelease`), which resolves the rc dist-tag and reports clearly when no candidate is available.

* chore(grace): add approved C-PLUGIN-PEAK-HOURS spec and plan bundle ([02aefdb](https://github.com/osovv/vv-opencode/commit/02aefdb))
* chore(grace): add approved C-RELEASE-RC-CHANNEL spec and plan bundle ([39a2e76](https://github.com/osovv/vv-opencode/commit/39a2e76))
* chore(grace): apply and archive C-PLUGIN-PEAK-HOURS ([5069639](https://github.com/osovv/vv-opencode/commit/5069639))
* chore(grace): apply and archive C-RELEASE-RC-CHANNEL ([3de9627](https://github.com/osovv/vv-opencode/commit/3de9627))
* chore(grace): synchronize release channel projections for C-RELEASE-RC-CHANNEL ([a47c700](https://github.com/osovv/vv-opencode/commit/a47c700))
* docs(peak-hours): document modes, grace, defaults, aliases, and the TUI banner ([9b01d07](https://github.com/osovv/vv-opencode/commit/9b01d07))
* docs(release): document the rc dist-tag channel, upgrade flags, and maintainer workflow ([2906a51](https://github.com/osovv/vv-opencode/commit/2906a51))
* feat(peak-hours): add chat.message server plugin with grace and suggestions ([760f418](https://github.com/osovv/vv-opencode/commit/760f418))
* feat(peak-hours): add persistent app_bottom TUI banner ([5fb1853](https://github.com/osovv/vv-opencode/commit/5fb1853))
* feat(peak-hours): add pure provider-level schedule library ([419fc8d](https://github.com/osovv/vv-opencode/commit/419fc8d))
* feat(peak-hours): add toggle, revision-dated default schedules, schema arm, and sync materialization ([2acf947](https://github.com/osovv/vv-opencode/commit/2acf947))
* feat(peak-hours): synchronize GRACE graph, verification, and requirements projections ([cfb8cf1](https://github.com/osovv/vv-opencode/commit/cfb8cf1))
* feat(publish): publish through a validated channel input with an explicit npm dist-tag ([f33d386](https://github.com/osovv/vv-opencode/commit/f33d386))
* feat(release): derive publish channel from version and mark rc releases pre-release ([1b78336](https://github.com/osovv/vv-opencode/commit/1b78336))
* feat(upgrade): resolve rc upgrades from the npm rc dist-tag ([c6b3664](https://github.com/osovv/vv-opencode/commit/c6b3664))
* test(peak-hours): update canonical plugin count in CLI toggle coverage ([fbb60a5](https://github.com/osovv/vv-opencode/commit/fbb60a5))
* test(release): fix channel contradiction test to assert the exit path ([2fc2190](https://github.com/osovv/vv-opencode/commit/2fc2190))
* fix(grace): sync analytics and branding MODULE_MAP blocks with actual symbols ([3ec0f02](https://github.com/osovv/vv-opencode/commit/3ec0f02))
* fix(peak-hours): describe the peak-hours schema arm in both schema surfaces ([302d2a4](https://github.com/osovv/vv-opencode/commit/302d2a4))

## <small>1.3.5 (2026-08-21)</small>

### Summary

Release 1.3.5 clarifies what vv-opencode offers and makes plan documents easier to work with by hand. The docs are restructured around an outcome-first pitch that reframes the package as an opinionated agentic development layer for OpenCode, adds a "You just talk to OpenCode normally" section showing how vv-controller picks the lightest trajectory for each request while explicit spec, plan, and execute skills take over only when the work needs them, and surfaces provider-neutral web tools in a new Why section. On the functional side, plan tasks and waves now carry their identity in unique element names (`<TASK-T-NNN>` and `<WAVE-N>`) instead of generic tags with child id/num elements, so long task blocks stay addressable and grep/sed extraction used by vv-plan and vv-execute remains exact without a separate query language; the plan template, skill format rules, plan-validation checks, and README grep examples are updated to match.

* docs(readme): reframe pitch as agentic layer and add natural-trajectory section ([d197955](https://github.com/osovv/vv-opencode/commit/d197955))
* docs(readme): restructure around outcome-first pitch and runtime value ([9e6910b](https://github.com/osovv/vv-opencode/commit/9e6910b))
* docs(readme): surface provider-neutral web tools in the Why section ([c90ecf0](https://github.com/osovv/vv-opencode/commit/c90ecf0))
* feat(skills): give plan tasks and waves unique element-name boundaries ([8f52f0c](https://github.com/osovv/vv-opencode/commit/8f52f0c))

## <small>1.3.4 (2026-08-19)</small>

### Summary

Version 1.3.4 reworks the tool-history-compaction plugin to protect your active working context and make pruning recoverable. The previous call-count-based tail protection is replaced with an absolute recent-message window (protectRecentMessages, default 8) anchored by message recency time, so outputs inside the newest messages are never rewritten regardless of call count, output size, tool class, or parallel batching, even when OpenCode reorders messages before the transform hook. A protection-budget leak was also fixed: retained tools such as task, agent, websearch, and skill no longer consume the per-call protection budget, so older bash/read outputs stay protected in agent-heavy sessions. Additionally, pruning is now recoverable by default (savePrunedOutput): the full pruned output is persisted once per tool call under your XDG data home in the vvoc tool-output directory, and the prune marker embeds the saved path so the model can re-read the complete output instead of reconstructing it from head and tail fragments. Schema v3, sync materialization, and the README were updated to reflect the new configuration options.

* feat(tool-history-compaction): protect the recent message window and persist pruned outputs ([b44eeeb](https://github.com/osovv/vv-opencode/commit/b44eeeb))

## <small>1.3.3 (2026-08-19)</small>

### Summary

In this release the TUI branding footer is upgraded to show a single combined version line in the sidebar — `• OpenCode <version> · vvoc vX.Y.Z` — replacing the previous standalone vvoc label in the bottom app bar. The new footer reads the OpenCode version from the running app, renders with the active theme colors, and deliberately wins the sidebar footer slot so it appears in a native-looking, always-visible location. This makes it easier for users to see at a glance which OpenCode and vvoc versions are active in a session.

* feat(tui): render combined OpenCode and vvoc versions in the sidebar footer ([ea5aa66](https://github.com/osovv/vv-opencode/commit/ea5aa66))

## <small>1.3.2 (2026-08-19)</small>

### Summary

The vvoc version label in the TUI has been relocated from the sidebar footer slot to the append-mode `app_bottom` slot, so it now appears in the bottom app bar on every screen without displacing OpenCode's own footer or prompt content, which previously owned that single-winner slot. Theme colors are now passed directly as RGBA values instead of being converted to hex strings, making both the version label and the live cache indicator render with accurate theme colors more reliably, and both slot registrations now include explicit plugin IDs as required by the OpenCode runtime.

* fix(tui): move vvoc label to append-mode app_bottom slot and apply theme fg color directly ([a01453d](https://github.com/osovv/vv-opencode/commit/a01453d))

## <small>1.3.1 (2026-08-19)</small>

### Summary

Version 1.3.1 fixes a TUI stability issue where the live cache hit rate indicator and the vvoc branding footer rendered label text in a way that OpenTUI rejected, which could crash the OpenCode terminal interface. Labels are now wrapped in proper text elements, and theme colors are converted to a reliable hex format that OpenTUI parses consistently. Regression tests were added with real OpenTUI rendering to prevent this class of crash from returning.

* fix(tui): wrap slot labels in text elements to prevent OpenTUI orphan text crashes ([70589a7](https://github.com/osovv/vv-opencode/commit/70589a7))

## 1.3.0 (2026-08-19)

### Summary

Version 1.3.0 introduces a new analytics system to help users understand and optimize token usage and prompt-cache effectiveness. A new AnalyticsPlugin collects per-step token and cache telemetry with vvoc and OpenCode version attribution into local-only JSONL files, the new `vvoc analytics cache-hit-rate` command aggregates and compares cache hit rates by day, week, month, model, provider, project, session, or vvoc/OpenCode version with date/project filters and JSON output, and the TUI gains a live per-session cache percentage indicator plus a vvoc version footer. A new vvoc-usage-analytics managed skill lets users ask usage, cache, and cost questions conversationally during a session, including historical comparisons from opencode.db that predate the plugin. All telemetry stays on the machine, and analytics collection can be disabled via the plugin toggle.

* feat(analytics): add analytics types, JSONL store, metrics, and version helper export ([a709547](https://github.com/osovv/vv-opencode/commit/a709547))
* feat(analytics): add cache-hit-rate CLI command with grouping and JSON output ([8d0e70f](https://github.com/osovv/vv-opencode/commit/8d0e70f))
* feat(analytics): add live cache indicator and vvoc version footer for the TUI ([8098f10](https://github.com/osovv/vv-opencode/commit/8098f10))
* feat(analytics): add server plugin collecting step-finish telemetry with version attribution ([9db2cb3](https://github.com/osovv/vv-opencode/commit/9db2cb3))
* feat(analytics): register analytics toggle, CLI command, and TUI wiring ([e54d4b0](https://github.com/osovv/vv-opencode/commit/e54d4b0))
* feat(skills): add vvoc-usage-analytics managed skill with read-only opencode.db queries ([d61cda0](https://github.com/osovv/vv-opencode/commit/d61cda0))
* docs(analytics): document cache hit rate analytics in README and stabilize CLI exit-code tests ([8519eab](https://github.com/osovv/vv-opencode/commit/8519eab))

## <small>1.2.11 (2026-08-18)</small>

### Summary

This release strengthens the system-context guidance that vv-opencode injects into sessions. The assumption discipline now requires every claim to be tagged as verified, asserted, or refuted, with unmarked claims treated as unverified, so material assumptions can no longer silently become downstream premises. The working-state guidance adds a one-line restatement of the requirement before acting to catch dropped constraints early, and reroute guidance now demands that a retry carry a named diagnosis of the prior failure rather than blankly repeating the same attempt. A new delivery-discipline block keeps internal reasoning compact while forcing clean, complete output for anything user- or tool-facing, and the vv-controller's final response format now requires reading the goal back line by line, marking each line as met, partly met, or not met, and naming the edge that was not checked before claiming completion. Together these changes reduce wasted retries and premature completion claims, and make the verification status of assumptions explicit throughout a session.

* feat(system-context-injection): add epistemic tags, re-encode-first, diagnosis retry, and done-check ([8524ee4](https://github.com/osovv/vv-opencode/commit/8524ee4))

## <small>1.2.10 (2026-08-18)</small>

### Summary

Release 1.2.10 introduces the ToolHistoryCompactionPlugin, which shrinks the conversation context replayed to the model on every turn without touching on-disk storage or tool inputs: old file reads collapse to compact "[Read &lt;file&gt;, lines X-Y]" headers, oversized ephemeral outputs (bash/grep/glob) are pruned to head/marker/tail form, and session-long knowledge results (web fetch/search, skills, subagent reports) are always retained, with a protected recent tail and minimum-savings guard to keep rewrites deterministic and prompt-cache friendly. The release also materializes the default hashline edit-routing table into vvoc.json on sync/init so it is visible and editable without ever overwriting user-changed values, and routes GLM models to the replace editing profile that matches their training, improving edit reliability for GLM users. These changes reduce token pressure and context-limit pressure in long sessions, expose edit-routing configuration more transparently, and lower edit error rates for GLM-based workflows.

* chore: bump version from 1.2.8 to 1.2.9 with changelog ([fac201b](https://github.com/osovv/vv-opencode/commit/fac201b))
* feat(config): materialize hashline edit-routing table into vvoc.json on sync ([eb9da0e](https://github.com/osovv/vv-opencode/commit/eb9da0e))
* feat(hashline-edit): route glm models to the replace profile ([f0c8dc2](https://github.com/osovv/vv-opencode/commit/f0c8dc2))
* feat(tool-history-compaction): non-destructive compaction of replayed tool history ([6a4fb56](https://github.com/osovv/vv-opencode/commit/6a4fb56))

## <small>1.2.9 (2026-08-18)</small>

### Summary

Release 1.2.9 introduces a new ToolHistoryCompactionPlugin that shrinks the conversation context replayed to the model on every turn without touching on-disk storage or tool inputs: old file reads collapse to compact "[Read <file>, lines X-Y]" headers, oversized ephemeral outputs (bash/grep/glob) are pruned to head/marker/tail form, and session-long knowledge results (web fetch/search, skills, subagent reports) are always retained, with a protected recent tail and minimum-savings guard to keep rewrites deterministic and prompt-cache friendly. The release also materializes the default hashline edit-routing table into vvoc.json on sync/init so it is visible and editable without ever overwriting user-changed values, and routes GLM models to the replace editing profile that matches their training, improving edit reliability for GLM users. These changes reduce token pressure and context-limit pressure in long sessions, expose edit-routing configuration more transparently, and lower edit error rates for GLM-based workflows.

* feat(config): materialize hashline edit-routing table into vvoc.json on sync ([eb9da0e](https://github.com/osovv/vv-opencode/commit/eb9da0e))
* feat(hashline-edit): route glm models to the replace profile ([f0c8dc2](https://github.com/osovv/vv-opencode/commit/f0c8dc2))
* feat(tool-history-compaction): non-destructive compaction of replayed tool history ([6a4fb56](https://github.com/osovv/vv-opencode/commit/6a4fb56))

## <small>1.2.8 (2026-08-18)</small>

### Summary

Version 1.2.8 introduces per-model edit-format routing to the hashline-edit plugin, so each session only sees the editing tool matching its active model's native format. DeepSeek sessions use the dsh str_replace_editor contract, Qwen and Kimi use an exact oldString/newString replace tool with prior-read enforcement and visible fallback matching, GPT/Codex pass through to the host editor, and unmatched models keep the hash-anchored editing tool (renamed from edit to hashline_edit). Hashline editing is hardened with mandatory three-part LINE#HASH#ANCHOR references, unified replace semantics with an optional end anchor, and visible warnings when insert payloads would duplicate neighboring lines. The vvoc config now accepts a boolean or an object with enabled and routing for the plugin, letting users override the default routing per provider or model, and every edit result reports its edit mode along with provider and model identifiers. This reduces failed and wrong-location edits by ensuring each model works with the editing format it was designed for, backed by stale-file and drift protections across all profiles.

* feat(hashline-edit): route per-model edit formats with native profiles ([e43e410](https://github.com/osovv/vv-opencode/commit/e43e410)), closes [HASH#ANCHOR](https://github.com/HASH/issues/ANCHOR)

## <small>1.2.7 (2026-08-14)</small>

### Summary

Hashline Edit now applies edit payloads literally, removing the silent autocorrect heuristics that could lose or duplicate lines; ambiguous payloads such as blank entries or entries containing embedded newlines are rejected fail-closed instead of being guessed at, while exact duplicate echoes are trimmed and reported as visible warnings. End-of-file appends no longer introduce a phantom blank line, and every successful edit returns a bounded diff with added/removed line counts and the first changed line, making it easier to confirm edits match intent before continuing.

* feat(hashline-edit): apply edit payloads literally and report bounded post-edit diffs ([5da05e6](https://github.com/osovv/vv-opencode/commit/5da05e6))

## <small>1.2.6 (2026-08-13)</small>

### Summary

Version 1.2.6 adds DeepSeek to the provider patching workflow. `vvoc patch-provider` now accepts a `deepseek` preset that installs the `vv-deepseek-v4-flash-max` alias with max reasoning effort and official text modalities, so users can opt into the higher-reasoning variant without hand-editing OpenCode config. The default preset lineup now routes the `smart` agent role to that alias, the `deepseek` preset is included in the `all` patch and in shell completions, and every patched provider (stepfun-ai, codex, kimi, alibaba) now declares its official input/output modalities so models are advertised with accurate text, image, video, and PDF capabilities.

* feat(presets): add deepseek vv-deepseek-v4-flash-max alias with official modalities ([0e9fe65](https://github.com/osovv/vv-opencode/commit/0e9fe65))

## <small>1.2.5 (2026-08-12)</small>

### Summary

Release 1.2.5 reworks the built-in preset and role lineup to keep model-role assignments current and user-safe. The unused vision role is removed, leaving four built-in roles (default, smart, fast, reviewer) while legacy configs that still contain a vision value remain valid. The vv-codex preset now relies entirely on the GPT-5.6 codex family, with a new vv-codex-gpt-5.6-luna-low fast tier replacing the old gpt-5.4-mini alias with a smarter, cheaper model, and the vv-osovv-* fast tier switches to the same Luna alias so the whole lineup shares one 5.6 family. New self-contained vv-kimi and vv-alibaba presets add kimi-k3 and qwen3.8-max reasoning-effort aliases, and the osovv family is renamed and expanded into vv-osovv-sol, vv-osovv-flash, vv-osovv-kimi, and vv-osovv-qwen, which share one base and differ only in the smart role; the stale vv-minimax preset and dead zai models are dropped in favor of the official plan lineup. vvoc patch-provider also gains kimi and alibaba alias patches plus an all preset that patches every registered provider at once, and the /btw side-question idea is now marked unblocked for the OpenCode TUI plugin.

* chore(patch-provider): drop the unused vv-codex-gpt-5.4-mini-low alias ([932356a](https://github.com/osovv/vv-opencode/commit/932356a))
* feat(presets): drop vision role, rework lineup, add kimi/alibaba and patch-provider all ([33f71a9](https://github.com/osovv/vv-opencode/commit/33f71a9))
* feat(presets): switch vv-osovv-* fast tier to vv-codex-gpt-5.6-luna-low ([e8892dd](https://github.com/osovv/vv-opencode/commit/e8892dd))
* fix(presets): drop vv-minimax, remove dead zai models, pin official plan lineup ([221a4bc](https://github.com/osovv/vv-opencode/commit/221a4bc))
* docs(ideas): mark /btw unblocked with re-evaluation evidence ([d329987](https://github.com/osovv/vv-opencode/commit/d329987)), closes [#21002](https://github.com/osovv/vv-opencode/issues/21002)

## <small>1.2.4 (2026-08-12)</small>

### Summary

Release 1.2.4 reworks the built-in preset lineup and drops the dead vision role. Built-in roles shrink from five to four (default, smart, fast, reviewer): vision was bound to no OpenCode agent and is removed from the schema minimum, default config, all presets, and completion while legacy configs with a vision value stay valid. The vv-codex preset moves fully onto the GPT-5.6 codex family (terra-high default, a new vv-codex-gpt-5.6-luna-low alias as fast, sol-xhigh smart and reviewer) and plain gpt-5.4 is dropped; fresh-install default roles use plain gpt-5.6-terra/sol/luna. New branded self-contained presets vv-kimi (kimi-k3 with the vv-kimi-k3-max effort alias) and vv-alibaba (qwen3.8-max with the vv-qwen3.8-max-xhigh alias) work with only that provider's subscription. The author osovv family is renamed and expanded: vv-osovv becomes vv-osovv-sol, vv-osovv-cheap becomes vv-osovv-flash (smart deepseek-v4-flash), and new vv-osovv-kimi and vv-osovv-qwen variants join — all four share one base and differ only in smart. vvoc patch-provider gains kimi and alibaba alias patches plus an all preset that patches every registered provider at once. The v3 schema roles minimum loosens from 5 to 4 properties, requiring a package version bump.

## <small>1.2.3 (2026-08-11)</small>

### Summary

This release fixes a Guardian plugin regression that affected users running OpenCode in the embedded TUI. In that environment, OpenCode supplies a legacy SDK client that lacks the standard `client.permission.reply` method, and the previous raw HTTP fallback targeted a placeholder server URL with no listener, causing low-risk auto-allow permission responses to fail with `PERMISSION_REPLY_FAILED`. Guardian now restores the deprecated SDK respond endpoint as the first path for such embedded clients, so auto-allow replies succeed as expected, while the HTTP fallback remains in place for hosted servers; it also preserves the underlying cause of any reply failure in logs for easier diagnosis.

* fix(guardian): restore legacy permission respond fallback for embedded clients ([1bee1ca](https://github.com/osovv/vv-opencode/commit/1bee1ca))

## <small>1.2.2 (2026-08-11)</small>

### Summary

Release 1.2.2 hardens editing safety, config validation, and repository integrity. The hash-anchored edit tool now explicitly directs structural insertions to safer append/prepend operations so new code is added next to surviving lines instead of replacing closing braces or other structural syntax, and it requires preservation of consumed closing syntax during range rewrites to prevent unbalanced code; this guidance is backed by new regression tests and corrected examples. The Guardian config command now strictly rejects zero, negative, fractional, or malformed duration values like `--timeout-ms` before printing or writing anything, preventing schema-invalid configuration (including silently rounded zero durations) and documenting the accepted positive-integer input in the README. The web_search tool now reliably applies its declared default result count of eight at execution time when the count argument is omitted, so searches return the expected number of results regardless of how OpenCode passes optional arguments. The release also restores corrupted file-local markup that had made a test file unrecognized, adds a repository-wide GRACE markup check (`grace:check`) that enforces governed-file coverage and single accurate change summaries across the codebase, corrects workflow dependency ownership to match the actual source structure, and strengthens planning policy so behavior-changing work requires meaningful content baselines. Together these changes make edits less likely to break file structure, make CLI configuration writing schema-safe, and close several gaps in verification and documentation coverage.

* test(guardian): avoid redundant CLI subprocesses ([682ebae](https://github.com/osovv/vv-opencode/commit/682ebae))
* chore(grace): keep current hashline change summary ([9d4a449](https://github.com/osovv/vv-opencode/commit/9d4a449))
* fix(edit): guide structural insert operations ([d64f5d8](https://github.com/osovv/vv-opencode/commit/d64f5d8))
* fix(grace): remediate integrity and coverage gaps ([ce9ced7](https://github.com/osovv/vv-opencode/commit/ce9ced7))

## <small>1.2.1 (2026-07-27)</small>

### Summary

Version 1.2.1 fixes a robustness gap in the web_fetch tool where omitted format and timeout arguments from OpenCode could cause undefined behavior; the tool now applies markdown formatting and a standard timeout as sensible defaults when those values are not provided at runtime, ensuring fetch operations complete reliably even when callers omit optional parameters.

* fix(web-tools): default omitted fetch arguments ([060869d](https://github.com/osovv/vv-opencode/commit/060869d))
* chore(grace): reconcile semantic metadata ([26c9bb4](https://github.com/osovv/vv-opencode/commit/26c9bb4))

## 1.2.0 (2026-07-26)

### Summary

This release introduces the unified WebToolsPlugin, which replaces provider-specific search and fetch schemas with two canonical tools—web_search and web_fetch—supporting Exa, Brave, native retrieval, Spider extraction, and direct Z.AI/Zhipu Tool API providers with explicit region selection and secure credential handling. Secrets redaction now covers configured web API keys and tool-part state payloads, closing a bypass where tool inputs, outputs, and errors could reach the provider unredacted. The Guardian plugin hardens auto-approval by requiring an explicit low risk level, runs review as the constrained guardian agent, and makes debug logging opt-in. Hashline edit rename operations prevent data loss by detecting path-equivalent source and target and refusing to overwrite existing files. Workflow tracking no longer strands work items in an in-flight state when a tracked result fails, and session cleanup correctly reads the SDK event shape. GPT-5.6 patch-provider limits are corrected to the post-PR#33972 Codex metadata, keeping sessions out of premium pricing. Across the board, runtime hardening, documentation, and GRACE governance updates make the package more reliable and secure for disciplined agentic development.

* chore(grace): add verification trace assertions ([826e4d1](https://github.com/osovv/vv-opencode/commit/826e4d1))
* chore(grace): repair artifacts and semantic markup ([a8c308d](https://github.com/osovv/vv-opencode/commit/a8c308d))
* chore(web-tools): sync GRACE governance and contracts ([0c5b1a9](https://github.com/osovv/vv-opencode/commit/0c5b1a9))
* docs(web-tools): document providers and runtime behavior ([b390202](https://github.com/osovv/vv-opencode/commit/b390202))
* docs(web-tools): record multiprovider search idea ([5763c31](https://github.com/osovv/vv-opencode/commit/5763c31))
* feat(secrets-redaction): redact configured web api keys ([16964bf](https://github.com/osovv/vv-opencode/commit/16964bf))
* feat(web-tools): add direct Z.AI providers ([e0b8467](https://github.com/osovv/vv-opencode/commit/e0b8467))
* feat(web-tools): add HTTP transport, HTML conversion, media loader, and providers ([94d211e](https://github.com/osovv/vv-opencode/commit/94d211e))
* feat(web-tools): add vvoc web config schema, plugin toggle, and runtime resolver ([303ab96](https://github.com/osovv/vv-opencode/commit/303ab96))
* feat(web-tools): add web fetch tool service ([df959e9](https://github.com/osovv/vv-opencode/commit/df959e9))
* feat(web-tools): add web search tool service ([f5dec5a](https://github.com/osovv/vv-opencode/commit/f5dec5a))
* feat(web-tools): register plugin and package exports ([ba8d724](https://github.com/osovv/vv-opencode/commit/ba8d724))
* feat(web-tools): sync guardian and context attribution ([62613a7](https://github.com/osovv/vv-opencode/commit/62613a7))
* fix: harden redaction, guardian, hashline, and workflow runtime ([726d330](https://github.com/osovv/vv-opencode/commit/726d330))
* fix(edit): preserve indented range boundaries ([84366de](https://github.com/osovv/vv-opencode/commit/84366de))
* fix(patch-provider): correct GPT-5.6 context limits to post-PR#33972 Codex metadata ([bceb41f](https://github.com/osovv/vv-opencode/commit/bceb41f)), closes [post-PR#33972](https://github.com/post-PR/issues/33972) [#33972](https://github.com/osovv/vv-opencode/issues/33972)
* test(web-tools): cover CLI toggle inventory ([05ecf18](https://github.com/osovv/vv-opencode/commit/05ecf18))

## <small>1.1.6 (2026-07-17)</small>

### Summary

This release hardens the release automation pipeline by fixing tag identity configuration in CI and moving tag and GitHub Release finalization to the authenticated local process after successful npm publication. Previously, the CI workflow attempted to create release tags using the GITHUB_TOKEN, which cannot tag commits containing workflow changes; now the local release wrapper waits for CI to publish the package, retries npm metadata propagation to verify the published gitHead matches the exact release commit, and only then creates the annotated tag and GitHub Release using the maintainer's authenticated git and gh clients. This ensures verification-before-tagging while avoiding GitHub App token restrictions, and uses bounded retries with exponential backoff to handle delayed npm metadata propagation.

* fix(release): configure CI tag identity ([cae54af](https://github.com/osovv/vv-opencode/commit/cae54af))
* fix(release): finalize tags after CI publication ([707170e](https://github.com/osovv/vv-opencode/commit/707170e))

## <small>1.1.5 (2026-07-16)</small>

### Summary

Release automation was hardened to require explicit GitHub Actions dispatch with an exact version and commit SHA, replacing the previous tag-push trigger so that all CI gates—typecheck, lint, format, tests, build, pack validation, and release consistency checks—complete successfully before npm publication, remote tag creation, and GitHub Release creation, preventing accidental or premature publishing and enabling safe reruns for tag recovery.

* fix(release): gate publishing and tags behind CI ([55908c5](https://github.com/osovv/vv-opencode/commit/55908c5))

## <small>1.1.4 (2026-07-16)</small>

### Summary

This release delivers a major upgrade to the `/context` TUI dialog, transforming it from a single aggregate view into a detailed three-tabbed inspector with Overview, Tools, and MCP panels that show per-tool schema and active-history estimates, context-window percentages derived only from the model's positive context limit, and deterministic MCP server attribution through longest-prefix naming. Connected MCP schema catalogs unavailable through OpenCode's public APIs are now explicitly marked as such rather than incorrectly shown as zero, and the dialog content is vertically centered within the host window. A new `tui:local` script enables pre-release smoke testing by building and launching the local TUI export through an isolated temporary config without modifying the user's selected OpenCode, TUI, or vvoc configuration files.

* fix(tui): mark unavailable MCP schemas ([b5b7dd6](https://github.com/osovv/vv-opencode/commit/b5b7dd6))
* feat(tui): add detailed context attribution ([c7bc1c8](https://github.com/osovv/vv-opencode/commit/c7bc1c8))
* feat(tui): add local testing and center context dialog ([0d9f587](https://github.com/osovv/vv-opencode/commit/0d9f587))

## <small>1.1.3 (2026-07-16)</small>

### Summary

Release 1.1.3 fixes a layout issue in the `/context` dialog where a duplicate dialog wrapper caused incorrect rendering. The fix moves dialog container ownership to the host and applies "xlarge" sizing after the content is replaced, ensuring the context breakdown displays with the intended dimensions and no nested modals. This improves the reliability of the context inspection interface for all users.

* fix(tui): correct context dialog layout ([0e22c00](https://github.com/osovv/vv-opencode/commit/0e22c00))

## <small>1.1.2 (2026-07-16)</small>

### Summary

This release fixes the TUI plugin registration to use the pinned base package specifier instead of the legacy `/tui` subpath, ensuring OpenCode correctly selects the managed `./tui` export. Existing installations with the old subpath are automatically migrated during sync. Additionally, `vvoc status` and `vvoc doctor` now report the installed OpenCode version and check whether it meets the minimum 1.18.2 requirement for TUI compatibility, making it easier to diagnose host version issues.

* fix(tui): register pinned package entry ([55920a2](https://github.com/osovv/vv-opencode/commit/55920a2))

## <small>1.1.1 (2026-07-16)</small>

### Summary

This release introduces a new `/context` TUI command that gives users real-time visibility into their OpenCode session's context usage directly within the editor interface. The feature displays the latest provider-reported token consumption alongside a clearly labeled, approximate breakdown of observable context contributors—such as system instructions, loaded skills, tool schemas, conversation messages, files, and compaction summaries—without claiming exact provider attribution. It also surfaces MCP server statuses and reports estimation drift when visible estimates exceed measured usage. The plugin is enabled by default and can be toggled via `vvoc plugin`. The installation, sync, launch, status, and doctor commands now also manage a dedicated TUI configuration file (`tui.json` / `tui.jsonc`) conservatively, preserving unrelated settings and existing plugin entries. Package dependencies have been updated to OpenCode 1.18.2 and OpenTUI 0.4.3 to support the modern TUI plugin API, and a new `@osovv/vv-opencode/tui` package subpath is published for consumers.

* feat(tui): add context usage inspector ([328ed9f](https://github.com/osovv/vv-opencode/commit/328ed9f))

## 1.1.0 (2026-07-11)

### Summary

This release introduces orchestration profiles—single-session, balanced, and orchestrated—that let users control how vv-controller delegates work at runtime, with built-in presets automatically selecting a sensible default, a new `vvoc orchestration show|set` CLI command for explicit profile management, and status diagnostics that report the effective profile from the selected config source; alongside this, the managed OpenAI preset has been renamed to vv-codex with explicit Codex subscription-safe token limits to prevent compaction failures, the managed controller prompt and skill templates have been made profile-neutral to eliminate context pollution, and the repository agent guide has been rewritten for clarity.

* chore: archive applied orchestration profiles change ([09228ac](https://github.com/osovv/vv-opencode/commit/09228ac))
* chore(grace): archive applied Codex preset change ([5d7157c](https://github.com/osovv/vv-opencode/commit/5d7157c))
* docs: document orchestration profiles ([01b5786](https://github.com/osovv/vv-opencode/commit/01b5786))
* docs(grace): improve repository agent guide ([f5e9e3b](https://github.com/osovv/vv-opencode/commit/f5e9e3b))
* docs(grace): project orchestration modules and flows ([e66875c](https://github.com/osovv/vv-opencode/commit/e66875c))
* feat(cli): add scoped orchestration command ([c5bb612](https://github.com/osovv/vv-opencode/commit/c5bb612))
* feat(cli): register orchestration completions ([ec26cfc](https://github.com/osovv/vv-opencode/commit/ec26cfc))
* feat(config): add orchestration profiles to schema v3 ([6c920c3](https://github.com/osovv/vv-opencode/commit/6c920c3))
* feat(context): inject concrete controller policy ([1941c34](https://github.com/osovv/vv-opencode/commit/1941c34))
* feat(grace): plan preset orchestration profiles ([997a1ea](https://github.com/osovv/vv-opencode/commit/997a1ea))
* feat(orchestration): add profile policy domain ([6de8219](https://github.com/osovv/vv-opencode/commit/6de8219))
* feat(preset): apply orchestration profiles atomically ([161d7ff](https://github.com/osovv/vv-opencode/commit/161d7ff))
* feat(status): report effective orchestration profile ([473d92e](https://github.com/osovv/vv-opencode/commit/473d92e))
* feat(workflow): select profile-compatible guidance ([b664d4b](https://github.com/osovv/vv-opencode/commit/b664d4b))
* test(skills): protect workflow discovery metadata ([be76244](https://github.com/osovv/vv-opencode/commit/be76244))
* refactor(controller): keep managed prompt profile neutral ([092b995](https://github.com/osovv/vv-opencode/commit/092b995))
* fix(codex): rename managed presets and set safe limits ([ae77c7c](https://github.com/osovv/vv-opencode/commit/ae77c7c))

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