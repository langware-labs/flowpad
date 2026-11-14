/**
 * The phone bar: Back leaves through `navigation.backOrHome()` and is absent on a freshly loaded Home,
 * where neither history nor Home leads anywhere; at desktop width the bar is not there at all.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ canGoBack: false }));
const backOrHome = vi.hoisted(() => vi.fn());
const dock = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('@src/navigation/use-history-nav', () => ({ useHistoryNav: () => nav }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { backOrHome }, currentDock: dock.current }),
}));
vi.mock('@src/components/top-nav-bar/use-entity-breadcrumbs', () => ({
  useEntityBreadcrumbs: () => ({
    crumbs: [
      { kind: 'project', label: 'P' },
      { kind: 'current', label: 'Design notes' },
    ],
  }),
}));

import { MemoryRouter } from 'react-router';
import { usePhoneNavigatorPresence } from '@src/components/navigator-panel/phone-navigator';
import { PhoneTopBar } from '@src/components/phone-shell/PhoneTopBar';
import { SidebarProvider } from '@src/components/ui/sidebar';
import { mockMobile } from '../utils/test-utils';

const bar = (beside?: ReactNode) => (
  <MemoryRouter>
    <SidebarProvider>
      <PhoneTopBar />
    </SidebarProvider>
    {beside}
  </MemoryRouter>
);

function show(mobile: boolean) {
  mockMobile(mobile);
  return render(bar());
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  nav.canGoBack = false;
});

describe('PhoneTopBar', () => {
  it('leaves through backOrHome, titled by the current crumb', () => {
    dock.current = { viewType: 'preferences' };
    show(true);
    expect(screen.getByTestId('phone-title').textContent).toBe('Design notes');
    fireEvent.click(screen.getByTestId('phone-back'));
    expect(backOrHome).toHaveBeenCalledOnce();
  });

  it('offers no Back on a freshly loaded Home, and Back once there is history', () => {
    dock.current = { viewType: 'home' };
    const { rerender } = show(true);
    expect(screen.queryByTestId('phone-back')).toBeNull();
    expect(screen.getByTestId('phone-menu-button')).toBeTruthy();
    nav.canGoBack = true;
    act(() => rerender(bar()));
    expect(screen.getByTestId('phone-back')).toBeTruthy();
  });

  it('offers Browse only while a navigator is on screen', () => {
    dock.current = { viewType: 'docs' };
    const Navigator = () => (usePhoneNavigatorPresence(), null);
    mockMobile(true);
    const { rerender } = render(bar());
    expect(screen.queryByTestId('phone-browse')).toBeNull();
    rerender(bar(<Navigator />));
    expect(screen.getByTestId('phone-browse')).toBeTruthy();
  });

  it('is absent at desktop width', () => {
    dock.current = { viewType: 'preferences' };
    show(false);
    expect(screen.queryByTestId('phone-top-bar')).toBeNull();
  });
});
