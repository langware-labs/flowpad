import { Shell } from '@sdk';

/**
 * Type a command into a real terminal and — when asked — JUDGE WHAT IT PRINTS.
 *
 * `sendInput` is fire-and-forget: it proves bytes reached the PTY, never that
 * the command worked. Asserting on output therefore runs the command through
 * `Shell.runCommand`, which resolves only when the backend's end marker arrives
 * — the one moment we know the command FINISHED — with its exit code and
 * exactly what it printed (never the terminal's echo of the command). `ls`
 * printing "No such file" fails instead of going green.
 *
 * Lives outside the journey because a terminal is not journey-private: the same
 * "run this and check it" is what an agent asks for through `flow terminal`,
 * and both reach the same backend marker grammar (`Shell.sentinel_command`).
 *
 * Deliberately unbounded: no timer races the user's command. A command that
 * never finishes leaves the promise pending (the caller's `signal` is the way
 * out) rather than being declared failed by a clock.
 */

export interface RunInTerminalOptions {
  /** Assert the command's OUTPUT contains this AND that it exited 0. */
  contains?: string;
  /** Aborted when the caller lets go, so a watcher never outlives its owner. */
  signal?: AbortSignal;
}

/**
 * Send `command` to the shell. Without `contains`, resolves true once the bytes
 * are away. With `contains`, resolves only when the command ends: true iff it
 * exited 0 AND printed the needle; false when the caller lets go first.
 */
export async function runInTerminal(
  shellId: string,
  command: string,
  { contains, signal }: RunInTerminalOptions = {},
): Promise<boolean> {
  const shell = await Shell.getById(shellId);
  if (!shell) return false;

  if (!contains) {
    await shell.sendInput(`${command}\r`);
    return true;
  }
  try {
    const { exitCode, output } = await shell.runCommand(command, { signal });
    return exitCode === 0 && output.includes(contains);
  } catch (error) {
    if (signal?.aborted) return false;
    throw error;
  }
}
