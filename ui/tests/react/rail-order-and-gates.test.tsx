/**
 * The rail's rendered contract, as opposed to the pure spec (covered by
 * tests/unit/rail-visibility.test.ts): that CollapsedSidebar renders the list
 * IN ORDER, sends each click to its screen, and lights the entry whose screen
 * is the current one.
 *
 * Buttons are addressed by `data-rail-item` — the id from RAIL_ITEMS — rather
 * than by lucide glyph classes, which are a library-version detail.
 */
import { render, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { SidebarProvider } from '@src/components/ui/sidebar';
import { setDev } from '@src/contexts/view-mode-context';
import { ViewType } from '@src/types/ViewType';

const nav = vi.hoisted(() => ({ openTab: vi.fn(), openCredentials: vi.fn() }));
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

// The cluster at the foot of the rail — it carries `data-testid`, not
// `data-rail-item`, so it is outside the contract this file asserts. OrgTeamsButton
// also reaches react-query, which this tree has no provider for; its own
// behaviour is covered by tests/unit/org-teams-button.test.tsx.
vi.mock('@src/components/theme-toggle/theme-toggle', () => ({ ThemeToggle: () => null }));
vi.mock('@src/components/floating-chat', () => ({ FlowpadAssistantButton: () => null }));
vi.mock('@src/pages/flow-page/content-panel/user-dropdown/user-dropdown', () => ({ UserDropdown: () => null }));
vi.mock('@src/components/collapsed-sidebar/OrgTeamsButton', () => ({ OrgTeamsButton: () => null }));

import { CollapsedSidebar } from '@src/components/collapsed-sidebar/collapsed-sidebar';

function renderRail() {
  const { container } = render(
    <SidebarProvider>
      <CollapsedSidebar />
    </SidebarProvider>,
  );
  return {
    /** Rail ids in DOM order. */
    ids: () => [...container.querySelectorAll('[data-rail-item]')].map((el) => el.getAttribute('data-rail-item')),
    item: (id: string) => container.querySelector<HTMLButtonElement>(`[data-rail-item="${id}"]`),
  };
}

beforeEach(() => {
  dock.current = null;
});

afterEach(() => {
  nav.openTab.mockClear();
  nav.openCredentials.mockClear();
});

describe('rail', () => {
  it('shows the stream inbox and connections, in that order', () => {
    // Every other screen is opened by asking for it in the top bar.
    expect(renderRail().ids()).toEqual(['stream_inbox', 'credentials']);
  });

  it('developer mode adds nothing to the rail', () => {
    setDev(true);
    expect(renderRail().ids()).toEqual(['stream_inbox', 'credentials']);
    setDev(false);
  });

  it('each entry opens its own screen', () => {
    const rail = renderRail();
    fireEvent.click(rail.item('stream_inbox')!);
    expect(nav.openTab).toHaveBeenCalledWith(ViewType.STREAM_INBOX);
    fireEvent.click(rail.item('credentials')!);
    expect(nav.openCredentials).toHaveBeenCalled();
  });

  it('the entry whose screen is the current view renders active', () => {
    dock.current = { viewType: ViewType.CREDENTIALS };
    const rail = renderRail();
    expect(rail.item('credentials')!.getAttribute('data-active')).toBe('true');
    expect(rail.item('stream_inbox')!.getAttribute('data-active')).not.toBe('true');
  });

  it('no rail entry lights on an assets surface', () => {
    // Assets are reached through the top bar's project button; nothing on the rail claims them.
    dock.current = { viewType: ViewType.ASSETS, pointer: 'list/task' };
    const rail = renderRail();
    expect(rail.ids().filter((id) => rail.item(id!)?.getAttribute('data-active') === 'true')).toEqual([]);
  });
});
