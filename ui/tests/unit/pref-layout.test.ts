import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getSurfacedPrefInfos, PREF_GROUPS, resolvePreferencesPointer } from '@sdk';

describe('Preferences layout', () => {
  it('places every surfaced pref in exactly one tab, and no tab is empty', () => {
    const placed = PREF_GROUPS.flatMap((g) => g.tabs).flatMap((t) => t.keys);
    expect([...placed].sort()).toEqual(getSurfacedPrefInfos().map((i) => i.key).sort());
    for (const tab of PREF_GROUPS.flatMap((g) => g.tabs)) {
      expect(tab.keys.length > 0 || !!tab.custom).toBe(true);
    }
  });

  it('names the same tabs, in order, as PREFERENCE_TABS (smart navigation)', () => {
    const py = readFileSync(resolve(__dirname, '../../../flow_sdk/core/dock_address.py'), 'utf8');
    const block = py.slice(py.indexOf('PREFERENCE_TABS:'), py.indexOf('\n)\n', py.indexOf('PREFERENCE_TABS:')));
    const pointers = [...block.matchAll(/^\s+\(?\s*"([a-z-]+\/[a-z-]+)",/gm)].map((m) => m[1]);
    expect(pointers).toEqual(PREF_GROUPS.flatMap((g) => g.tabs.map((t) => `${g.id}/${t.id}`)));
  });

  it.each([
    ['developer/trace-logging', 'developer/trace-logging'],
    ['developer', 'developer/trace-logging'],
    ['advanced', 'developer/smart-navigation'],
    ['appearance', 'general/appearance'],
    ['nonsense', 'general/appearance'],
    [undefined, 'general/appearance'],
  ])('pointer %s opens %s', (pointer, expected) => {
    expect(resolvePreferencesPointer(pointer).pointer).toBe(expected);
  });
});
