// FILE: src/commands/completion.test.ts
// VERSION: 0.4.12
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-COMPLETION - shell completion generation.
//   SCOPE: Bash, zsh, and fish completion script generation including patch-provider presets, top-level preset completions, and the `role set|unset <role-id>` flow.
//   INPUTS: Generated completion scripts for bash, zsh, and fish.
//   OUTPUTS: Assertions over exposed commands, nested completions, and syntax markers.
//   DEPENDS: [bun:test, src/commands/completion.ts]
//   LINKS: [M-CLI-COMPLETION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   Test suite for completion generation.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.4.12 - Restricted unset-role completion assertions to avoid built-in role suggestions.]
// END_CHANGE_SUMMARY

import { expect, test } from "bun:test";
import {
  generateBashCompletion,
  generateFishCompletion,
  generateZshCompletion,
} from "./completion.js";

test("generateBashCompletion - contains vvoc command", () => {
  const output = generateBashCompletion();
  expect(output).toContain("vvoc");
  expect(output).toContain("role");
  expect(output).toContain("completion");
  expect(output).toContain("config");
  expect(output).toContain("patch-provider");
  expect(output).toContain("preset");
  expect(output).toContain("plugin");
});

test("generateBashCompletion - valid bash syntax", () => {
  const output = generateBashCompletion();
  expect(output).toContain("_vvoc()");
  expect(output).toContain("complete -F _vvoc vvoc");
});

test("generateZshCompletion - contains vvoc command", () => {
  const output = generateZshCompletion();
  expect(output).toContain("vvoc");
  expect(output).toContain("role");
  expect(output).toContain("config");
  expect(output).toContain("patch-provider");
  expect(output).toContain("preset");
  expect(output).toContain("plugin");
});

test("generateZshCompletion - valid zsh syntax", () => {
  const output = generateZshCompletion();
  expect(output).toContain("#compdef vvoc");
  expect(output).toContain("_vvoc()");
  expect(output).toContain("compdef _vvoc vvoc");
});

test("generateFishCompletion - contains vvoc command", () => {
  const output = generateFishCompletion();
  expect(output).toContain("vvoc");
  expect(output).toContain("role");
  expect(output).toContain("completion");
  expect(output).toContain("config");
  expect(output).toContain("patch-provider");
  expect(output).toContain("preset");
  expect(output).toContain("plugin");
});

test("generateFishCompletion - valid fish syntax", () => {
  const output = generateFishCompletion();
  expect(output).toContain("function __vvoc_commands");
  expect(output).toContain("complete -c vvoc");
});

test("generateBashCompletion - contains config subcommand", () => {
  const output = generateBashCompletion();
  expect(output).toContain("validate");
});

test("generateBashCompletion - top-level commands match CLI", () => {
  const output = generateBashCompletion();
  expect(output).toContain(
    'local commands="completion config doctor guardian init install patch-provider preset plugin role status sync upgrade version"',
  );
});

test("generateZshCompletion - contains plugin subcommand", () => {
  const output = generateZshCompletion();
  expect(output).toContain("list");
});

test("generateFishCompletion - handles nested subcommands", () => {
  const output = generateFishCompletion();
  expect(output).toContain("__fish_seen_subcommand_from role");
  expect(output).toContain("__fish_seen_subcommand_from config");
  expect(output).toContain("__fish_seen_subcommand_from patch-provider");
  expect(output).toContain("__fish_seen_subcommand_from preset");
  expect(output).toContain("__fish_seen_subcommand_from plugin");
});

test("generateBashCompletion - contains role command flow", () => {
  const output = generateBashCompletion();
  expect(output).toContain('local commands="set unset list"');
  expect(output).toContain("role:set");
  expect(output).toContain("default smart fast vision");
  expect(output).toContain("_vvoc_role_ids");
  expect(output).not.toContain("role:unset)");
});

test("generateZshCompletion - contains role id commands", () => {
  const output = generateZshCompletion();
  expect(output).toContain("set)");
  expect(output).toContain("default smart fast vision");
  expect(output).toContain("unset)");
  expect(output).toContain("<custom-role-id>");
});

test("generateFishCompletion - contains role id completions", () => {
  const output = generateFishCompletion();
  expect(output).toContain("function __vvoc_role_ids");
  expect(output).toContain("echo default smart fast vision");
  expect(output).toContain("__fish_seen_subcommand_from set");
  expect(output).not.toContain(
    "__fish_seen_subcommand_from role; and __fish_seen_subcommand_from set unset",
  );
});

test("completion scripts - contain patch-provider presets", () => {
  expect(generateBashCompletion()).toContain("_vvoc_patch_provider_presets");
  expect(generateZshCompletion()).toContain("_vvoc_patch_provider_cmds");
  expect(generateFishCompletion()).toContain("__vvoc_patch_provider_cmds");
  expect(generateBashCompletion()).toContain('local commands="stepfun-ai zai openai"');
  expect(generateZshCompletion()).toContain("stepfun-ai zai openai");
  expect(generateFishCompletion()).toContain("echo stepfun-ai zai openai");
});

test("completion scripts - contain preset commands and default preset names", () => {
  expect(generateBashCompletion()).toContain("_vvoc_preset_commands");
  expect(generateBashCompletion()).toContain("_vvoc_preset_names");
  expect(generateZshCompletion()).toContain("_vvoc_preset_cmds");
  expect(generateFishCompletion()).toContain("__vvoc_preset_cmds");
  expect(generateFishCompletion()).toContain("__vvoc_preset_names");
  expect(generateBashCompletion()).toContain("list show vv-openai vv-zai vv-minimax");
  expect(generateZshCompletion()).toContain("vv-openai vv-zai vv-minimax");
});
