/**
 * React render of the side-menu entry: clicking the Assets icon opens the
 * scope-keyed assets tab — the current project's scope when a project is active
 * (tab `assets|0:<id>`), else global (`assets|all`). Renders the REAL
 * CollapsedSidebar; only the navigation hook (capture `openDock`) and the heavy
 * presentational leaves are stubbed. The current project is the REAL
 * `dataContext` the handler reads.
 */
import { render, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { ContextEntitiesEnum, dataContext, dataManager, TypeId } from '@sdk';
import { SidebarProvider } from '@src/components/ui/sidebar';

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

describe('side-menu Assets opens the scope-keyed tab', () => {
  it.each([
    { label: 'project A active', projectId: PROJECT_A, hash: `assets|0:${PROJECT_A}` },
    { label: 'project B active', projectId: PROJECT_B, hash: `assets|0:${PROJECT_B}` },
    { label: 'no project', projectId: null, hash: 'assets|all' },
  ])('$label → $hash', async ({ projectId, hash }) => {
    await setProject(projectId);
    clickAssets();

    expect(nav.openTab).not.toHaveBeenCalled(); // assets routes via openDock, scoped
    expect(nav.openDock).toHaveBeenCalledTimes(1);
    const dock = nav.openDock.mock.calls[0][0];
    expect(dock.tabHash).toBe(hash);
    if (projectId) expect(dock.scopeFilter).toEqual({ user: false, projects: [projectId] });
  });
});
