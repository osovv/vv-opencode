// FILE: src/commands/completion.ts
// VERSION: 0.4.0
// START_MODULE_CONTRACT
//   PURPOSE: Generate and print shell completion scripts for bash, zsh, and fish.
//   SCOPE: Shell type argument validation, completion script generation, and stdout output.
//   DEPENDS: [citty]
//   LINKS: [M-CLI-COMPLETION, M-CLI-COMMANDS]
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   default - Completion command definition for vvoc.
//   generateBashCompletion - Generate bash completion script.
//   generateZshCompletion - Generate zsh completion script.
//   generateFishCompletion - Generate fish completion script.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v0.4.0 - Initial GRACE implementation for shell completion command.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";

const VVOC_COMMANDS = [
  "agent",
  "config",
  "doctor",
  "guardian",
  "install",
  "plugin",
  "status",
  "sync",
  "upgrade",
  "validate",
  "version",
  "list",
];

export default defineCommand({
  meta: {
    name: "completion",
    description: "Generate shell completion scripts.",
  },
  args: {
    shell: {
      type: "positional",
      required: true,
      description: "Shell type: bash, zsh, or fish.",
    },
  },
  async run({ args }) {
    // START_BLOCK_RUN_COMPLETION
    const shell = String(args.shell).toLowerCase();

    switch (shell) {
      case "bash":
        process.stdout.write(generateBashCompletion());
        break;
      case "zsh":
        process.stdout.write(generateZshCompletion());
        break;
      case "fish":
        process.stdout.write(generateFishCompletion());
        break;
      default:
        console.error("Unsupported shell: " + shell + ". Use bash, zsh, or fish.");
        process.exitCode = 1;
    }
    // END_BLOCK_RUN_COMPLETION
  },
});

export function generateBashCompletion(): string {
  const cmds = VVOC_COMMANDS.join(" ");
  return (
    "# bash completion for vvoc\n" +
    "_vvoc() {\n" +
    "  local cur prev words cword\n" +
    "  _init_completion || return\n" +
    "\n" +
    '  case "${words[0]}" in\n' +
    "    vvoc)\n" +
    "      _vvoc_commands\n" +
    "      ;;\n" +
    "    *)\n" +
    "      ;;\n" +
    "  esac\n" +
    "}\n" +
    "\n" +
    "_vvoc_commands() {\n" +
    '  local commands="' +
    cmds +
    '"\n' +
    '  _completions=($(compgen -W "$commands" -- "$cur"))\n' +
    '  COMPREPLY=("${_completions[@]}")\n' +
    "}\n" +
    "\n" +
    "complete -F _vvoc vvoc\n"
  );
}

export function generateZshCompletion(): string {
  const lines: string[] = [
    "# zsh completion for vvoc",
    "",
    "_vvoc() {",
    "  local -a commands",
    "  commands=(",
  ];

  for (const cmd of VVOC_COMMANDS) {
    lines.push('    "' + cmd + '"');
  }

  lines.push(
    "  )",
    "",
    "  _arguments -C \\",
    '    "-s[shell type]" \\',
    '    "1: :(' + VVOC_COMMANDS.join(" ") + ')" \\',
    '    "*::arg:->args"',
    "",
    "  case $line[1] in",
    "    config)",
    "      _vvoc_config_cmds",
    "      ;;",
    "    plugin)",
    "      _vvoc_plugin_cmds",
    "      ;;",
    "  esac",
    "}",
    "",
    "_vvoc_config_cmds() {",
    "  local -a config_commands",
    "  config_commands=(validate)",
    '  _arguments "1: :(validate)"',
    "}",
    "",
    "_vvoc_plugin_cmds() {",
    "  local -a plugin_commands",
    "  plugin_commands=(list)",
    '  _arguments "1: :(list)"',
    "}",
    "",
    "compdef _vvoc vvoc",
  );

  return lines.join("\n") + "\n";
}

export function generateFishCompletion(): string {
  const lines: string[] = ["# fish completion for vvoc", "", "function __vvoc_commands"];

  for (const cmd of VVOC_COMMANDS) {
    lines.push("  echo " + cmd);
  }

  lines.push(
    "end",
    "",
    "function __vvoc_config_cmds",
    "  echo validate",
    "end",
    "",
    "function __vvoc_plugin_cmds",
    "  echo list",
    "end",
    "",
    'complete -c vvoc -f -a "(__vvoc_commands)"',
    'complete -c vvoc -n "__fish_seen_subcommand_from config" -f -a "(__vvoc_config_cmds)"',
    'complete -c vvoc -n "__fish_seen_subcommand_from plugin" -f -a "(__vvoc_plugin_cmds)"',
  );

  return lines.join("\n") + "\n";
}
