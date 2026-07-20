import { describe, expect, it } from 'vitest';
import { createNoHarnessWarning, WARNING_IDS } from '@sdk';
import { isNoHarnessFound } from '@sdk/react/hooks';

const snap = (checked: boolean, available: boolean) => ({ checked, available });

describe('isNoHarnessFound', () => {
  it('fires when every harness is checked and none is available', () => {
    expect(isNoHarnessFound([snap(true, false), snap(true, false), snap(true, false)])).toBe(true);
  });

  it('stays quiet while any harness is still unchecked (startup discovery window)', () => {
    expect(isNoHarnessFound([snap(true, false), snap(false, false), snap(true, false)])).toBe(false);
    expect(isNoHarnessFound([snap(false, false), snap(false, false), snap(false, false)])).toBe(false);
  });

  it('stays quiet when at least one harness is available', () => {
    expect(isNoHarnessFound([snap(true, true), snap(true, false), snap(true, false)])).toBe(false);
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
