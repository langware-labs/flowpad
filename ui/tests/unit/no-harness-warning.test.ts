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
  const rec = (install: string) =>
    ({ default_harness: 'harness.claude.cli', harnesses: [{ kind: 'harness.claude.cli', install }] }) as never;

  it("gives the funding layer's reason when the installed default has no source", () => {
    const funding = { resolved: {}, blocked: { 'harness.claude.cli': 'claude is signed out' } } as never;
    expect(defaultHarnessUnfunded(rec('installed'), funding)).toBe('claude is signed out');
  });

  it('is quiet once something funds the default', () => {
    const funding = { resolved: { 'harness.claude.cli': { endpoint_typeid: 'x', name: 'x' } }, blocked: {} } as never;
    expect(defaultHarnessUnfunded(rec('installed'), funding)).toBeNull();
  });

  it('leaves an uninstalled default to the install warning', () => {
    expect(defaultHarnessUnfunded(rec('not_installed'), { resolved: {}, blocked: {} } as never)).toBeNull();
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
