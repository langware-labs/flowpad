/**
 * Assets is a SINGLE tab per scope. Tab identity (`DockPointer.tabHash`) is the
 * scope filter — project / user / global — NOT the list/folder/editor sub-pointer.
 * This locks the matrix: same scope ⇒ one tab regardless of menu; different scope
 * ⇒ different tab; and the scoped identity survives the toJSON/fromJSON +
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
const USER: ScopeFilter = userScope();

const SCOPES: Array<{ label: string; scope: ScopeFilter; key: string }> = [
  { label: 'global', scope: allScope(), key: 'assets|all' },
  { label: 'user', scope: USER, key: 'assets|user' },
  { label: 'projectA', scope: A, key: `assets|project:${PA}` },
  { label: 'projectB', scope: B, key: `assets|project:${PB}` },
];

describe('assets tabHash = scope (not sub-pointer)', () => {
  it.each(SCOPES)('$label scope → $key', ({ scope, key }) => {
    expect(DockPointer.forAssetList('skill', { scope }).tabHash).toBe(key);
  });

  it('a bare, unscoped /dock/assets is the global tab', () => {
    expect(new DockPointer(ViewType.ASSETS).tabHash).toBe('assets|all');
    expect(DockPointer.forAssetList('skill').tabHash).toBe('assets|all');
  });

  it.each([
    ['list/skill', DockPointer.forAssetList('skill', { scope: A })],
    ['list/agent', DockPointer.forAssetList('agent', { scope: A })],
    ['folder', DockPointer.forAssetFolder('markdown', 'compute_node-@local', 'x').withScopeFilter(A)],
    ['editor', DockPointer.forAssetEditor('skill', '/p/s.md').withScopeFilter(A)],
  ])('same scope, different sub-pointer (%s) ⇒ same tab', (_label, dock) => {
    expect(dock.tabHash).toBe(`assets|project:${PA}`);
  });

  it('different scopes ⇒ different tabs (pairwise)', () => {
    const hashes = SCOPES.map((s) => DockPointer.forAssetList('skill', { scope: s.scope }).tabHash);
    expect(new Set(hashes).size).toBe(SCOPES.length);
  });
});

describe('assets scoped identity survives persistence', () => {
  it.each(SCOPES)('$label round-trips toJSON → fromJSON', ({ scope, key }) => {
    const p = DockPointer.forAssetList('agent', { scope });
    const json = p.toJSON();
    expect(json).not.toBeNull();
    expect(DockPointer.fromJSON(json!)?.tabHash).toBe(key);
  });

  it.each(SCOPES)('$label parity with Tab.dockPointer reconstruction', ({ scope, key }) => {
    const p = DockPointer.forAssetList('markdown', { scope });
    const tab = new Tab({ id: '00000000-0000-4000-8000-000000000001', pointer: p.toJSON() ?? '' });
    expect(tab.dockPointer?.tabHash).toBe(key);
  });

  it('toJSON normalizes the sub-pointer so one scope = one stored row', () => {
    // Two different menu sub-pointers under the SAME scope must serialize to the
    // SAME JSON (the backend mints the Tab id as uuid5 over this string).
    const skill = DockPointer.forAssetList('skill', { scope: A }).toJSON();
    const agent = DockPointer.forAssetList('agent', { scope: A }).toJSON();
    expect(skill).toBe(agent);
    expect(JSON.parse(skill!).pointer).toBe('');
  });
});

describe('regression — non-asset tabHash is unchanged', () => {
  it('content + terminal viewTypes still key by pointer', () => {
    expect(DockPointer.forConversation('c1').tabHash).toBe('conversation|c1');
    expect(new DockPointer(ViewType.SHELL, 'shell-1').tabHash).toBe('shell|shell-1');
  });

  it('non-tab surfaces still have no chip', () => {
    expect(new DockPointer(ViewType.SHELL).tabHash).toBeNull();
    expect(new DockPointer(ViewType.HOME, 'summary').tabHash).toBeNull();
  });
});
