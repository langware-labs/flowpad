import { ContextEntitiesEnum, dataContext, ViewType, type Project } from '@sdk';
import { AssetMode } from '@src/navigation/asset-doc-types';
import { NavigationActions } from '@src/navigation/NavigationActions';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/**
 * NavigationActions.openAssets — the Assets icon's default surface: the
 * project home (scope-keyed to the active project) when a project is in
 * context, else the global "all" list. The sidebar delegates here
 * unconditionally (see tests/react/assets-sidebar-scope-open.test.tsx).
 */
describe('NavigationActions.openAssets', () => {
  afterEach(() => {
    NavigationActions.resetPendingNavigationForTests();
    vi.restoreAllMocks();
  });

  function setup(projectId: string | null) {
    window.history.pushState({}, '', '/');
    // `dataContext.project` is a getter over getContextEntity — stub the
    // lookup itself so no entity store setup is needed.
    vi.spyOn(dataContext, 'getContextEntity').mockImplementation((key) =>
      key === ContextEntitiesEnum.CurrentProjectTypeId && projectId ? ({ id: projectId } as Project) : null,
    );
    const navigation = new NavigationActions(vi.fn(), null);
    const openDockSpy = vi.spyOn(navigation, 'openDock').mockImplementation(() => undefined);
    return { navigation, openDockSpy };
  }

  it('with an active project → project home scoped to that project', () => {
    const { navigation, openDockSpy } = setup(PROJECT_ID);
    navigation.openAssets();

    expect(openDockSpy).toHaveBeenCalledTimes(1);
    const dock = openDockSpy.mock.calls[0][0];
    expect(dock.viewType).toBe(ViewType.ASSETS);
    expect(dock.pointer).toBe(AssetMode.PROJECT_HOME);
    expect(dock.scopeFilter).toEqual({ mode: 'project', activeProjectId: PROJECT_ID });
  });

  it('with no project → the scope-less "all" list (openDock seeds all-scope)', () => {
    const { navigation, openDockSpy } = setup(null);
    navigation.openAssets();

    expect(openDockSpy).toHaveBeenCalledTimes(1);
    const dock = openDockSpy.mock.calls[0][0];
    expect(dock.viewType).toBe(ViewType.ASSETS);
    expect(dock.pointer).toBe('list/all');
    expect(dock.scopeFilter ?? null).toBeNull();
  });
});
