// FILE: src/commands/completion.test.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Tests for M-CLI-COMPLETION - shell completion generation.
//   SCOPE: Bash, zsh, and fish completion script generation.
//   DEPENDS: [src/commands/completion.ts]
//   LINKS: [M-CLI-COMPLETION]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   Test suite for completion generation.
// END_MODULE_MAP

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
  expect(output).toContain("config");
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
  expect(output).toContain("plugin");
});

test("generateZshCompletion - valid zsh syntax", () => {
  const output = generateZshCompletion();
  expect(output).toContain("_vvoc()");
  expect(output).toContain("compdef _vvoc vvoc");
});

test("generateFishCompletion - contains vvoc command", () => {
  const output = generateFishCompletion();
  expect(output).toContain("vvoc");
  expect(output).toContain("agent");
  expect(output).toContain("config");
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

test("generateZshCompletion - contains plugin subcommand", () => {
  const output = generateZshCompletion();
  expect(output).toContain("list");
});

test("generateFishCompletion - handles nested subcommands", () => {
  const output = generateFishCompletion();
  expect(output).toContain("__fish_seen_subcommand_from config");
  expect(output).toContain("__fish_seen_subcommand_from plugin");
});
