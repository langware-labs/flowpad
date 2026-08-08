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

import { dataManager, Tab, TypeId } from '@sdk';
import { canonicalWikiWord } from '@src/navigation/asset-doc-pointer-grammar';
import * as ancestors from '@src/navigation/entity-ancestors';
import { useEntityBreadcrumbs } from '@src/components/top-nav-bar/use-entity-breadcrumbs';
import {
  resetWikiResolveResultsForTests,
  setWikiResolveResult,
} from '@src/routes/loaders/wiki-resolve-store';

const DOC = new TypeId('markdown', '11111111-1111-4111-8111-111111111111');
const PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_PROJECT_ID = '55555555-5555-4555-8555-555555555555';
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

  it('says Home on the project\'s own page rather than the name twice', async () => {
    ctx.project = { displayName: 'Acme', id: PROJECT_ID };
    const projectTypeId = new TypeId('project', PROJECT_ID);
    vi.spyOn(Tab, 'resolveDockTarget').mockResolvedValue({
      targetTypeId: projectTypeId,
      target: { displayName: 'Acme', parent_type_id: null },
      projectId: PROJECT_ID,
    } as never);

    const { result } = renderHook(() => useEntityBreadcrumbs(dock('p', projectTypeId)));

    await waitFor(() => expect(result.current.crumbs[1].label).toBe('Home'));
    expect(result.current.crumbs.map((c) => c.label)).toEqual(['Acme', 'Home']);
  });

  it('still names a DIFFERENT project normally', async () => {
    // Only the active project collapses to "Home" — another project's page is
    // a real destination and keeps its name.
    ctx.project = { displayName: 'Acme', id: PROJECT_ID };
    const otherProject = new TypeId('project', OTHER_PROJECT_ID);
    vi.spyOn(Tab, 'resolveDockTarget').mockResolvedValue({
      targetTypeId: otherProject,
      target: { displayName: 'Other', parent_type_id: null },
      projectId: OTHER_PROJECT_ID,
    } as never);

    const { result } = renderHook(() => useEntityBreadcrumbs(dock('p2', otherProject)));

    await waitFor(() => expect(result.current.crumbs[1].label).toBe('Other'));
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

/**
 * A wiki route is the one asset form addressed by WORD rather than by typeid or
 * path — deliberately, so it survives a rename. That means `targetTypeId` and
 * `vfsPath` are both empty, and the bar used to fall through to the generic
 * view crumb: "Assets" with a grid glyph, on a page that plainly knows it is a
 * wiki page. It reads `Project / <Wiki> / <word>` instead.
 */
describe('useEntityBreadcrumbs — wiki routes', () => {
  const WIKI_ID = '66666666-6666-4666-8666-666666666666';
  const PAGE = new TypeId('markdown', '77777777-7777-4777-8777-777777777777');

  /** An assets dock whose pointer is `wiki/<space>/<word>`, with the `wikiRef`
   *  getter the real DockPointer exposes. */
  function wikiDock(space: string, name: string) {
    return {
      pointer: `wiki/${space}/${name}`,
      tabHash: 'tab-1',
      targetTypeId: null,
      viewType: 'assets',
      options: {},
      wikiRef: { space, name, word: canonicalWikiWord(name) },
    } as never;
  }

  beforeEach(() => {
    resetWikiResolveResultsForTests();
    // A wiki dock carries no typeid and no vfs path, so this is what the real
    // resolver answers.
    vi.spyOn(Tab, 'resolveDockTarget').mockResolvedValue({
      targetTypeId: null,
      target: null,
      projectId: null,
    } as never);
  });
  afterEach(() => resetWikiResolveResultsForTests());

  it('names the page from the word on the first frame, with no fetch', () => {
    vi.spyOn(dataManager, 'getByTypeId').mockReturnValue(deferred<any>().promise as never);

    const { result } = renderHook(() => useEntityBreadcrumbs(wikiDock(WIKI_ID, 'Duplicate assets')));

    // Not "Assets" — the word is right there in the URL.
    expect(result.current.crumbs.at(-1)?.label).toBe('Duplicate assets');
    expect(result.current.targetTitle).toBe('Duplicate assets');
  });

  it('labels the page with the word that RESOLVED, not the raw URL segment', async () => {
    vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue({
      displayName: 'Engineering',
      typeId: new TypeId('wiki', WIKI_ID),
    } as never);

    // The backend canonicalizes `Docs/Nested Child Page` to `Docs` and serves
    // that page; echoing the URL segment would name a page nobody opened.
    const { result } = renderHook(() => useEntityBreadcrumbs(wikiDock(WIKI_ID, 'Docs/Nested Child Page')));

    await waitFor(() => expect(result.current.crumbs.at(-1)?.label).toBe('Docs'));
    expect(result.current.targetTitle).toBe('Docs');
  });

  it('puts the Wiki between the project and the page', async () => {
    vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue({
      displayName: 'Engineering',
      typeId: new TypeId('wiki', WIKI_ID),
    } as never);

    const { result } = renderHook(() => useEntityBreadcrumbs(wikiDock(WIKI_ID, 'Duplicate assets')));

    await waitFor(() => expect(result.current.crumbs.map((c) => c.kind)).toEqual(['project', 'ancestor', 'current']));
    expect(result.current.crumbs.map((c) => c.label)).toEqual(['Acme', 'Engineering', 'Duplicate assets']);
  });

  it('adopts the resolved page as the target once the route resolves the word', async () => {
    vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue(null as never);
    setWikiResolveResult(WIKI_ID, 'Duplicate assets', { kind: 'resolved', target_typeid: PAGE, source: 'entry' });

    const { result } = renderHook(() => useEntityBreadcrumbs(wikiDock(WIKI_ID, 'Duplicate assets')));

    // The target is what the actions cluster bookmarks and shares, so a wiki
    // page has to surface one — but the address still says the word.
    await waitFor(() => expect(result.current.targetTypeId?.toString()).toBe(PAGE.toString()));
    expect(result.current.crumbs.at(-1)?.label).toBe('Duplicate assets');
  });

  it('resolves the @local alias through the active project, not as an id', async () => {
    const byTypeId = vi.spyOn(dataManager, 'getByTypeId').mockResolvedValue(null as never);
    const getDefaultWiki = vi.fn().mockResolvedValue({
      displayName: 'Project Wiki',
      typeId: new TypeId('wiki', WIKI_ID),
    });
    ctx.project = { displayName: 'Acme', id: 'p1', getDefaultWiki };

    const { result } = renderHook(() => useEntityBreadcrumbs(wikiDock('@local', 'Runtime environments')));

    await waitFor(() => expect(result.current.crumbs.map((c) => c.label)).toEqual([
      'Acme',
      'Project Wiki',
      'Runtime environments',
    ]));
    // `@local` is an alias, never a wiki id — looking it up as one would 404.
    expect(byTypeId).not.toHaveBeenCalled();
    expect(getDefaultWiki).toHaveBeenCalled();
  });
});

/**
 * A project-REBASED asset route (`/dock/project/<id>/<assetSubPointer>`) wears
 * `viewType: 'project'` while addressing an asset. Treating the bare viewType as
 * "the project page" labelled every one of them "Home".
 */
describe('useEntityBreadcrumbs — project-rebased routes are not the project page', () => {
  function projectDock(pointer: string, isProjectShell: boolean, targetTypeId: TypeId | null) {
    return { pointer, tabHash: 'tab-1', targetTypeId, viewType: 'project', options: {}, isProjectShell } as never;
  }

  it('names the asset, not "Home", on a rebased editor route', async () => {
    vi.spyOn(Tab, 'resolveDockTarget').mockResolvedValue({
      targetTypeId: DOC,
      target: { displayName: 'Design notes', parent_type_id: null },
      projectId: 'p1',
    } as never);

    const { result } = renderHook(() =>
      useEntityBreadcrumbs(projectDock(`${PROJECT_ID}/editor/markdown/typeid/${DOC.toString()}`, false, DOC)),
    );

    await waitFor(() => expect(result.current.crumbs.at(-1)?.label).toBe('Design notes'));
  });

  it('still says "Home" on the bare project route', () => {
    vi.spyOn(Tab, 'resolveDockTarget').mockReturnValue(deferred<any>().promise);

    const { result } = renderHook(() => useEntityBreadcrumbs(projectDock(PROJECT_ID, true, null)));

    // The project IS the leading crumb; repeating it would read "Acme › Acme".
    expect(result.current.crumbs.at(-1)?.label).toBe('Home');
  });
});
