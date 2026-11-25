// FILE: src/commands/registered-cli.test-helpers.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Launch the registered CLI in bounded, retried subprocesses for colocated command tests.
//   SCOPE: Shared Bun.spawn wrapping with a per-attempt kill timeout, one stall retry, piped output capture, and the documented per-test budget constant; no command logic and no assertions.
//   DEPENDS: [node:url]
//   LINKS: [M-CLI-GUARDIAN, M-CLI-PRESET]
//   ROLE: TEST
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   REGISTERED_CLI_PATH - Registered CLI entrypoint resolved relative to this directory.
//   REGISTERED_CLI_SPAWN_TIMEOUT_MS - Per-attempt kill timeout applied to every registered-CLI spawn.
//   REGISTERED_CLI_SPAWN_ATTEMPTS - Attempt budget per launch, absorbing one stalled spawn.
//   REGISTERED_CLI_TEST_TIMEOUT_MS - Documented per-test budget for tests that launch the registered CLI.
//   RegisteredCliResult - Piped output and natural exit code of one bounded launch.
//   RegisteredCliOptions - Working directory for one bounded launch.
//   runRegisteredCli - Launch the registered CLI in a bounded, retried subprocess and capture its output.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Introduced the shared bounded, retried registered-CLI spawn helper so command tests no longer hold unbounded Bun.spawn calls.]
// END_CHANGE_SUMMARY

import { fileURLToPath } from "node:url";

export const REGISTERED_CLI_PATH = fileURLToPath(new URL("../cli.ts", import.meta.url));

// Registered-CLI subprocesses occasionally stall far past their healthy runtime under a full
// parallel `bun run check` (healthy launches finish in well under a second). Each attempt is
// bounded by Bun.spawn's own kill timeout, and one clean retry absorbs the stall; natural exit
// codes — including expected failures — pass through to the test assertions untouched.
export const REGISTERED_CLI_SPAWN_TIMEOUT_MS = 15_000;
export const REGISTERED_CLI_SPAWN_ATTEMPTS = 2;

// Per-test budget for tests that launch the registered CLI: two sequential launches, each up to
// two bounded attempts, plus Bun's own boot overhead under load. The healthy path stays far
// below this cap; the ceiling only bounds a worst-case stall sequence.
export const REGISTERED_CLI_TEST_TIMEOUT_MS =
  REGISTERED_CLI_SPAWN_TIMEOUT_MS * REGISTERED_CLI_SPAWN_ATTEMPTS * 2;

export type RegisteredCliResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type RegisteredCliOptions = {
  cwd: string;
};

export async function runRegisteredCli(
  args: readonly string[],
  options: RegisteredCliOptions,
): Promise<RegisteredCliResult> {
  let lastFailure = "";
  for (let attempt = 1; attempt <= REGISTERED_CLI_SPAWN_ATTEMPTS; attempt += 1) {
    const command = Bun.spawn({
      cmd: [process.execPath, "run", REGISTERED_CLI_PATH, ...args],
      cwd: options.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: REGISTERED_CLI_SPAWN_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
    ]);
    await command.exited;
    const { exitCode, signalCode } = command;
    if (signalCode === null && exitCode !== null) {
      return { stdout, stderr, exitCode };
    }
    lastFailure = `signalCode=${signalCode} exitCode=${exitCode} stdout: ${stdout} stderr: ${stderr}`;
  }
  throw new Error(
    `registered CLI did not exit within ${REGISTERED_CLI_SPAWN_TIMEOUT_MS}ms in ${REGISTERED_CLI_SPAWN_ATTEMPTS} attempts; last attempt: ${lastFailure}`,
  );
}
