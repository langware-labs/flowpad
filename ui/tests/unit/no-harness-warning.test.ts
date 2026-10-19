import { describe, expect, it } from 'vitest';
import { createNoHarnessWarning, WARNING_IDS } from '@sdk';
import { defaultHarnessUnfunded, isNoHarnessFound } from '@sdk/react/hooks';

const harness = (install: string) => ({ install }) as never;
const record = (...installs: string[]) => ({ harnesses: installs.map(harness) }) as never;

describe('isNoHarnessFound', () => {
  it('fires when the record lists CLIs and none is installed', () => {
    expect(isNoHarnessFound(record('not_installed', 'not_installed', 'not_installed'))).toBe(true);
  });

  it('stays quiet while the boot sweep has not decided (unknown is not missing)', () => {
    expect(isNoHarnessFound(record('not_installed', 'unknown', 'not_installed'))).toBe(false);
    expect(isNoHarnessFound(null)).toBe(false);
  });

  it('stays quiet when at least one CLI is installed', () => {
    expect(isNoHarnessFound(record('installed', 'not_installed', 'not_installed'))).toBe(false);
  });

  it('does not count a built-in harness as a CLI that could be missing', () => {
    expect(isNoHarnessFound(record('not_installed', 'built_in'))).toBe(true);
  });
});

describe('defaultHarnessUnfunded', () => {
  const funding = (installed: boolean, source: unknown, reason = '') =>
    ({ default: { kind: 'harness.claude.cli', installed, source, reason } }) as never;

  it("gives the funding layer's reason when the installed default has no source", () => {
    expect(defaultHarnessUnfunded(funding(true, null, 'claude is signed out'))).toBe('claude is signed out');
  });

  it('is quiet once something funds the default', () => {
    expect(defaultHarnessUnfunded(funding(true, { endpoint_typeid: 'x', name: 'x' }))).toBeNull();
  });

  it('leaves an uninstalled default to the install warning', () => {
    expect(defaultHarnessUnfunded(funding(false, null, 'claude is not installed'))).toBeNull();
  });
});

describe('createNoHarnessWarning', () => {
  it('carries the wiki page and stable id', () => {
    const warning = createNoHarnessWarning();
    expect(warning.id).toBe(WARNING_IDS.NO_HARNESS);
    expect(warning.message).toBe('No harness found');
    expect(warning.wikiPage).toBe('Install a harness');
    expect(warning.onClick).toBeUndefined();
  });
});
