import { Shell } from '@sdk';

/**
 * Type a command into a real terminal and — when asked — WATCH WHAT IT PRINTS.
 *
 * `sendInput` is fire-and-forget: it proves bytes reached the PTY, never that
 * the command worked. Asserting on output therefore appends a sentinel
 * (`; echo "<marker>_$?"`), collects the ANSI-stripped line stream via
 * `Shell.onLine`, and decides only once the sentinel line arrives — the one
 * moment we know the command FINISHED. `ls` printing "No such file" fails
 * instead of going green.
 *
 * Lives outside the journey because a terminal is not journey-private: the same
 * "run this and check it" is what an agent asks for through `flow terminal`.
 * Both paths converge one layer down anyway — the browser's `sendInput` and the
 * backend's `Shell.write` resolve the same `compute_node.get_pty(shell_id)`
 * handle and call the same `pty.write`, so agent-typed and journey-typed
 * commands are indistinguishable on screen.
 *
 * Deliberately unbounded: no timer races the user's command. A command that
 * never finishes leaves the promise pending (the caller's `signal` is the way
 * out) rather than being declared failed by a clock.
 */

/** The sentinel grammar. MIRRORED in python — `flow_sdk/builtin/shell.py`'s
 *  terminal-run helper builds the identical string, and a test on each side
 *  pins this literal shape so the two cannot drift apart. */
export const SENTINEL_PREFIX = '__flow_';

export function sentinelMarker(rand: string = Math.random().toString(36).slice(2, 10)): string {
  return `${SENTINEL_PREFIX}${rand}`;
}

export function sentinelCommand(command: string, marker: string): string {
  return `${command}; echo "${marker}_$?"`;
}

/**
 * Type `command` into the shell and STOP — no `\r`, so the line sits at the
 * prompt with the cursor after it and the user presses Enter themselves.
 *
 * The deliberate counterpart to `runInTerminal`, which submits. Use it when
 * Flowpad is proposing a command rather than issuing one: the install
 * one-liner behind "Try auto install" pipes a remote script into a shell, and
 * that is the user's keystroke to make, not ours. It also lets them read and
 * edit the line first, which a submitted command never allows.
 *
 * There is nothing to assert on: no command has run, so this only reports that
 * the bytes reached the PTY.
 */
export async function prefillInTerminal(shellId: string, command: string): Promise<boolean> {
  const shell = await Shell.getById(shellId);
  if (!shell) return false;
  await shell.sendInput(command);
  return true;
}

export interface RunInTerminalOptions {
  /** Assert the command's OUTPUT contains this AND that it exited 0. */
  contains?: string;
  /** Aborted when the caller lets go, so a watcher never outlives its owner. */
  signal?: AbortSignal;
}

/**
 * Send `command` to the shell. Without `contains`, resolves true once the bytes
 * are away. With `contains`, resolves only when the sentinel reports the exit
 * code: true iff exit 0 AND the needle was seen.
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

  const marker = sentinelMarker();
  let seen = false;
  // Register the watchers BEFORE typing (so no output can be missed), but do
  // not await them yet — awaiting first would block the send that produces the
  // very sentinel being waited for, and the run would hang forever.
  const settled = new Promise<boolean>((resolve) => {
    let stop = () => {};
    // The sentinel's own echo carries the marker — ignore those lines so a run
    // can never "pass" by matching the command it just typed.
    const offLine = shell.onLine((line: string) => {
      if (!line.includes(marker) && line.includes(contains)) seen = true;
    });
    const offTrigger = shell.addTrigger({
      label: 'terminal run',
      pattern: new RegExp(`${marker}_(\\d+)`),
      onMatch: (_line: string, m: RegExpMatchArray) => {
        stop();
        resolve(m[1] === '0' && seen);
      },
    });
    // ONE teardown, reached by both endings: the sentinel, and the caller
    // letting go. Without the abort path a hung command would leave these
    // listeners (and this promise) on the PtyConnection for its life.
    stop = () => {
      offTrigger();
      offLine?.();
      signal?.removeEventListener('abort', onAbort);
    };
    function onAbort() {
      stop();
      resolve(false);
    }
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort);
  });
  await shell.sendInput(`${sentinelCommand(command, marker)}\r`);
  return await settled;
}
