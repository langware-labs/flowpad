/**
 * The rail's rendered contract, as opposed to the pure spec (covered by
 * tests/unit/rail-visibility.test.ts): that CollapsedSidebar actually renders the
 * resolved list IN ORDER, honours the content gates, forks the Chats target on
 * view mode, and resolves active-state identically above and below the chevron.
 *
 * The last one is the regression that motivated the rewrite: overflow entries
 * used to run their own `currentView === viewType` check, so they silently lost
 * the shared active/badge resolution the top rail got.
 *
 * Buttons are addressed by `data-rail-item` — the id from RAIL_ITEMS — rather
 * than by lucide glyph classes, which are a library-version detail.
 */
import { render, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { ContextEntitiesEnum, dataContext, dataManager, TypeId } from '@sdk';
import { SidebarProvider } from '@src/components/ui/sidebar';
import { setViewMode, ViewMode } from '@src/contexts/view-mode-context';
import { ViewType } from '@src/types/ViewType';

const nav = vi.hoisted(() => ({ openDock: vi.fn(), openTab: vi.fn(), openAssets: vi.fn() }));
/** Mutable so a test can put the rail on a given dock URL (active-state input). */
const dock = vi.hoisted(() => ({ current: null as { viewType: ViewType; pointer?: string } | null }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useCurrentDock: () => dock.current,
  useDockNavigation: () => ({
    navigation: nav,
    currentDock: dock.current,
    isDockUrl: !!dock.current,
    windowMode: false,
  }),
}));

/** The Vibe-only Chats target. Captured, not exercised — its own resolution is
 *  unit-tested against the query it builds. */
const lastVibeChat = vi.hoisted(() => vi.fn());
vi.mock('@src/pages/flow-page/use-last-vibe-chat', () => ({ useLastVibeChat: () => lastVibeChat }));

// Content gates, driven per test.
const gates = vi.hoisted(() => ({ conversations: false }));
vi.mock('@src/hooks/use-has-conversations', () => ({ useHasConversations: () => gates.conversations }));

// Heavy presentational leaves — irrelevant to placement decisions.
vi.mock('@src/components/theme-toggle/theme-toggle', () => ({ ThemeToggle: () => null }));
vi.mock('@src/components/floating-chat', () => ({ FlowpadAssistantButton: () => null }));
vi.mock('@src/pages/flow-page/content-panel/user-dropdown/user-dropdown', () => ({ UserDropdown: () => null }));
vi.mock('@src/contexts/dev-mode-context', () => ({ useDevMode: () => false }));
vi.mock('@src/store/use-inbox-store', () => ({ useInboxStore: () => ({ unreadCount: 0 }) }));
vi.mock('@src/store/use-spotlight-store', () => ({
  useSpotlightStore: { getState: () => ({ openSpotlight: vi.fn() }) },
}));

import { CollapsedSidebar } from '@src/components/collapsed-sidebar/collapsed-sidebar';

const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

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

function renderRail() {
  const { container } = render(
    <SidebarProvider>
      <MemoryRouter>
        <CollapsedSidebar />
      </MemoryRouter>
    </SidebarProvider>,
  );
  return {
    container,
    /** Rail ids in DOM order. */
    ids: () => [...container.querySelectorAll('[data-rail-item]')].map((el) => el.getAttribute('data-rail-item')),
    item: (id: string) => container.querySelector<HTMLButtonElement>(`[data-rail-item="${id}"]`),
  };
}

beforeEach(async () => {
  gates.conversations = false;
  dock.current = null;
  await setProject(PROJECT);
  setViewMode(ViewMode.Vibe);
});

afterEach(() => {
  nav.openDock.mockClear();
  nav.openTab.mockClear();
  nav.openAssets.mockClear();
  lastVibeChat.mockClear();
  setViewMode(ViewMode.Standard);
});

describe('rail — order and gates', () => {
  it('a fresh instance shows exactly Home, Project, Chats, Bookmarks', () => {
    expect(renderRail().ids()).toEqual(['home', 'project', 'chats', 'bookmarks', 'files']);
  });

  it('drops the project item when no project is active', async () => {
    await setProject(null);
    expect(renderRail().ids()).not.toContain('project');
  });

  it('reveals Inbox on the first conversation', () => {
    gates.conversations = true;
    expect(renderRail().ids()).toEqual(['home', 'project', 'chats', 'bookmarks', 'inbox', 'files']);
  });

  it('Data sources appears at Advanced, not before, and needs no content gate', () => {
    expect(renderRail().ids()).not.toContain('data-sources');
    setViewMode(ViewMode.Standard);
    expect(renderRail().ids()).not.toContain('data-sources');

    setViewMode(ViewMode.Advanced);
    // No gate is set on the way in — see RAIL_ITEMS for why.
    expect(renderRail().ids()).toContain('data-sources');
  });

  it('clicking Data sources opens its dedicated view', () => {
    setViewMode(ViewMode.Advanced);
    fireEvent.click(renderRail().item('data-sources')!);
    expect(nav.openTab).toHaveBeenCalledWith(ViewType.DATA_SOURCES);
  });

  it('keeps one order across every mode — icons are only ever added', () => {
    gates.conversations = true;
    let previous: (string | null)[] = [];
    for (const mode of [ViewMode.Vibe, ViewMode.Standard, ViewMode.Advanced, ViewMode.Dev]) {
      setViewMode(mode);
      const ids = renderRail().ids();
      // Nothing the simpler mode showed may disappear...
      for (const id of previous) expect(ids, `${mode} dropped ${id}`).toContain(id);
      // ...and the ids it kept must stay in the same relative order.
      expect(ids.filter((id) => previous.includes(id))).toEqual(previous);
      previous = ids;
    }
  });

  it('never renders an Assets item — the project item owns that door', () => {
    setViewMode(ViewMode.Dev);
    expect(renderRail().ids()).not.toContain('assets');
  });
});

describe('rail — Chats target forks on view mode', () => {
  it('Vibe: resumes the last UI chat instead of opening the chats list', () => {
    setViewMode(ViewMode.Vibe);
    const rail = renderRail();
    fireEvent.click(rail.item('chats')!);

    expect(lastVibeChat).toHaveBeenCalledTimes(1);
    expect(nav.openTab).not.toHaveBeenCalled();
  });

  for (const mode of [ViewMode.Standard, ViewMode.Advanced, ViewMode.Dev]) {
    it(`${mode}: opens the chats list`, () => {
      setViewMode(mode);
      const rail = renderRail();
      fireEvent.click(rail.item('chats')!);

      expect(nav.openTab).toHaveBeenCalledWith(ViewType.SHELL);
      expect(lastVibeChat).not.toHaveBeenCalled();
    });
  }
});

describe('rail — one active resolver above and below the chevron', () => {
  it('an overflow item that is the current view renders active', () => {
    setViewMode(ViewMode.Advanced);
    dock.current = { viewType: ViewType.EXPLORER };
    const files = renderRail().item('files');
    expect(files, 'files overflow item').toBeTruthy();
    expect(files!.getAttribute('data-active')).toBe('true');
  });

  it('the project item owns every assets surface, the task list included', () => {
    // No rail entry claims `list/task` any more, so nothing may subtract it
    // from the project item — subtracting would leave the rail dark there.
    dock.current = { viewType: ViewType.ASSETS, pointer: 'list/task' };
    const rail = renderRail();
    expect(rail.item('tasks')).toBeNull();
    expect(rail.item('project')!.getAttribute('data-active')).toBe('true');
  });

  it('the project item is active on a plain assets surface', () => {
    dock.current = { viewType: ViewType.ASSETS, pointer: 'list/all' };
    expect(renderRail().item('project')!.getAttribute('data-active')).toBe('true');
  });
});
