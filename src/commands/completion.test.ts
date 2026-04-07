// FILE: src/commands/completion.test.ts
// VERSION: 0.4.2
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-COMPLETION - shell completion generation.
//   SCOPE: Bash, zsh, and fish completion script generation including path-provider presets.
//   DEPENDS: [src/commands/completion.ts]
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
//   LAST_CHANGE: [v0.4.2 - Added assertions for the path-provider top-level command and stepfun-ai preset completions.]
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
  expect(output).toContain("agent");
  expect(output).toContain("completion");
  expect(output).toContain("config");
  expect(output).toContain("path-provider");
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
  expect(output).toContain("agent");
  expect(output).toContain("config");
  expect(output).toContain("path-provider");
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
  expect(output).toContain("agent");
  expect(output).toContain("completion");
  expect(output).toContain("config");
  expect(output).toContain("path-provider");
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
    'local commands="agent completion config doctor guardian init install path-provider plugin status sync upgrade version"',
  );
});

test("generateZshCompletion - contains plugin subcommand", () => {
  const output = generateZshCompletion();
  expect(output).toContain("list");
});

test("generateFishCompletion - handles nested subcommands", () => {
  const output = generateFishCompletion();
  expect(output).toContain("__fish_seen_subcommand_from agent");
  expect(output).toContain("__fish_seen_subcommand_from config");
  expect(output).toContain("__fish_seen_subcommand_from path-provider");
  expect(output).toContain("__fish_seen_subcommand_from plugin");
});

test("generateBashCompletion - contains agent subcommands", () => {
  const output = generateBashCompletion();
  expect(output).toContain("implementer spec-reviewer code-reviewer investitagor");
  expect(output).toContain("_vvoc_agent_action_commands");
});

test("generateZshCompletion - contains agent action commands", () => {
  const output = generateZshCompletion();
  expect(output).toContain(
    "guardian|memory-reviewer|implementer|spec-reviewer|code-reviewer|investitagor",
  );
  expect(output).toContain("set unset");
});

test("completion scripts - contain path-provider presets", () => {
  expect(generateBashCompletion()).toContain("_vvoc_path_provider_presets");
  expect(generateZshCompletion()).toContain("_vvoc_path_provider_cmds");
  expect(generateFishCompletion()).toContain("__vvoc_path_provider_cmds");
  expect(generateBashCompletion()).toContain("stepfun-ai");
});
