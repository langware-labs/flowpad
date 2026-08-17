/**
 * Project-switch regression (RCA 2026-07-15, the "stuck footer" switch bug).
 *
 * Switching to a project resolves a destination dock (`dockForScopeEntry`) and
 * trusts that dock's LOADER to write `CurrentProjectTypeId`. Two gaps combined
 * into "switch lands on the Assets view but the app stays on the previous
 * project":
 *
 *   1. Resolver guessing — with NO recency-stamped tab in the target project,
 *      the resolver silently substituted lowest `tab_order` for "the last tab",
 *      so a context-neutral browse tab (a doc-born "…'s Assets" tab) could win
 *      the landing.
 *   2. Loader hole — a scope-keyed browse dock (assets/explorer/desktop) with a
 *      project-pinned scope and no entity pointer adopted NOTHING, leaving the
 *      previous project active.
 *
 * Both directions were proven live on v0.2.101 and the dev build (toggling tab
 * data / the fix made the bug appear and disappear). These tests pin the two
 * contracts at the unit layer:
 *   A. dockForScopeEntry: unstamped tabs are "unknown", never a guess — fall
 *      back to the current scope-keyed view re-scoped, else the project landing;
 *      a stamped tab is resumed.
 *   B. loadDockPointer: a project-pinned scope on a browse dock loads that
 *      project into context (delegation to `loadProject`).
 */
import { Tab, tabManager, TypeId, type TabRow } from '@sdk';
import { projectScope } from '@src/lib/scope-filter';
import { DockPointer } from '@src/navigation/DockPointer';
import { dockForProjectEntry } from '@src/tabs/project-entry';
import { ViewType } from '@src/types/ViewType';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadProjectMock = vi.hoisted(() => vi.fn(() => Promise.resolve(undefined)));
vi.mock('@src/routes/loaders/load-project', () => ({
  loadProject: loadProjectMock,
  loadProjectRoute: vi.fn(() => Promise.resolve(undefined)),
}));

import { adoptScopeProject, loadDockPointer } from '@src/routes/loaders/load-dock-pointer';

const PROJECT_P = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MARKDOWN_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PROC_ID = '22222222-2222-4222-8222-222222222222';

function row(overrides: Partial<TabRow>): TabRow {
  return {
    id: overrides.id ?? '90000000-0000-4000-8000-000000000001',
    pointer: overrides.pointer ?? '',
    target_type: overrides.target_type ?? null,
    target_id: overrides.target_id ?? null,
    parent_tab_id: null,
    project_id: overrides.project_id ?? PROJECT_P,
    name: null,
    icon_key: null,
    worktree: false,
    tab_order: overrides.tab_order ?? 0,
    last_active_at: overrides.last_active_at ?? null,
    status: null,
    is_disabled: false,
    ...overrides,
  };
}

/** The cyber-course-1 shape: a doc-born assets tab (low order) + the project
 *  tab (high order), NEITHER ever activated. */
function unstampedTabs(): Tab[] {
  return [
    new Tab(
      row({
        id: '90000000-0000-4000-8000-000000000001',
        pointer: new DockPointer(ViewType.ASSETS, '').withScopeFilter(projectScope(PROJECT_P)).toJSON() ?? '',
        target_type: 'markdown',
        target_id: MARKDOWN_ID,
        tab_order: 9,
        last_active_at: null,
      }),
    ),
    new Tab(
      row({
        id: '90000000-0000-4000-8000-000000000002',
        pointer: DockPointer.forProject(PROJECT_P).toJSON() ?? '',
        target_type: 'project',
        target_id: PROJECT_P,
        tab_order: 12,
        last_active_at: null,
      }),
    ),
  ];
}

describe('dockForScopeEntry — unknown last tab is never guessed (A)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    tabManager.adoptGlobal([]);
  });

  it('falls back to the project landing (not the lowest-order browse tab) when no tab is stamped', async () => {
    vi.spyOn(Tab, 'listAll').mockResolvedValue(unstampedTabs());

    const dock = await dockForProjectEntry(PROJECT_P);

    // Pre-fix this resolved the assets tab (tab_order 9) — the context-neutral
    // dock whose loader adopts nothing.
    expect(dock.viewType).toBe(ViewType.PROJECT);
    expect(dock.pointer).toBe(PROJECT_P);
  });

  it('re-scopes the current scope-keyed view to the destination when no tab is stamped', async () => {
    vi.spyOn(Tab, 'listAll').mockResolvedValue(unstampedTabs());
    const currentDock = new DockPointer(ViewType.ASSETS, '').withScopeFilter(projectScope('other-project-id'));

    const dock = await dockForProjectEntry(PROJECT_P, currentDock);

    expect(dock.viewType).toBe(ViewType.ASSETS);
    expect(dock.scopeFilter).toEqual(projectScope(PROJECT_P));
  });

  it('resumes the stamped (known last-active) tab when one exists', async () => {
    const stamped = new Tab(
      row({
        id: '90000000-0000-4000-8000-000000000003',
        pointer: DockPointer.forShell(`agentic_process-${PROC_ID}`).toJSON() ?? '',
        target_type: 'agentic_process',
        target_id: PROC_ID,
        tab_order: 20,
        last_active_at: 1784000000000,
      }),
    );
    vi.spyOn(Tab, 'listAll').mockResolvedValue([...unstampedTabs(), stamped]);

    const dock = await dockForProjectEntry(PROJECT_P);

    expect(dock.viewType).toBe(ViewType.SHELL);
    expect(dock.pointer).toContain(PROC_ID);
  });
});

describe('loadDockPointer — a project-pinned browse dock adopts its scope project (B)', () => {
  beforeEach(() => {
    loadProjectMock.mockClear();
  });

  it('assets dock with a project scope and no entity pointer loads that project into context', async () => {
    const dock = new DockPointer(ViewType.ASSETS, '').withScopeFilter(projectScope(PROJECT_P));

    await loadDockPointer(dock, { requestPath: '/dock/assets' });

    // Pre-fix: loadAssetRoute('') returned immediately and NOTHING wrote
    // CurrentProjectTypeId — the previous project stayed active.
    expect(loadProjectMock).toHaveBeenCalledTimes(1);
    const typeId = loadProjectMock.mock.calls[0][0] as TypeId;
    expect(typeId.id).toBe(PROJECT_P);
  });

  it('explorer (loader-less view) with a project scope adopts it too', async () => {
    const dock = new DockPointer(ViewType.EXPLORER, '').withScopeFilter(projectScope(PROJECT_P));

    await loadDockPointer(dock, { requestPath: '/dock/explorer' });

    expect(loadProjectMock).toHaveBeenCalledTimes(1);
    expect((loadProjectMock.mock.calls[0][0] as TypeId).id).toBe(PROJECT_P);
  });

  it('an unscoped (all) assets dock adopts nothing', async () => {
    const dock = new DockPointer(ViewType.ASSETS, '');

    await loadDockPointer(dock, { requestPath: '/dock/assets' });

    expect(loadProjectMock).not.toHaveBeenCalled();
  });
});

describe('the home dock canonicalizes, and the root loader adopts (C)', () => {
  // The stay-home switch landing — `?scope-mode=project&scope-activeProjectId=…`
  // on the home — still writes project context URL-first, incl. on hard refresh.
  // What changed is WHERE: the root is one location with one address (`/`), so
  // `/dock/home` redirects there and `loadHomePage` is the home's single writer.
  // Both halves are pinned, or the redirect could quietly drop the adoption.
  beforeEach(() => {
    loadProjectMock.mockClear();
  });

  it('a home dock redirects to the root, carrying its scope', async () => {
    const dock = DockPointer.forHome().withScopeFilter(projectScope(PROJECT_P));

    const redirected = await loadDockPointer(dock, { requestPath: '/dock/home' }).then(
      () => null,
      (thrown: Response) => thrown,
    );

    expect(redirected?.status).toBe(302);
    const location = redirected?.headers.get('location') ?? '';
    expect(location.startsWith('/?')).toBe(true);
    expect(location).toContain(PROJECT_P);
  });

  it('adoptScopeProject loads the scoped project — the root loader’s half', async () => {
    await adoptScopeProject(DockPointer.forHome().withScopeFilter(projectScope(PROJECT_P)));

    expect(loadProjectMock).toHaveBeenCalledTimes(1);
    expect((loadProjectMock.mock.calls[0][0] as TypeId).id).toBe(PROJECT_P);
  });

  it('a scope-less home dock adopts nothing', async () => {
    await adoptScopeProject(DockPointer.forHome());

    expect(loadProjectMock).not.toHaveBeenCalled();
  });
});
