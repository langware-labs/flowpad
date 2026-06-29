/**
 * Regression for the two reported bugs:
 *   #1 in-assets navigation dropped the scope filter from the URL;
 *   #3 clicking a type opened a NEW tab instead of navigating in place.
 *
 * Root cause: the menu builders (`forAssetList`/`forAssetFolder`/`forAssetEditor`)
 * emit SCOPE-LESS pointers, so without the `navigateAsset` re-stamp the scope is
 * lost (→ tab jumps to global `assets|all`). This pins the chokepoint contract:
 * stamping the current scope keeps every menu click in the SAME scope tab and
 * preserves the scope; switching scope is the only thing that changes the tab.
 */
import { DockPointer } from '@src/navigation/DockPointer';
import { projectScope, type ScopeFilter } from '@src/lib/scope-filter';
import { describe, expect, it } from 'vitest';

// project-scope ids must be valid entity ids (UUID v4/v5); the dock-URL codec
// validates `activeProjectId` on decode (entity-id-policy) and falls back to
// user scope for anything else. Two distinct projects, "A" and "B".
const A_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const A: ScopeFilter = projectScope(A_ID);
const B: ScopeFilter = projectScope(B_ID);

const MENU_BUILDERS: Array<[string, () => DockPointer]> = [
  ['type list', () => DockPointer.forAssetList('agent')],
  ['folder', () => DockPointer.forAssetFolder('markdown', 'compute_node-@local', 'x')],
  ['editor', () => DockPointer.forAssetEditor('skill', '/p/s.md')],
];

describe('navigateAsset scope contract', () => {
  it.each(MENU_BUILDERS)('%s: a raw menu pointer is scope-less → global (the bug)', (_label, build) => {
    // Without the re-stamp, the freshly built pointer carries no scope and falls
    // back to the global tab — exactly the dropped-scope / extra-tab symptom.
    expect(build().tabHash).toBe('assets|all');
  });

  it.each(MENU_BUILDERS)('%s: stamping the current scope keeps the same scope tab', (_label, build) => {
    const stamped = build().withScopeFilter(A);
    expect(stamped.tabHash).toBe(`assets|project:${A_ID}`); // same tab as every other menu under scope A
    expect(stamped.scopeFilter).toEqual(A); // scope preserved in the URL
  });

  it('switching scope is the only action that changes the tab', () => {
    expect(DockPointer.forAssetList('agent').withScopeFilter(B).tabHash).toBe(`assets|project:${B_ID}`);
    expect(DockPointer.forAssetList('skill').withScopeFilter(A).tabHash).not.toBe(
      DockPointer.forAssetList('skill').withScopeFilter(B).tabHash,
    );
  });
});
