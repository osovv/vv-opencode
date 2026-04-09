// FILE: src/commands/completion.ts
// VERSION: 0.5.8
// START_MODULE_CONTRACT
//   PURPOSE: Auto-detect shell and install vvoc completions idempotently.
//   SCOPE: Shell detection, completion file writing, nested command and preset completion generation for config/plugin/path-provider/preset and the `agent set|unset <target-id>` flow, and rc file patching.
//   DEPENDS: [citty, node:fs/promises, node:path, node:os]
//   LINKS: [M-CLI-COMPLETION, M-CLI-COMMANDS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Completion install command definition for vvoc.
//   detectShell - Detect current shell from SHELL env or process.
//   installBashCompletion - Install bash completions.
//   installZshCompletion - Install zsh completions.
//   installFishCompletion - Install fish completions.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.5.8 - Added OpenCode default and small-model targets to `vvoc agent` shell completions.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { SUPPORTED_MODEL_TARGET_NAMES } from "../lib/agent-models.js";

const VVOC_TOP_LEVEL_COMMANDS = [
  "agent",
  "completion",
  "config",
  "doctor",
  "guardian",
  "init",
  "install",
  "path-provider",
  "preset",
  "plugin",
  "status",
  "sync",
  "upgrade",
  "version",
];

const VVOC_CONFIG_COMMANDS = ["validate"];
const VVOC_PATH_PROVIDER_PRESETS = ["stepfun-ai"];
const VVOC_PRESET_COMMANDS = ["list", "show"];
const VVOC_PRESET_NAMES = ["openai", "zai", "minimax"];
const VVOC_PLUGIN_COMMANDS = ["list"];
const VVOC_AGENT_COMMANDS = ["set", "unset", "list"];
const VVOC_AGENT_TARGETS = [...SUPPORTED_MODEL_TARGET_NAMES];

export default defineCommand({
  meta: {
    name: "completion",
    description: "Install shell completions for vvoc.",
  },
  async run() {
    const shell = detectShell();
    switch (shell) {
      case "bash":
        await installBashCompletion();
        break;
      case "zsh":
        await installZshCompletion();
        break;
      case "fish":
        await installFishCompletion();
        break;
      default:
        console.error("Unsupported shell. Please open an issue.");
        process.exitCode = 1;
    }
  },
});

export function detectShell(): "bash" | "zsh" | "fish" {
  const shellPath = process.env.SHELL ?? "";
  if (shellPath.includes("zsh")) return "zsh";
  if (shellPath.includes("fish")) return "fish";
  return "bash";
}

async function getVvocCompletionsDir(): Promise<string> {
  const configHome = process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config");
  return resolve(configHome, "vvoc");
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
  } catch {}
}

async function hasLine(filePath: string, line: string): Promise<boolean> {
  try {
    const content = await readFile(filePath, "utf8");
    return content.includes(line);
  } catch {
    return false;
  }
}

async function appendIfMissing(filePath: string, line: string): Promise<void> {
  if (!(await hasLine(filePath, line))) {
    await appendFile(filePath, "\n" + line + "\n");
  }
}

async function installBashCompletion(): Promise<void> {
  const completionsDir = await getVvocCompletionsDir();
  await ensureDir(completionsDir);
  const completionFile = resolve(completionsDir, "completions.bash");

  const script = generateBashCompletion();
  await writeFile(completionFile, script, "utf8");

  const rcFile = resolve(homedir(), ".bashrc");
  const sourceLine = `[ -f "${completionFile}" ] && source "${completionFile}"`;
  await appendIfMissing(rcFile, sourceLine);

  console.log(`Bash completions installed to ${completionFile}`);
  console.log(`Added source line to ~/.bashrc`);
}

async function installZshCompletion(): Promise<void> {
  const completionsDir = resolve(homedir(), ".zsh", "completions");
  await ensureDir(completionsDir);

  const completionFile = resolve(completionsDir, "_vvoc");
  const script = generateZshCompletion();
  await writeFile(completionFile, script, "utf8");

  const rcFile = resolve(homedir(), ".zshrc");
  const sourceBlock = [
    "# vvoc zsh completion",
    "if ! (( $+functions[compdef] )); then",
    "  autoload -Uz compinit",
    "  compinit",
    "fi",
    `[ -f "${completionFile}" ] && source "${completionFile}"`,
  ].join("\n");
  await appendIfMissing(rcFile, sourceBlock);

  console.log(`Zsh completions installed to ${completionFile}`);
  console.log(`Added completion loader block to ~/.zshrc`);
}

async function installFishCompletion(): Promise<void> {
  const completionsDir = resolve(homedir(), ".config", "fish", "completions");
  await ensureDir(completionsDir);

  const completionFile = resolve(completionsDir, "vvoc.fish");
  const script = generateFishCompletion();
  await writeFile(completionFile, script, "utf8");

  console.log(`Fish completions installed to ${completionFile}`);
}

export function generateBashCompletion(): string {
  const topLevelCommands = VVOC_TOP_LEVEL_COMMANDS.join(" ");
  const configCommands = VVOC_CONFIG_COMMANDS.join(" ");
  const pathProviderPresets = VVOC_PATH_PROVIDER_PRESETS.join(" ");
  const presetCommands = [...VVOC_PRESET_COMMANDS, ...VVOC_PRESET_NAMES].join(" ");
  const presetNames = VVOC_PRESET_NAMES.join(" ");
  const pluginCommands = VVOC_PLUGIN_COMMANDS.join(" ");
  const agentCommands = VVOC_AGENT_COMMANDS.join(" ");
  const agentTargets = VVOC_AGENT_TARGETS.join(" ");

  return (
    "# bash completion for vvoc\n" +
    "_vvoc() {\n" +
    "  local cur prev words cword\n" +
    "  _init_completion || return\n" +
    "\n" +
    '  case "$cword" in\n' +
    "    1)\n" +
    "      _vvoc_commands\n" +
    "      ;;\n" +
    "    2)\n" +
    '      case "${words[1]}" in\n' +
    "        agent)\n" +
    "          _vvoc_agent_commands\n" +
    "          ;;\n" +
    "        config)\n" +
    "          _vvoc_config_commands\n" +
    "          ;;\n" +
    "        path-provider)\n" +
    "          _vvoc_path_provider_presets\n" +
    "          ;;\n" +
    "        preset)\n" +
    "          _vvoc_preset_commands\n" +
    "          ;;\n" +
    "        plugin)\n" +
    "          _vvoc_plugin_commands\n" +
    "          ;;\n" +
    "      esac\n" +
    "      ;;\n" +
    "    3)\n" +
    '      case "${words[1]}:${words[2]}" in\n' +
    "        agent:set|agent:unset)\n" +
    "          _vvoc_agent_target_commands\n" +
    "          ;;\n" +
    "        preset:show)\n" +
    "          _vvoc_preset_names\n" +
    "          ;;\n" +
    "      esac\n" +
    "      ;;\n" +
    "  esac\n" +
    "}\n" +
    "\n" +
    "_vvoc_commands() {\n" +
    '  local commands="' +
    topLevelCommands +
    '"\n' +
    '  COMPREPLY=($(compgen -W "$commands" -- "$cur"))\n' +
    "}\n" +
    "\n" +
    "_vvoc_config_commands() {\n" +
    '  local commands="' +
    configCommands +
    '"\n' +
    '  COMPREPLY=($(compgen -W "$commands" -- "$cur"))\n' +
    "}\n" +
    "\n" +
    "_vvoc_path_provider_presets() {\n" +
    '  local commands="' +
    pathProviderPresets +
    '"\n' +
    '  COMPREPLY=($(compgen -W "$commands" -- "$cur"))\n' +
    "}\n" +
    "\n" +
    "_vvoc_preset_commands() {\n" +
    '  local commands="' +
    presetCommands +
    '"\n' +
    '  COMPREPLY=($(compgen -W "$commands" -- "$cur"))\n' +
    "}\n" +
    "\n" +
    "_vvoc_preset_names() {\n" +
    '  local commands="' +
    presetNames +
    '"\n' +
    '  COMPREPLY=($(compgen -W "$commands" -- "$cur"))\n' +
    "}\n" +
    "\n" +
    "_vvoc_agent_commands() {\n" +
    '  local commands="' +
    agentCommands +
    '"\n' +
    '  COMPREPLY=($(compgen -W "$commands" -- "$cur"))\n' +
    "}\n" +
    "\n" +
    "_vvoc_agent_target_commands() {\n" +
    '  local commands="' +
    agentTargets +
    '"\n' +
    '  COMPREPLY=($(compgen -W "$commands" -- "$cur"))\n' +
    "}\n" +
    "\n" +
    "_vvoc_plugin_commands() {\n" +
    '  local commands="' +
    pluginCommands +
    '"\n' +
    '  COMPREPLY=($(compgen -W "$commands" -- "$cur"))\n' +
    "}\n" +
    "\n" +
    "complete -F _vvoc vvoc\n"
  );
}

export function generateZshCompletion(): string {
  const lines: string[] = [
    "#compdef vvoc",
    "# zsh completion for vvoc",
    "",
    "_vvoc() {",
    "  local -a commands",
    "  commands=(",
  ];

  for (const cmd of VVOC_TOP_LEVEL_COMMANDS) {
    lines.push('    "' + cmd + '"');
  }

  lines.push(
    "  )",
    "",
    '  _arguments -C "1: :(' + VVOC_TOP_LEVEL_COMMANDS.join(" ") + ')" "*::arg:->args"',
    "",
    "  case $line[1] in",
    "    agent)",
    "      _vvoc_agent_cmds",
    "      ;;",
    "    config)",
    "      _vvoc_config_cmds",
    "      ;;",
    "    path-provider)",
    "      _vvoc_path_provider_cmds",
    "      ;;",
    "    preset)",
    "      _vvoc_preset_cmds",
    "      ;;",
    "    plugin)",
    "      _vvoc_plugin_cmds",
    "      ;;",
    "  esac",
    "}",
    "",
    "_vvoc_config_cmds() {",
    "  local -a config_commands",
    "  config_commands=(" + VVOC_CONFIG_COMMANDS.join(" ") + ")",
    '  _arguments "1: :(' + VVOC_CONFIG_COMMANDS.join(" ") + ')"',
    "}",
    "",
    "_vvoc_path_provider_cmds() {",
    '  _arguments "1: :(' + VVOC_PATH_PROVIDER_PRESETS.join(" ") + ')"',
    "}",
    "",
    "_vvoc_preset_cmds() {",
    "  case $words[2] in",
    "    show)",
    '      _arguments "1: :(' + VVOC_PRESET_NAMES.join(" ") + ')"',
    "      ;;",
    "    *)",
    '      _arguments "1: :(' + [...VVOC_PRESET_COMMANDS, ...VVOC_PRESET_NAMES].join(" ") + ')"',
    "      ;;",
    "  esac",
    "}",
    "",
    "_vvoc_agent_cmds() {",
    "  case $words[2] in",
    "    set|unset)",
    '      _arguments "1: :(' + VVOC_AGENT_TARGETS.join(" ") + ')"',
    "      ;;",
    "    *)",
    '      _arguments "1: :(' + VVOC_AGENT_COMMANDS.join(" ") + ')"',
    "      ;;",
    "  esac",
    "}",
    "",
    "_vvoc_plugin_cmds() {",
    "  local -a plugin_commands",
    "  plugin_commands=(" + VVOC_PLUGIN_COMMANDS.join(" ") + ")",
    '  _arguments "1: :(' + VVOC_PLUGIN_COMMANDS.join(" ") + ')"',
    "}",
    "",
    "compdef _vvoc vvoc",
  );

  return lines.join("\n") + "\n";
}

export function generateFishCompletion(): string {
  const lines: string[] = ["# fish completion for vvoc", "", "function __vvoc_commands"];

  for (const cmd of VVOC_TOP_LEVEL_COMMANDS) {
    lines.push("  echo " + cmd);
  }

  lines.push(
    "end",
    "",
    "function __vvoc_config_cmds",
    "  echo " + VVOC_CONFIG_COMMANDS.join(" "),
    "end",
    "",
    "function __vvoc_path_provider_cmds",
    "  echo " + VVOC_PATH_PROVIDER_PRESETS.join(" "),
    "end",
    "",
    "function __vvoc_preset_cmds",
    "  echo " + [...VVOC_PRESET_COMMANDS, ...VVOC_PRESET_NAMES].join(" "),
    "end",
    "",
    "function __vvoc_preset_names",
    "  echo " + VVOC_PRESET_NAMES.join(" "),
    "end",
    "",
    "function __vvoc_agent_cmds",
    "  echo " + VVOC_AGENT_COMMANDS.join(" "),
    "end",
    "",
    "function __vvoc_agent_target_cmds",
    "  echo " + VVOC_AGENT_TARGETS.join(" "),
    "end",
    "",
    "function __vvoc_plugin_cmds",
    "  echo " + VVOC_PLUGIN_COMMANDS.join(" "),
    "end",
    "",
    'complete -c vvoc -f -a "(__vvoc_commands)"',
    'complete -c vvoc -n "__fish_seen_subcommand_from agent; and not __fish_seen_subcommand_from set unset list" -f -a "(__vvoc_agent_cmds)"',
    'complete -c vvoc -n "__fish_seen_subcommand_from agent; and __fish_seen_subcommand_from set unset" -f -a "(__vvoc_agent_target_cmds)"',
    'complete -c vvoc -n "__fish_seen_subcommand_from config" -f -a "(__vvoc_config_cmds)"',
    'complete -c vvoc -n "__fish_seen_subcommand_from path-provider" -f -a "(__vvoc_path_provider_cmds)"',
    'complete -c vvoc -n "__fish_seen_subcommand_from preset; and not __fish_seen_subcommand_from list show openai zai" -f -a "(__vvoc_preset_cmds)"',
    'complete -c vvoc -n "__fish_seen_subcommand_from preset; and __fish_seen_subcommand_from show" -f -a "(__vvoc_preset_names)"',
    'complete -c vvoc -n "__fish_seen_subcommand_from plugin" -f -a "(__vvoc_plugin_cmds)"',
  );

  return lines.join("\n") + "\n";
}
