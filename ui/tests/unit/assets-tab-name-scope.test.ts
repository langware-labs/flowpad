/**
 * The assets tab is scope-keyed, so its title follows the SCOPE (not the in-tab
 * menu): single project → "<project>'s Assets"; user → "My Assets"; global /
 * all / multi-select → null (the strip then shows the registry "Assets" title).
 * `options` is the dock's scope serialization (`?user=&projects=` / `all=true`).
 */
import { DataManager, TypeId } from '@sdk';
import { allScope, filterScope, projectScope, scopeFilterToDockOptions, userScope } from '@src/lib/scope-filter';
import { describe, expect, it } from 'vitest';

// Project ids are real UUIDs (TypeId rejects non-UUID ids).
const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const PROJECT_NAME = 'Acme';

function dm(): DataManager<any> {
  const d = new DataManager<any>();
  const tid = new TypeId('project', PROJECT_ID);
  d.register_new_entity(tid, { typeId: tid, type: 'project', id: PROJECT_ID, name: PROJECT_NAME });
  return d;
}

// Options are the dock's scope serialization. Build them through the codec
// (`scopeFilterToDockOptions`) from explicit, mode-first ScopeFilters rather
// than hand-writing `scope-*` keys, so the test tracks the codec automatically.
const CASES: Array<{ label: string; options: Record<string, string> | undefined; expected: string | null }> = [
  { label: 'project (cached)', options: scopeFilterToDockOptions(projectScope(PROJECT_ID)), expected: "Acme's Assets" },
  { label: 'project (uncached)', options: scopeFilterToDockOptions(projectScope(OTHER_ID)), expected: 'Assets' },
  { label: 'user', options: scopeFilterToDockOptions(userScope()), expected: 'My Assets' },
  { label: 'global (all)', options: scopeFilterToDockOptions(allScope()), expected: null },
  { label: 'no scope', options: undefined, expected: null },
  { label: 'multi-project', options: scopeFilterToDockOptions(filterScope(false, [PROJECT_ID, OTHER_ID])), expected: null },
];

describe('getTabName — assets title follows scope', () => {
  it.each(CASES)('$label → $expected', ({ options, expected }) => {
    expect(dm().getTabName({ viewType: 'assets', pointer: 'list/skill', options })).toBe(expected);
  });

  it('title is independent of the in-tab sub-pointer', () => {
    const d = dm();
    const opts = scopeFilterToDockOptions(projectScope(PROJECT_ID));
    expect(d.getTabName({ viewType: 'assets', pointer: 'list/skill', options: opts })).toBe("Acme's Assets");
    expect(d.getTabName({ viewType: 'assets', pointer: 'editor/skill/vfs/x', options: opts })).toBe("Acme's Assets");
    expect(d.getTabName({ viewType: 'assets', pointer: '', options: opts })).toBe("Acme's Assets");
  });
});
