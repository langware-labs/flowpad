/**
 * The explorer tab is scope-keyed (like Assets), so its title follows the SCOPE
 * (not the in-tab folder): single project → "<project>'s Files"; user → "My
 * Files"; global / all / multi-select → null (the strip then shows the registry
 * "Files" title). `options` is the dock's scope serialization via the namespaced
 * SCOPE_CODEC (`scope-mode=…` keys, as produced by `scopeFilterToDockOptions`).
 */
import { DataManager, TypeId } from '@sdk';
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

const CASES: Array<{ label: string; options: Record<string, string> | undefined; expected: string | null }> = [
  { label: 'project (cached)', options: { 'scope-mode': 'project', 'scope-activeProjectId': PROJECT_ID }, expected: "Acme's Files" },
  { label: 'project (uncached)', options: { 'scope-mode': 'project', 'scope-activeProjectId': OTHER_ID }, expected: 'Files' },
  { label: 'user', options: { 'scope-mode': 'user' }, expected: 'My Files' },
  { label: 'global (all)', options: { 'scope-mode': 'all' }, expected: null },
  { label: 'no scope', options: undefined, expected: null },
  { label: 'multi-project', options: { 'scope-mode': 'filter', 'scope-user': 'false', 'scope-projects': `${PROJECT_ID},${OTHER_ID}` }, expected: null },
];

describe('getTabName — explorer title follows scope', () => {
  it.each(CASES)('$label → $expected', ({ options, expected }) => {
    expect(dm().getTabName({ viewType: 'explorer', pointer: '', options })).toBe(expected);
  });

  it('title is independent of the in-tab folder pointer', () => {
    const d = dm();
    const opts = { 'scope-mode': 'project', 'scope-activeProjectId': PROJECT_ID };
    expect(d.getTabName({ viewType: 'explorer', pointer: '', options: opts })).toBe("Acme's Files");
    expect(d.getTabName({ viewType: 'explorer', pointer: 'compute_node-@local/Users/x/proj', options: opts })).toBe("Acme's Files");
  });
});
