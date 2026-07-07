/**
 * The file explorer is a SINGLE tab per scope, exactly like Assets. Tab identity
 * (`DockPointer.tabHash`) is the scope filter — project / user / global — NOT the
 * folder path sub-pointer, so browsing folders never mints new tabs. This locks
 * the matrix: same scope ⇒ one tab regardless of folder; different scope ⇒
 * different tab; and the scoped identity survives the toJSON/fromJSON +
 * `Tab.dockPointer` round-trip the strip relies on for dedup.
 */
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';
import { allScope, projectScope, userScope, type ScopeFilter } from '@src/lib/scope-filter';
import { Tab } from '@sdk';
import { describe, expect, it } from 'vitest';

// Project ids must be valid UUID v4/v5 — SCOPE_CODEC.decode validates
// `activeProjectId` (entity-id policy) and drops a foreign id, so a non-UUID
// here would silently decode to user scope and collapse the matrix.
const PA = '11111111-1111-4111-8111-111111111111';
const PB = '22222222-2222-4222-8222-222222222222';
const A: ScopeFilter = projectScope(PA);
const B: ScopeFilter = projectScope(PB);

const SCOPES: Array<{ label: string; scope: ScopeFilter; key: string }> = [
  { label: 'global', scope: allScope(), key: 'explorer|all' },
  { label: 'user', scope: userScope(), key: 'explorer|user' },
  { label: 'projectA', scope: A, key: `explorer|project:${PA}` },
  { label: 'projectB', scope: B, key: `explorer|project:${PB}` },
];

describe('explorer tabHash = scope (not folder pointer)', () => {
  it.each(SCOPES)('$label scope → $key', ({ scope, key }) => {
    expect(DockPointer.forExplorer().withScopeFilter(scope).tabHash).toBe(key);
  });

  it('a bare, unscoped /dock/explorer is the global tab', () => {
    expect(new DockPointer(ViewType.EXPLORER).tabHash).toBe('explorer|all');
    expect(DockPointer.forExplorer().tabHash).toBe('explorer|all');
  });

  it.each([
    ['root', DockPointer.forExplorer().withScopeFilter(A)],
    ['folder', DockPointer.forExplorer('compute_node-@local/Users/x/proj').withScopeFilter(A)],
    ['deep folder', DockPointer.forExplorer('compute_node-@local/Users/x/proj/src/sub').withScopeFilter(A)],
  ])('same scope, different folder (%s) ⇒ same tab', (_label, dock) => {
    expect(dock.tabHash).toBe(`explorer|project:${PA}`);
  });

  it('different scopes ⇒ different tabs (pairwise)', () => {
    const hashes = SCOPES.map((s) => DockPointer.forExplorer().withScopeFilter(s.scope).tabHash);
    expect(new Set(hashes).size).toBe(SCOPES.length);
  });
});

describe('explorer scoped identity survives persistence', () => {
  it.each(SCOPES)('$label round-trips toJSON → fromJSON', ({ scope, key }) => {
    const p = DockPointer.forExplorer('compute_node-@local/Users/x/proj').withScopeFilter(scope);
    const json = p.toJSON();
    expect(json).not.toBeNull();
    expect(DockPointer.fromJSON(json!)?.tabHash).toBe(key);
  });

  it.each(SCOPES)('$label parity with Tab.dockPointer reconstruction', ({ scope, key }) => {
    const p = DockPointer.forExplorer().withScopeFilter(scope);
    const tab = new Tab({ id: '00000000-0000-4000-8000-000000000001', pointer: p.toJSON() ?? '' });
    expect(tab.dockPointer?.tabHash).toBe(key);
  });

  it('toJSON normalizes the folder pointer so one scope = one stored row', () => {
    // Two different folder sub-pointers under the SAME scope must serialize to
    // the SAME JSON (the backend mints the Tab id as uuid5 over its tabHash).
    const root = DockPointer.forExplorer().withScopeFilter(A).toJSON();
    const folder = DockPointer.forExplorer('compute_node-@local/Users/x/proj').withScopeFilter(A).toJSON();
    expect(root).toBe(folder);
    expect(JSON.parse(root!).pointer).toBe('');
    expect(JSON.parse(root!).tabHash).toBe(`explorer|project:${PA}`);
  });
});

describe('regression — non-scope-keyed tabHash is unchanged', () => {
  it('content + terminal viewTypes still key by pointer', () => {
    expect(DockPointer.forConversation('c1').tabHash).toBe('conversation|c1');
    expect(new DockPointer(ViewType.SHELL, 'shell-1').tabHash).toBe('shell|shell-1');
  });
});
