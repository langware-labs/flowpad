/**
 * Shell.runCommand + runInTerminal — type a command into a real terminal and know how it ended.
 *
 * The end marker is the whole point: writing to a PTY proves bytes were delivered, never that
 * the command worked. The backend wraps the command in invisible OSC 7770 markers (start, end +
 * exit code — `Shell.sentinel_command`); these tests feed that byte stream into a real Shell's
 * PtyConnection — only the HTTP `run-command` answer is stood in for (no backend, no PTY).
 *
 * This is the seam the snippet viewer's Run, a guided journey's `run` act and an agent's
 * `flow terminal run` all sit on, so it is tested once, here.
 */

import { Shell } from '@sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runInTerminal } from '@src/terminal/run-in-terminal';

const MARKER = '__flow_abc12345';
const START = `\x1b]7770;${MARKER};s\x07`;
const end = (code: number) => `\x1b]7770;${MARKER};${code}\x07`;
const ECHO = `{ printf '\\033]7770;${MARKER};s\\007'; grep AGENTS.md } always { printf '\\033]7770;${MARKER};%d\\007' $? }\r\n`;

function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}

/** A real Shell whose `run-command` answer is stood in for; `feed` is what the PTY prints. */
function makeShell(printed: (feed: (s: string) => void) => void, { before = false } = {}) {
  const shell = new Shell({ id: crypto.randomUUID(), compute_node_id: crypto.randomUUID() });
  const feed = (s: string) => shell.ptyConnection.appendOutput(b64(s));
  const posted: Array<[string, unknown]> = [];
  vi.spyOn(shell as unknown as { post: (a: string, b: unknown) => Promise<unknown> }, 'post').mockImplementation(
    async (action: string, body: unknown) => {
      posted.push([action, body]);
      if (action !== 'run-command') return { stopped: true };
      if (before) printed(feed); // the command ended before its answer came back
      else setTimeout(() => printed(feed), 0);
      return { marker: MARKER, osc: 7770 };
    },
  );
  vi.spyOn(Shell, 'getById').mockResolvedValue(shell);
  return { shell, feed, posted };
}

beforeEach(() => vi.restoreAllMocks());

describe('Shell.runCommand', () => {
  it('resolves with the exit code and exactly what the command printed — never its echo', async () => {
    const { shell, posted } = makeShell((feed) => feed(`${ECHO}${START}AGENTS.md\r\n${end(0)}prompt % `));
    const result = await shell.runCommand('grep AGENTS.md');
    expect(posted).toEqual([['run-command', { command: 'grep AGENTS.md' }]]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('AGENTS.md\r\n');
  });

  it('reads the end even when it arrives before the answer that names it', async () => {
    const { shell } = makeShell((feed) => feed(`${START}fast\r\n${end(3)}`), { before: true });
    await expect(shell.runCommand('echo fast; (exit 3)')).resolves.toMatchObject({ exitCode: 3, output: 'fast\r\n' });
  });

  it('reads a marker split across chunks', async () => {
    const { shell } = makeShell((feed) => {
      const all = `${START}out\r\n${end(130)}`;
      for (const piece of [all.slice(0, 5), all.slice(5, 20), all.slice(20, all.length - 3), all.slice(-3)]) feed(piece);
    });
    await expect(shell.runCommand('sleep 30')).resolves.toMatchObject({ exitCode: 130, output: 'out\r\n' });
  });

  it('a stop during a run names the run by its marker; outside a run it names none', async () => {
    const { shell, posted, feed } = makeShell(() => undefined);
    const run = shell.runCommand('sleep 30');
    await vi.waitFor(() => expect(posted.some(([a]) => a === 'run-command')).toBe(true));
    await shell.interrupt();
    expect(posted.at(-1)).toEqual(['interrupt', { marker: MARKER }]);
    feed(`${START}${end(130)}`);
    await run;
    await shell.interrupt();
    expect(posted.at(-1)).toEqual(['interrupt', {}]);
  });

  it('lets go of the wait when the caller aborts, and a late end changes nothing', async () => {
    const { shell, feed } = makeShell(() => undefined);
    const ac = new AbortController();
    const run = shell.runCommand('sleep 999', { signal: ac.signal });
    await vi.waitFor(() => expect((shell as unknown as { post: unknown }).post).toHaveBeenCalled());
    ac.abort();
    await expect(run).rejects.toThrow();
    feed(`${START}${end(0)}`);
  });
});

describe('runInTerminal', () => {
  it('sends the bare command and resolves when nothing is asserted', async () => {
    const { shell } = makeShell(() => undefined);
    const sent: string[] = [];
    vi.spyOn(shell, 'sendInput').mockImplementation(async (d: string) => void sent.push(d));
    await expect(runInTerminal('sh1', 'ls -la')).resolves.toBe(true);
    expect(sent).toEqual(['ls -la\r']);
  });

  it('passes when the needle is printed AND the command exits 0', async () => {
    makeShell((feed) => feed(`${ECHO}${START}AGENTS.md\r\n${end(0)}`));
    await expect(runInTerminal('sh1', 'grep AGENTS.md', { contains: 'AGENTS.md' })).resolves.toBe(true);
  });

  it('fails when the command exits non-zero even if the needle was printed', async () => {
    makeShell((feed) => feed(`${START}AGENTS.md\r\n${end(2)}`));
    await expect(runInTerminal('sh1', 'ls missing', { contains: 'AGENTS.md' })).resolves.toBe(false);
  });

  it('does not pass on the ECHO of its own command', async () => {
    // What was typed contains the needle; the terminal echoes it before the start marker.
    makeShell((feed) => feed(`${ECHO}${START}${end(0)}`));
    await expect(runInTerminal('sh1', 'grep AGENTS.md', { contains: 'AGENTS.md' })).resolves.toBe(false);
  });

  it('answers false when the caller aborts', async () => {
    makeShell(() => undefined);
    const ac = new AbortController();
    const run = runInTerminal('sh1', 'sleep 999', { contains: 'never', signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    await expect(run).resolves.toBe(false);
  });

  it('returns false for a shell that no longer exists', async () => {
    vi.spyOn(Shell, 'getById').mockResolvedValue(null);
    await expect(runInTerminal('gone', 'ls')).resolves.toBe(false);
  });
});
