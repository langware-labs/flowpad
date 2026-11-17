/**
 * The navigator follows its host's collapse policy: a `win/` popout (ContentPanel
 * provides POPOUT_NAVIGATOR_POLICY) starts collapsed, and toggling it there never
 * rewrites the main window's persisted choice.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NavigatorCollapsePolicyContext,
  NavigatorPanel,
  POPOUT_NAVIGATOR_POLICY,
} from '@src/components/navigator-panel/NavigatorPanel';
import { setPhoneNavigatorOpen } from '@src/components/navigator-panel/phone-navigator';
import { mockMobile } from '../utils/test-utils';

const descriptor = { id: 'probe', roots: [], header: { title: 'Chats' } } as never;
const KEY = 'navigator:probe:collapsed';

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

describe('NavigatorPanel — collapse policy', () => {
  it('opens as stored (expanded) under the default policy', () => {
    window.localStorage.setItem(KEY, '0');
    render(<NavigatorPanel descriptor={descriptor} />, { wrapper: MemoryRouter });

    expect(screen.getByTestId('navigator-collapse-probe')).toBeTruthy();
  });

  it('starts collapsed under the popout policy and does not persist its toggle', async () => {
    window.localStorage.setItem(KEY, '0');
    render(
      <NavigatorCollapsePolicyContext.Provider value={POPOUT_NAVIGATOR_POLICY}>
        <NavigatorPanel descriptor={descriptor} />
      </NavigatorCollapsePolicyContext.Provider>,
      { wrapper: MemoryRouter },
    );

    await userEvent.click(screen.getByTestId('navigator-expand-probe'));
    await userEvent.click(screen.getByTestId('navigator-collapse-probe'));

    expect(screen.getByTestId('navigator-expand-probe')).toBeTruthy();
    expect(window.localStorage.getItem(KEY)).toBe('0');
  });
});

describe('NavigatorPanel — on a phone it is a drawer', () => {
  afterEach(() => {
    act(() => setPhoneNavigatorOpen(false));
    vi.restoreAllMocks();
  });

  it('is never the collapsed rail: the whole panel stays mounted, off screen until Browse opens it', async () => {
    mockMobile(true);
    window.localStorage.setItem(KEY, '1');
    render(<NavigatorPanel descriptor={descriptor} />, { wrapper: MemoryRouter });

    const panel = screen.getByTestId('navigator-panel-probe');
    expect(panel.className).toContain('max-md:invisible');
    expect(screen.queryByTestId('navigator-expand-probe')).toBeNull();

    act(() => setPhoneNavigatorOpen(true));
    expect(panel.className).not.toContain('max-md:invisible');

    // Its own collapse button closes the drawer — and leaves the desktop's stored choice alone.
    await userEvent.click(screen.getByTestId('navigator-collapse-probe'));
    expect(panel.className).toContain('max-md:invisible');
    expect(window.localStorage.getItem(KEY)).toBe('1');
  });
});
