import { Shell } from '@sdk';
import { describe, expect, it } from 'vitest';
import {
  allowRename,
  cleanTitle,
  isProgramIdentityTitle,
  nextTerminalName,
  shouldAutoSaveTitleForTarget,
} from '@src/components/terminal/rename-rules';

/**
 * Pure-function unit tests for the PTY title rename rules. These gate what a
 * live OSC terminal title is allowed to overwrite a durable tab name with —
 * decoration (spinners/emoji/ANSI) must be stripped, and non-title noise
 * (letter-less strings, entity typeids, the generic "Claude Code" banner) must
 * be rejected so it never becomes the persisted name.
 */

describe('cleanTitle', () => {
  it('returns "" for null / undefined / empty', () => {
    expect(cleanTitle(null)).toBe('');
    expect(cleanTitle(undefined)).toBe('');
    expect(cleanTitle('')).toBe('');
  });

  it('strips ANSI CSI escape sequences', () => {
    expect(cleanTitle('\x1b[32mBuild\x1b[0m')).toBe('Build');
    expect(cleanTitle('\x1b[1;31mError\x1b[0m here')).toBe('Error here');
  });

  it('strips C0/C1 control bytes (BEL, NUL, CR/LF)', () => {
    expect(cleanTitle('he\x07llo')).toBe('hello');
    expect(cleanTitle('a\x00b\x1fc')).toBe('abc');
    expect(cleanTitle('line\r\none')).toBe('lineone');
    expect(cleanTitle('c1\x85tail')).toBe('c1tail');
  });

  it('strips Braille spinner frames', () => {
    expect(cleanTitle('⠋ Building')).toBe('Building');
    expect(cleanTitle('⠙⠹⠸ Working')).toBe('Working');
  });

  it('strips emoji, icons and the emoji variation selector', () => {
    expect(cleanTitle('🚀 Deploy')).toBe('Deploy');
    expect(cleanTitle('Deploy ✅')).toBe('Deploy');
    expect(cleanTitle('warn️ sign')).toBe('warn sign');
  });

  it('strips arrows / rotations / box-drawing glyphs', () => {
    expect(cleanTitle('→ next step')).toBe('next step');
    expect(cleanTitle('─── Title ───')).toBe('Title');
  });

  it('collapses whitespace and trims', () => {
    expect(cleanTitle('  a   b  ')).toBe('a b');
  });

  it('is script-agnostic: keeps letters in non-Latin scripts', () => {
    // symbols only around real letters are removed; the letters survive
    expect(cleanTitle('🚀 日本語')).toBe('日本語');
    expect(cleanTitle('⠋ مرحبا')).toBe('مرحبا');
  });
});

describe('allowRename', () => {
  it('accepts a normal title carrying a real letter', () => {
    expect(allowRename('My Task')).toBe(true);
    expect(allowRename('\x1b[32m日本語\x1b[0m')).toBe(true);
  });

  it('rejects empty / whitespace-only (after cleaning)', () => {
    expect(allowRename('')).toBe(false);
    expect(allowRename('   ')).toBe(false);
    expect(allowRename(null)).toBe(false);
    expect(allowRename(undefined)).toBe(false);
  });

  it('rejects letter-less titles (the \\p{L} gate)', () => {
    expect(allowRename('12345')).toBe(false);
    expect(allowRename('!!! ...')).toBe(false);
    expect(allowRename('⠋⠙⠹')).toBe(false); // spinner-only → cleaned to ""
    expect(allowRename('🚀')).toBe(false); // emoji-only → cleaned to ""
  });

  it('rejects an entity TypeId string', () => {
    expect(allowRename('shell-0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d')).toBe(false);
  });

  it('rejects the generic "Claude Code" banner', () => {
    expect(allowRename('Claude Code')).toBe(false);
    expect(allowRename('Claude Code — my repo')).toBe(false);
  });
});

describe('isProgramIdentityTitle', () => {
  const claude = { worker_type: 'claude' } as any;

  it("rejects the worker's own startup title (case/decoration-insensitive)", () => {
    expect(isProgramIdentityTitle('claude', claude)).toBe(true);
    expect(isProgramIdentityTitle('Claude', claude)).toBe(true);
    expect(isProgramIdentityTitle('claude.exe', claude)).toBe(true);
    expect(isProgramIdentityTitle('✳ claude', claude)).toBe(true); // spinner variant
  });

  it('rejects the OS default console title (exe path) even with no process', () => {
    expect(isProgramIdentityTitle('C:\\WINDOWS\\system32\\cmd.exe ')).toBe(true);
    expect(isProgramIdentityTitle('c:/users/me/.local/bin/claude.exe', claude)).toBe(true);
  });

  it('lets topic titles through, including ones mentioning the worker', () => {
    expect(isProgramIdentityTitle('Fix expired invitation returning HTTP 500', claude)).toBe(false);
    expect(isProgramIdentityTitle('✳ Fix Windows crash-loop on Claude resume', claude)).toBe(false);
  });

  it('does not treat unix cwd-style titles as identity (shells title with cwd)', () => {
    expect(isProgramIdentityTitle('/home/me/projects/flowpad')).toBe(false);
    expect(isProgramIdentityTitle('me@host: ~/projects')).toBe(false);
  });

  it("only matches the process's OWN worker name", () => {
    expect(isProgramIdentityTitle('claude', { worker_type: 'codex' } as any)).toBe(false);
    expect(isProgramIdentityTitle('claude')).toBe(false); // plain shell: no worker identity
  });
});

describe('nextTerminalName', () => {
  it('starts at "Tab 1" for no sessions', () => {
    expect(nextTerminalName([])).toBe('Tab 1');
  });

  it('increments past the highest contiguous "Tab N"', () => {
    expect(nextTerminalName([{ name: 'Tab 1' }])).toBe('Tab 2');
    expect(nextTerminalName([{ name: 'Tab 1' }, { name: 'Tab 2' }])).toBe('Tab 3');
  });

  it('fills the lowest free gap left by a closed tab', () => {
    expect(nextTerminalName([{ name: 'Tab 2' }])).toBe('Tab 1');
    expect(nextTerminalName([{ name: 'Tab 1' }, { name: 'Tab 3' }])).toBe('Tab 2');
  });

  it('ignores names that are not of the "Tab N" shape', () => {
    expect(nextTerminalName([{ name: 'Custom' }, { name: 'Tab 1' }])).toBe('Tab 2');
  });
});

describe('shouldAutoSaveTitleForTarget', () => {
  it('auto-titles a plain shell (no process) but nothing else', () => {
    expect(shouldAutoSaveTitleForTarget(Shell.type)).toBe(true);
    expect(shouldAutoSaveTitleForTarget('markdown')).toBe(false);
    expect(shouldAutoSaveTitleForTarget(null)).toBe(false);
  });

  it('auto-titles a claude process but not codex/copilot (unstable titles)', () => {
    expect(shouldAutoSaveTitleForTarget(Shell.type, { worker_type: 'claude' } as any)).toBe(true);
    expect(shouldAutoSaveTitleForTarget(Shell.type, { worker_type: 'codex' } as any)).toBe(false);
    expect(shouldAutoSaveTitleForTarget(Shell.type, { worker_type: 'Copilot' } as any)).toBe(false);
  });
});
