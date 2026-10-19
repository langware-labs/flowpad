/**
 * The shell dock's "run this when you attach" param, `startCommand`.
 *
 * `withoutShellStartCommand` is the other half of the contract: the terminal
 * navigates to it right after typing, so a reload cannot silently re-run a
 * submitted command.
 */
import { describe, expect, it } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

const SHELL = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash && export PATH="$HOME/.local/bin:$PATH"';

describe('shell start command', () => {
  it('has nothing to type when the param is not set', () => {
    expect(DockPointer.forShell(SHELL).shellStartCommand).toBeNull();
    expect(DockPointer.forShell(SHELL, { cwd: '/tmp' }).shellStartCommand).toBeNull();
  });

  it('reads a startCommand', () => {
    expect(DockPointer.forShell(SHELL, { startCommand: 'claude --resume x' }).shellStartCommand).toBe(
      'claude --resume x',
    );
  });

  it('drops the param once consumed, keeping the rest of the dock', () => {
    const dock = DockPointer.forShell(SHELL, { cwd: '/work', startCommand: 'run me' });
    const after = dock.withoutShellStartCommand();

    expect(after.shellStartCommand).toBeNull();
    expect(after.pointer).toBe(SHELL);
    expect(after.options?.cwd).toBe('/work');
    // The original is untouched — DockPointer is a value, and the effect that
    // reads the command still holds it while the navigation commits.
    expect(dock.shellStartCommand).not.toBeNull();
  });

  it('carries a command through the URL verbatim', () => {
    // The install line is shell syntax: pipes, &&, $, quotes. One mangled
    // character is a different command, and it is about to be typed at a prompt.
    const url = DockPointer.forShell(SHELL, { startCommand: INSTALL }).toUrl('/dock/shell');
    expect(DockPointer.fromUrl(url)?.shellStartCommand).toBe(INSTALL);
  });

  describe('shellId', () => {
    // The bug this exists to prevent: `Shell.dockPointer` spells a shell as its
    // TypeId (`shell-<uuid>`), while tabs and the PTY transport hold the bare
    // uuid. The typed-command effect compared the two raw, never matched, and
    // did nothing at all — a feature that looked shipped and was inert.
    it('strips the TypeId prefix so it matches a bare session id', () => {
      expect(new DockPointer(ViewType.SHELL, `shell-${SHELL}`).shellId).toBe(SHELL);
    });

    it('accepts a pointer that is already bare', () => {
      expect(DockPointer.forShell(SHELL).shellId).toBe(SHELL);
    });

    it('is null for a process dock, which is not a shell id at all', () => {
      const process = new DockPointer(ViewType.SHELL, 'agentic_process-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02');
      expect(process.shellId).toBeNull();
    });

    it('is null when the dock addresses no shell', () => {
      expect(new DockPointer(ViewType.SHELL).shellId).toBeNull();
      expect(DockPointer.forTab(ViewType.HOME).shellId).toBeNull();
    });
  });
});
