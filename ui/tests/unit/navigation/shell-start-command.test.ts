/**
 * The shell dock's "type this when you attach" params.
 *
 * Two spellings, one consumer. `startCommand` is a command Flowpad is CARRYING
 * OUT — typed and submitted. `prefillCommand` is one it is only PROPOSING —
 * typed and left at the prompt, so the user reads it and presses Enter. The
 * install one-liner behind "Try auto install" pipes a remote script into a
 * shell; that Enter is the user's to press, and these pin that the distinction
 * survives the URL rather than living in a component's head.
 *
 * `withoutShellStartCommand` is the other half of the contract: the terminal
 * navigates to it right after typing, so a reload cannot silently re-run a
 * submitted command.
 */
import { describe, expect, it } from 'vitest';
import { DockPointer } from '@src/navigation/DockPointer';

const SHELL = '6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash && export PATH="$HOME/.local/bin:$PATH"';

describe('shell start command', () => {
  it('has nothing to type when neither param is set', () => {
    expect(DockPointer.forShell(SHELL).shellStartCommand).toBeNull();
    expect(DockPointer.forShell(SHELL, { cwd: '/tmp' }).shellStartCommand).toBeNull();
  });

  it('submits a startCommand', () => {
    expect(DockPointer.forShell(SHELL, { startCommand: 'claude --resume x' }).shellStartCommand).toEqual({
      command: 'claude --resume x',
      submit: true,
    });
  });

  it('does NOT submit a prefillCommand', () => {
    expect(DockPointer.forShell(SHELL, { prefillCommand: INSTALL }).shellStartCommand).toEqual({
      command: INSTALL,
      submit: false,
    });
  });

  it('prefers the submitted spelling when a caller sets both', () => {
    // Not a shape any caller should build, but the resolution has to be
    // decided somewhere rather than depending on key order.
    const both = DockPointer.forShell(SHELL, { startCommand: 'run me', prefillCommand: INSTALL });
    expect(both.shellStartCommand).toEqual({ command: 'run me', submit: true });
  });

  it('drops both params once consumed, keeping the rest of the dock', () => {
    const dock = DockPointer.forShell(SHELL, { cwd: '/work', prefillCommand: INSTALL, startCommand: 'run me' });
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
    const url = DockPointer.forShell(SHELL, { prefillCommand: INSTALL }).toUrl('/dock/shell');
    expect(DockPointer.fromUrl(url)?.shellStartCommand).toEqual({ command: INSTALL, submit: false });
  });
});
