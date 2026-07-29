/**
 * runInTerminal — type a command into a real terminal and judge its output.
 *
 * The sentinel is the whole point: writing to a PTY proves bytes were
 * delivered, never that the command worked. These drive the assertion path by
 * feeding synthetic chunks into the PtyConnection line stream (the
 * `pty_line_triggers` pattern) — no backend, no WebSocket, no real PTY.
 *
 * This is the seam a guided journey's `run` act and an agent's
 * `flow terminal run` both sit on, so it is tested once, here.
 */

import { Shell } from '@sdk';
import { PtyConnection } from '@sdk/services/shell/ptyConnection';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runInTerminal,
  sentinelCommand,
  SENTINEL_PREFIX,
} from '@src/terminal/run-in-terminal';

function b64(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64');
}

/** A Shell whose PTY is a local, hand-fed connection. */
function makeShell(): { shell: Shell; pty: PtyConnection; sent: string[] } {
  const pty = new PtyConnection('test-shell', 'test-node');
  (pty as unknown as { _attached: boolean })._attached = true;

  const sent: string[] = [];
  const shell = {
    onLine: (fn: (l: string) => void) => pty.onLine(fn),
    addTrigger: (t: Parameters<PtyConnection['addTrigger']>[0]) => pty.addTrigger(t),
    sendInput: (data: string) => {
      sent.push(data);
      return Promise.resolve();
    },
  } as unknown as Shell;

  vi.spyOn(Shell, 'getById').mockResolvedValue(shell);
  return { shell, pty, sent };
}

/** The marker the implementation minted, read back off what it typed. */
function markerFrom(sent: string[]): string {
  const m = new RegExp(`${SENTINEL_PREFIX}[a-z0-9]+`).exec(sent.join(''));
  if (!m) throw new Error(`no sentinel marker in: ${sent.join('')}`);
  return m[0];
}

beforeEach(() => vi.restoreAllMocks());

describe('runInTerminal', () => {
  it('sends the bare command and resolves when nothing is asserted', async () => {
    const { sent } = makeShell();

    await expect(runInTerminal('sh1', 'ls -la')).resolves.toBe(true);

    expect(sent).toEqual(['ls -la\r']);
  });

  it('passes when the needle appears AND the command exits 0', async () => {
    const { pty, sent } = makeShell();
    const p = runInTerminal('sh1', 'ls', { contains: 'AGENTS.md' });
    await vi.waitFor(() => expect(sent.length).toBe(1));

    const marker = markerFrom(sent);
    pty.appendOutput(b64('AGENTS.md\n'));
    pty.appendOutput(b64(`${marker}_0\n`));

    await expect(p).resolves.toBe(true);
    expect(sent[0]).toBe(`${sentinelCommand('ls', marker)}\r`);
  });

  it('fails when the command exits non-zero even if the needle appeared', async () => {
    const { pty, sent } = makeShell();
    const p = runInTerminal('sh1', 'ls missing', { contains: 'AGENTS.md' });
    await vi.waitFor(() => expect(sent.length).toBe(1));

    const marker = markerFrom(sent);
    pty.appendOutput(b64('AGENTS.md\n'));
    pty.appendOutput(b64(`${marker}_2\n`));

    await expect(p).resolves.toBe(false);
  });

  it('fails when the needle never appears', async () => {
    const { pty, sent } = makeShell();
    const p = runInTerminal('sh1', 'ls', { contains: 'AGENTS.md' });
    await vi.waitFor(() => expect(sent.length).toBe(1));

    pty.appendOutput(b64(`${markerFrom(sent)}_0\n`));

    await expect(p).resolves.toBe(false);
  });

  it('does not pass on the ECHO of its own command', async () => {
    // The terminal echoes what was typed — and what was typed contains the
    // needle. Only lines WITHOUT the marker may satisfy the assertion, or
    // every run would trivially self-pass.
    const { pty, sent } = makeShell();
    const p = runInTerminal('sh1', 'grep AGENTS.md', { contains: 'AGENTS.md' });
    await vi.waitFor(() => expect(sent.length).toBe(1));

    const marker = markerFrom(sent);
    pty.appendOutput(b64(`${sentinelCommand('grep AGENTS.md', marker)}\n`));
    pty.appendOutput(b64(`${marker}_0\n`));

    await expect(p).resolves.toBe(false);
  });

  it('lets go when the caller aborts, leaving no listeners behind', async () => {
    const { pty, sent } = makeShell();
    const ac = new AbortController();
    const p = runInTerminal('sh1', 'sleep 999', { contains: 'never', signal: ac.signal });
    await vi.waitFor(() => expect(sent.length).toBe(1));

    ac.abort();
    await expect(p).resolves.toBe(false);

    // A late chunk must not resolve an already-abandoned run.
    pty.appendOutput(b64(`${markerFrom(sent)}_0\n`));
  });

  it('returns false for a shell that no longer exists', async () => {
    vi.spyOn(Shell, 'getById').mockResolvedValue(null);
    await expect(runInTerminal('gone', 'ls')).resolves.toBe(false);
  });
});

describe('sentinel grammar', () => {
  it('is the literal shape python mirrors', () => {
    // MIRROR of `Shell.SENTINEL_PREFIX` / `Shell.sentinel_command` in
    // flow_sdk/builtin/shell.py — pinned on both sides so they cannot drift.
    expect(SENTINEL_PREFIX).toBe('__flow_');
    expect(sentinelCommand('ls -la', '__flow_abc123')).toBe('ls -la; echo "__flow_abc123_$?"');
  });
});
