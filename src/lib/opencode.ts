// FILE: src/lib/opencode.ts
// VERSION: 1.5.0
// START_MODULE_CONTRACT
//   PURPOSE: Public re-export barrel for OpenCode runtime/TUI config mutation, host compatibility diagnostics, provider patching, and scoped vvoc.json config files.
//   SCOPE: Re-export the complete public API over the concern-scoped zone modules in src/lib/opencode/ (shared-utils, paths, plugin-registration, agent-registrations, model-overrides, vvoc-config-io, inspection) so every ../lib/opencode.js and ./opencode.js import keeps resolving unchanged under moduleResolution NodeNext, where directory imports are not available.
//   DEPENDS: [src/lib/package.ts, src/lib/vvoc-config.ts, src/lib/opencode/shared-utils.ts, src/lib/opencode/paths.ts, src/lib/opencode/plugin-registration.ts, src/lib/opencode/agent-registrations.ts, src/lib/opencode/model-overrides.ts, src/lib/opencode/vvoc-config-io.ts, src/lib/opencode/inspection.ts]
//   LINKS: [M-CLI-CONFIG, M-ORCHESTRATION-PROFILES]
//   ROLE: BARREL
//   MAP_MODE: SUMMARY
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   resolvePaths, ensurePackageConfigText, ensureTuiPackageConfigText, ensureTuiPackageInstalled, ensureManagedAgentRegistrationsConfigText, syncManagedAgentRegistrations, installManagedAgentPrompts, syncManagedAgentPrompts, installManagedSkillFiles, syncManagedSkillFiles, ensureManagedSkillSymlink, readManagedAgentModels, readManagedAgentOverrides, readOpenCodeAgentModel, readOpenCodeAgentOverride, readOpenCodeDefaultModel, writeOpenCodeAgentModel, writeOpenCodeDefaultModel, writeOpenCodeProviderObject, writeManagedAgentModel, ensurePackageInstalled, ensureProviderBaseUrlConfigText, writeProviderBaseUrl, readVvocConfig, installVvocConfig, syncVvocConfig, writeGuardianConfig, inspectOpenCodeRuntime, isTuiOpenCodeVersionCompatible, extractOpenCodeVersion, inspectInstallation, inspectInstallationForScope, describeWriteResult - Public functions of the former monolith, now owned by zone modules.
//   CLI_NAME, PACKAGE_NAME, OPENCODE_SCHEMA_URL, OPENCODE_TUI_SCHEMA_URL, TUI_PACKAGE_SPECIFIER, MINIMUM_TUI_OPENCODE_VERSION - Public constants owned by zone modules and package.ts.
//   Scope, ResolvedPaths, WriteResult, TuiPluginEntry, OpenCodeDefaultModelKey, ManagedAgentModelMap, OpenCodeAgentOverride, ManagedAgentOverrideMap, OpenCodeRuntimeInspection, InstallationInspection, GuardianConfigOverrides - Public types owned by zone modules and vvoc-config.ts.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [C-OPENCODE-MODULE-SPLIT-R1 - Replaced the 2045-line monolith body with a re-export-only barrel over concern-scoped zone modules in src/lib/opencode/; the public API and every consumer import are unchanged.]
// END_CHANGE_SUMMARY

export { PACKAGE_NAME } from "./package.js";
export {
  parseGuardianConfigText,
  renderGuardianConfig,
  type GuardianConfigOverrides,
} from "./vvoc-config.js";

export { CLI_NAME, OPENCODE_SCHEMA_URL, OPENCODE_TUI_SCHEMA_URL } from "./opencode/shared-utils.js";
export type { WriteResult, OpenCodeAgentOverride } from "./opencode/shared-utils.js";

export { resolvePaths } from "./opencode/paths.js";
export type { Scope, ResolvedPaths } from "./opencode/paths.js";

export {
  ensurePackageConfigText,
  ensureTuiPackageConfigText,
  ensureTuiPackageInstalled,
  ensurePackageInstalled,
} from "./opencode/plugin-registration.js";
export {
  TUI_PACKAGE_SPECIFIER,
  MINIMUM_TUI_OPENCODE_VERSION,
} from "./opencode/plugin-registration.js";
export type { TuiPluginEntry } from "./opencode/plugin-registration.js";

export {
  ensureManagedAgentRegistrationsConfigText,
  syncManagedAgentRegistrations,
  installManagedAgentPrompts,
  syncManagedAgentPrompts,
  installManagedSkillFiles,
  syncManagedSkillFiles,
  ensureManagedSkillSymlink,
  readManagedAgentModels,
  readManagedAgentOverrides,
  writeManagedAgentModel,
} from "./opencode/agent-registrations.js";
export type {
  ManagedAgentModelMap,
  ManagedAgentOverrideMap,
} from "./opencode/agent-registrations.js";

export {
  readOpenCodeAgentModel,
  readOpenCodeAgentOverride,
  readOpenCodeDefaultModel,
  writeOpenCodeAgentModel,
  writeOpenCodeDefaultModel,
  writeOpenCodeProviderObject,
  ensureProviderBaseUrlConfigText,
  writeProviderBaseUrl,
} from "./opencode/model-overrides.js";
export type { OpenCodeDefaultModelKey } from "./opencode/model-overrides.js";

export {
  readVvocConfig,
  installVvocConfig,
  syncVvocConfig,
  writeGuardianConfig,
} from "./opencode/vvoc-config-io.js";

export {
  inspectOpenCodeRuntime,
  isTuiOpenCodeVersionCompatible,
  extractOpenCodeVersion,
  inspectInstallation,
  inspectInstallationForScope,
  describeWriteResult,
} from "./opencode/inspection.js";
export type { OpenCodeRuntimeInspection, InstallationInspection } from "./opencode/inspection.js";
