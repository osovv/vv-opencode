// FILE: src/commands/completion.ts
// VERSION: 0.5.0
// START_MODULE_CONTRACT
//   PURPOSE: Auto-detect shell and install vvoc completions idempotently.
//   SCOPE: Shell detection, completion file writing, and rc file patching.
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
//   LAST_CHANGE: [v0.5.0 - Rewrite to auto-install only, detect shell automatically.]
// END_CHANGE_SUMMARY

import { defineCommand } from "citty";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";

const VVOC_COMMANDS = [
  "agent",
  "config",
  "doctor",
  "guardian",
  "init",
  "install",
  "plugin",
  "status",
  "sync",
  "upgrade",
  "validate",
  "version",
];

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
  const fpathLine = `fpath=(~/.zsh/completions $fpath)`;
  await appendIfMissing(rcFile, fpathLine);

  console.log(`Zsh completions installed to ${completionFile}`);
  console.log(`Added fpath line to ~/.zshrc`);
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
