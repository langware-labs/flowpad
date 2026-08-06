/**
 * The address bar's crumb resolution.
 *
 * Two contracts carry the weight here:
 *   1. the bar paints something useful on the FIRST frame — it must never block
 *      on the network to say where you are;
 *   2. a navigation mid-resolution can never let the previous page's ancestors
 *      land in the new page's address.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ctx = vi.hoisted(() => ({
  project: { displayName: 'Acme', id: 'p1' } as unknown,
  activeEntity: null as unknown,
  activeEntityTypeId: null as unknown,
}));
vi.mock('@src/hooks/useContext', () => ({ useContext: () => ctx }));
vi.mock('@src/tabs/all-tabs-store', () => ({ getAllTabsSnapshot: () => [] }));

import { Tab, TypeId } from '@sdk';
import * as ancestors from '@src/navigation/entity-ancestors';
import { useEntityBreadcrumbs } from '@src/components/top-nav-bar/use-entity-breadcrumbs';

const DOC = new TypeId('markdown', '11111111-1111-4111-8111-111111111111');
const FOLDER = new TypeId('markdown', '22222222-2222-4222-8222-222222222222');

/**
 * Minimal DockPointer stand-in.
 *
 * `pointer` is what identifies the addressed content — deliberately NOT
 * `tabHash`, which identifies the TAB and is shared by everything opened inside
 * it (every document in the assets tab has the hash `assets|project:<id>`).
 */
function dock(pointer: string, targetTypeId: TypeId | null = DOC) {
  return { pointer, tabHash: 'tab-1', targetTypeId, viewType: 'editor', options: {} } as never;
}

/** A promise we resolve by hand, to hold Phase 1 open. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  ctx.project = { displayName: 'Acme', id: 'p1' };
  ctx.activeEntity = null;
  ctx.activeEntityTypeId = null;
});
afterEach(() => vi.restoreAllMocks());

describe('useEntityBreadcrumbs', () => {
  it('paints project and current entity before any fetch resolves', () => {
    const gate = deferred<any>();
    vi.spyOn(Tab, 'resolveDockTarget').mockReturnValue(gate.promise);

    const { result } = renderHook(() => useEntityBreadcrumbs(dock('a')));

    // Synchronous — nothing has been awaited yet.
    expect(result.current.crumbs.map((c) => c.kind)).toEqual(['project', 'current']);
    expect(result.current.crumbs[0].label).toBe('Acme');
    expect(result.current.targetTypeId?.toString()).toBe(DOC.toString());
  });

  it('fills the middle in once the ancestors resolve', async () => {
    vi.spyOn(Tab, 'resolveDockTarget').mockResolvedValue({
      targetTypeId: DOC,
      target: { displayName: 'Design notes', parent_type_id: FOLDER.toString() },
      projectId: 'p1',
    } as never);
    vi.spyOn(ancestors, 'resolveAncestorChain').mockResolvedValue([
      { typeId: FOLDER, entity: { displayName: 'Research' } as never },
    ]);

    const { result } = renderHook(() => useEntityBreadcrumbs(dock('a')));

    await waitFor(() => expect(result.current.crumbs).toHaveLength(3));
    expect(result.current.crumbs.map((c) => c.label)).toEqual(['Acme', 'Research', 'Design notes']);
    expect(result.current.crumbs.map((c) => c.kind)).toEqual(['project', 'ancestor', 'current']);
  });

  it('never lets a stale resolution reach a newer address', async () => {
    const first = deferred<any>();
    const resolveDockTarget = vi.spyOn(Tab, 'resolveDockTarget').mockReturnValueOnce(first.promise);
    const chain = vi.spyOn(ancestors, 'resolveAncestorChain');

    const { result, rerender } = renderHook(({ d }) => useEntityBreadcrumbs(d), {
      initialProps: { d: dock('a') },
    });

    // Navigate away — same TAB, different document, which is exactly the case
    // that used to leave the address stuck on the previous page. THEN let the
    // first dock's resolution land.
    resolveDockTarget.mockResolvedValue({ targetTypeId: DOC, target: null, projectId: null } as never);
    chain.mockResolvedValue([]);
    rerender({ d: dock('b') });
    first.resolve({
      targetTypeId: FOLDER,
      target: { displayName: 'STALE', parent_type_id: null },
      projectId: 'p1',
    });

    await waitFor(() => expect(result.current.crumbs).toHaveLength(2));
    expect(result.current.crumbs.some((c) => c.label === 'STALE')).toBe(false);
  });

  it('uses the context entity for an instant label when it is the same thing', () => {
    ctx.activeEntityTypeId = DOC;
    ctx.activeEntity = { displayName: 'Design notes' };
    vi.spyOn(Tab, 'resolveDockTarget').mockReturnValue(deferred<any>().promise);

    const { result } = renderHook(() => useEntityBreadcrumbs(dock('a')));

    expect(result.current.crumbs[1].label).toBe('Design notes');
  });

  it('names a target-less dock without leaving the address empty', () => {
    vi.spyOn(Tab, 'resolveDockTarget').mockResolvedValue({
      targetTypeId: null,
      target: null,
      projectId: null,
    } as never);

    const { result } = renderHook(() => useEntityBreadcrumbs(dock('a', null)));

    expect(result.current.crumbs).toHaveLength(2);
    expect(result.current.crumbs[1].label).toBeTruthy();
    expect(result.current.crumbs[1].pointer).toBeNull();
  });

  it('drops the project crumb when there is no project (hub)', () => {
    ctx.project = null;
    vi.spyOn(Tab, 'resolveDockTarget').mockReturnValue(deferred<any>().promise);

    const { result } = renderHook(() => useEntityBreadcrumbs(dock('a')));

    expect(result.current.crumbs.map((c) => c.kind)).toEqual(['current']);
  });

  it('prefers the type label over a fabricated display name', async () => {
    // `displayName` falls back to `<type>-<idtail>` for a nameless entity.
    // "Markdown" reads better in an address bar than "markdown-1111…".
    vi.spyOn(Tab, 'resolveDockTarget').mockResolvedValue({
      targetTypeId: DOC,
      target: { displayName: 'markdown-11111111', hasSyntheticDisplayName: true, parent_type_id: null },
      projectId: 'p1',
    } as never);

    const { result } = renderHook(() => useEntityBreadcrumbs(dock('a')));

    await waitFor(() => expect(result.current.crumbs[1].label).not.toBe('markdown-11111111'));
    expect(result.current.crumbs[1].label).toBeTruthy();
  });

  it('still shows an address when the dock cannot be resolved at all', async () => {
    vi.spyOn(Tab, 'resolveDockTarget').mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useEntityBreadcrumbs(dock('a')));

    // Phase 0's crumbs stand on their own — the rejection must not blank the bar.
    await waitFor(() => expect(result.current.crumbs.map((c) => c.kind)).toEqual(['project', 'current']));
  });
});
