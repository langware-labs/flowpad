/**
 * Side-menu Assets behavior, in two halves:
 *  1. The REAL CollapsedSidebar opens the scope-LESS assets dock (`assets|all`)
 *     via `openDock` — the sidebar no longer computes per-project scope.
 *  2. `NavigationActions.openDock` seeds that scope-less assets dock from the
 *     current project (project scope when one is active, else `all`) — the
 *     behavior that moved out of the sidebar.
 * Only the navigation hook and heavy presentational leaves are stubbed; the
 * current project is the REAL `dataContext` the code reads.
 */
import { render, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { ContextEntitiesEnum, dataContext, dataManager, TypeId } from '@sdk';
import { SidebarProvider } from '@src/components/ui/sidebar';
import { NavigationActions } from '@src/navigation/NavigationActions';
import { DockPointer } from '@src/navigation/DockPointer';
import { allScope, projectScope } from '@src/lib/scope-filter';

const nav = vi.hoisted(() => ({ openDock: vi.fn(), openTab: vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: nav, currentDock: null, isDockUrl: false, windowMode: false }),
}));
// Heavy presentational leaves — irrelevant to the nav decision.
vi.mock('@src/components/theme-toggle/theme-toggle', () => ({ ThemeToggle: () => null }));
vi.mock('@src/components/floating-chat', () => ({ FlowpadAssistantButton: () => null }));
vi.mock('@src/pages/flow-page/content-panel/user-dropdown/user-dropdown', () => ({ UserDropdown: () => null }));
vi.mock('@src/components/view-mode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@src/components/view-mode')>()),
  DevOnly: () => null,
}));
vi.mock('@src/contexts/dev-mode-context', () => ({ useDevMode: () => false }));
vi.mock('@src/hooks/use-navigation-state', () => ({
  useNavigationState: () => ({ goBack: vi.fn(), canGoBack: false }),
}));
vi.mock('@src/store/use-inbox-store', () => ({ useInboxStore: () => ({ unreadCount: 0 }) }));
vi.mock('@src/store/use-spotlight-store', () => ({
  useSpotlightStore: { getState: () => ({ openSpotlight: vi.fn() }) },
}));

import { CollapsedSidebar } from '@src/components/collapsed-sidebar/collapsed-sidebar';

const PROJECT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function setProject(projectId: string | null): Promise<void> {
  if (projectId) {
    dataManager.updateEntityFromJson({ type: 'project', id: projectId, name: 'Acme' });
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, new TypeId('project', projectId));
  } else {
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, null);
  }
}

function clickAssets(): void {
  const { container } = render(
    <SidebarProvider>
      <MemoryRouter>
        <CollapsedSidebar />
      </MemoryRouter>
    </SidebarProvider>,
  );
  const btn = container.querySelector('.lucide-book-open')?.closest('button');
  expect(btn, 'Assets nav button').toBeTruthy();
  fireEvent.click(btn!);
}

afterEach(() => {
  nav.openDock.mockClear();
  nav.openTab.mockClear();
});

describe('side-menu Assets opens the scope-less assets tab', () => {
  // The sidebar always opens the scope-LESS assets dock regardless of the active
  // project; scope seeding is NavigationActions.openDock's job (covered below).
  it.each([
    { label: 'project A active', projectId: PROJECT_A },
    { label: 'project B active', projectId: PROJECT_B },
    { label: 'no project', projectId: null },
  ])('$label → opens assets|all via openDock', async ({ projectId }) => {
    await setProject(projectId);
    clickAssets();

    expect(nav.openTab).not.toHaveBeenCalled(); // assets routes via openDock
    expect(nav.openDock).toHaveBeenCalledTimes(1);
    const dock = nav.openDock.mock.calls[0][0];
    expect(dock.tabHash).toBe('assets|all');
    expect(dock.scopeFilter).toBeNull();
  });
});

describe('NavigationActions.openDock seeds assets scope from the current project', () => {
  afterEach(async () => {
    NavigationActions.resetPendingNavigationForTests();
    await setProject(null);
    vi.restoreAllMocks();
  });

  it.each([
    { label: 'project active → project scope', projectId: PROJECT_A, expected: projectScope(PROJECT_A) },
    { label: 'no project → all scope', projectId: null, expected: allScope() },
  ])('$label', async ({ projectId, expected }) => {
    await setProject(projectId); // sets the REAL dataContext current project
    const navigate = vi.fn();
    const navigation = new NavigationActions(navigate, null);

    // A scope-LESS assets dock (exactly what the sidebar opens) adopts the
    // current project's scope inside openDock.
    navigation.openDock(DockPointer.forAssetList('all'));

    expect(navigate).toHaveBeenCalledTimes(1);
    const seeded = DockPointer.fromUrl(navigate.mock.calls[0][0] as string);
    expect(seeded.scopeFilter).toEqual(expected);
  });
});
