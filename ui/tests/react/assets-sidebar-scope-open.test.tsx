/**
 * React render of the side-menu entry that opens assets: the PROJECT icon.
 *
 * There is no Assets rail icon any more — it was a second door onto the room the
 * project item already opens, and having both meant one click lit two rail
 * buttons. The project item now carries that job, and with it this test: clicking
 * it delegates to `navigation.openAssets`, which resolves the default surface
 * (the project home, scoped to the active project).
 *
 * Renders the REAL CollapsedSidebar; only the navigation hook (capture
 * `openAssets`) and the heavy presentational leaves are stubbed. The surface/scope
 * resolution itself lives in NavigationActions.openAssets and is exercised where
 * openDock is real (assets scope-contract / scope-hash unit tests).
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
vi.mock('@src/contexts/dev-mode-context', () => ({ useDevMode: () => false }));
vi.mock('@src/hooks/use-navigation-state', () => ({
  useNavigationState: () => ({ goBack: vi.fn(), canGoBack: false }),
}));
vi.mock('@src/hooks/useInboxManager', () => ({
  useInboxManager: () => ({ unread: 0 }),
  useSyncOsBadge: () => undefined,
}));
vi.mock('@src/store/use-spotlight-store', () => ({
  useSpotlightStore: { getState: () => ({ openSpotlight: vi.fn() }) },
}));
// Content gates: irrelevant here, and their live queries would drag the whole
// inbox/task corpus into a nav-delegation test.
vi.mock('@src/hooks/use-has-conversations', () => ({ useHasConversations: () => false }));
vi.mock('@src/hooks/use-project-tasks', () => ({ useProjectTasks: () => ({ data: [] }) }));

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

/** The project rail button, or null when no project is active. Keyed on the
 *  aria-label rather than the glyph: the icon comes from the type registry
 *  (iconForType), so pinning a lucide class here would re-hardcode what the
 *  registry owns. */
function projectButton(): HTMLButtonElement | null {
  const { container } = render(
    <SidebarProvider>
      <MemoryRouter>
        <CollapsedSidebar />
      </MemoryRouter>
    </SidebarProvider>,
  );
  return container.querySelector<HTMLButtonElement>('button[aria-label^="Open project assets"]');
}

afterEach(() => {
  nav.openDock.mockClear();
  nav.openTab.mockClear();
  nav.openAssets.mockClear();
  setViewMode(ViewMode.Standard);
});

describe('side-menu project item delegates to openAssets', () => {
  it.each([
    { label: 'project A active', projectId: PROJECT_A },
    { label: 'project B active', projectId: PROJECT_B },
  ])('$label → delegates to navigation.openAssets (it resolves surface + scope)', async ({ projectId }) => {
    await setProject(projectId);
    const btn = projectButton();
    expect(btn, 'project nav button').toBeTruthy();
    fireEvent.click(btn!);

    expect(nav.openTab).not.toHaveBeenCalled(); // assets routes via openAssets
    expect(nav.openDock).not.toHaveBeenCalled(); // no direct pointer from the sidebar
    // The sidebar delegates unconditionally; which surface opens (project-home
    // scoped to the active project vs the global list) is openAssets's call,
    // covered by the NavigationActions.openAssets unit test.
    expect(nav.openAssets).toHaveBeenCalledTimes(1);
  });

  it('is absent — and opens nothing — when no project is active', async () => {
    await setProject(null);
    expect(projectButton()).toBeNull();
    expect(nav.openAssets).not.toHaveBeenCalled();
  });

  // "rides every view mode" is covered by rail-order-and-gates.test.tsx's mode
  // walk, which asserts nothing disappears as the mode grows.
});
