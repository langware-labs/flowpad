/**
 * React render of the side-menu entry: clicking the Assets icon opens the assets
 * dock via `navigation.openAssets`, which resolves the default surface — the
 * project home (scoped to the active project) when a project is in context,
 * else the global "all" list. Renders the REAL CollapsedSidebar in Advanced view
 * (Assets is Advanced/Dev-only); only the navigation hook (capture `openAssets`)
 * and the heavy presentational leaves are stubbed. The surface/scope resolution
 * itself lives in NavigationActions.openAssets and is exercised where openDock
 * is real (assets scope-contract / scope-hash unit tests).
 */
import { render, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { ContextEntitiesEnum, dataContext, dataManager, TypeId } from '@sdk';
import { SidebarProvider } from '@src/components/ui/sidebar';
import { setViewMode, ViewMode } from '@src/contexts/view-mode-context';

const nav = vi.hoisted(() => ({ openDock: vi.fn(), openTab: vi.fn(), openAssets: vi.fn() }));
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
    await dataContext.setContextEntityTypeId(
      ContextEntitiesEnum.CurrentProjectTypeId,
      new TypeId('project', projectId),
    );
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

beforeEach(() => {
  // The Assets nav item is now Advanced/Dev-visible only (Standard hides it —
  // collapsed-sidebar navItems `vis`). Render in Advanced so the item — and its
  // BookOpen icon the test clicks — is present.
  setViewMode(ViewMode.Advanced);
});

afterEach(() => {
  nav.openDock.mockClear();
  nav.openTab.mockClear();
  nav.openAssets.mockClear();
  setViewMode(ViewMode.Standard);
});

describe('side-menu Assets delegates to openAssets', () => {
  it.each([
    { label: 'project A active', projectId: PROJECT_A },
    { label: 'project B active', projectId: PROJECT_B },
    { label: 'no project', projectId: null },
  ])('$label → delegates to navigation.openAssets (it resolves surface + scope)', async ({ projectId }) => {
    await setProject(projectId);
    clickAssets();

    expect(nav.openTab).not.toHaveBeenCalled(); // assets routes via openAssets
    expect(nav.openDock).not.toHaveBeenCalled(); // no direct pointer from the sidebar
    // The sidebar delegates unconditionally; which surface opens (project-home
    // scoped to the active project vs the global list) is openAssets's call,
    // covered by the NavigationActions.openAssets unit test.
    expect(nav.openAssets).toHaveBeenCalledTimes(1);
  });
});
