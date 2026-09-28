/**
 * The terminal link menu's "Open in ▸ browser / profile" submenu, and the loader behind it.
 *
 * `apiClient` is stubbed at the transport edge; what the backend lists and launches
 * on each OS is pinned in `tests/unit/test_browser_profiles.py`, and the real
 * right-click → browser-opens path in `tests/manual_regression/terminal/terminal_links.md.ts`.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  runtimeKind: 'browser',
  openLinkInBrowserProfile: vi.fn(),
}));

vi.mock('@sdk/client', () => ({ __esModule: true, default: { get: mocks.get, post: mocks.post } }));
vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  dataContext: {
    get runtimeKind() {
      return mocks.runtimeKind;
    },
  },
}));
vi.mock('@src/navigation', () => ({
  useDockNavigation: () => ({
    navigation: {
      openLink: vi.fn(),
      openLinkInBrowser: vi.fn(),
      openLinkInVibe: vi.fn(),
      openLinkInBrowserProfile: mocks.openLinkInBrowserProfile,
    },
  }),
}));

const { useTerminalLinks } = await import('@src/components/terminal/interactive-terminal/TerminalLinkMenu');
const { fetchBrowserProfiles } = await import('@src/lib/browser-profiles');

const BROWSERS = [
  {
    id: 'chrome',
    name: 'Google Chrome',
    profiles: [
      { id: 'Default', name: 'Personal', email: 'me@home.test' },
      { id: 'Profile 3', name: 'Work', email: null },
    ],
  },
  { id: 'firefox', name: 'Firefox', profiles: [{ id: 'default-release', name: 'default-release', email: null }] },
];

const LINK = 'https://example.test/a?b=1';

/** A terminal's worth of the hook: the menu rendered, and a right-click on `link` once mounted. */
function Harness({ link }: { link: string }) {
  const { handlers, menu } = useTerminalLinks({ current: null });
  useEffect(() => handlers.openMenu(link, 10, 10), [handlers, link]);
  return <>{menu}</>;
}

async function openSubmenu(): Promise<void> {
  const trigger = await screen.findByTestId('terminal-link-menu-open-in');
  act(() => {
    trigger.focus();
  });
  fireEvent.keyDown(trigger, { key: 'ArrowRight' });
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.openLinkInBrowserProfile.mockReset();
  mocks.runtimeKind = 'browser';
});
afterEach(cleanup);

describe('Open in ▸ submenu', () => {
  it('lists every profile, grouped by browser, and opens the chosen one', async () => {
    mocks.get.mockResolvedValue({ browsers: BROWSERS });
    render(<Harness link={LINK} />);
    await openSubmenu();

    expect(await screen.findByRole('group', { name: 'Google Chrome' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Firefox' })).toBeTruthy();
    expect(screen.getByTestId('terminal-link-menu-profile-chrome-Default').textContent).toBe('Personal — me@home.test');
    expect(screen.getByTestId('terminal-link-menu-profile-chrome-Profile 3').textContent).toBe('Work');

    fireEvent.click(screen.getByTestId('terminal-link-menu-profile-chrome-Profile 3'));
    expect(mocks.openLinkInBrowserProfile).toHaveBeenCalledWith(LINK, null, 'chrome', 'Profile 3');
  });

  it('is absent when no browser profile was found', async () => {
    mocks.get.mockResolvedValue({ browsers: [] });
    render(<Harness link={LINK} />);
    await screen.findByTestId('terminal-link-menu');
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('terminal-link-menu-open-in')).toBeNull();
    expect(screen.getByText('Open in browser')).toBeTruthy();
  });

  it('is absent off the user machine, without asking the backend', async () => {
    mocks.runtimeKind = 'sandbox';
    render(<Harness link={LINK} />);
    await screen.findByTestId('terminal-link-menu');
    expect(screen.queryByTestId('terminal-link-menu-open-in')).toBeNull();
    expect(mocks.get).not.toHaveBeenCalled();
  });
});

describe('fetchBrowserProfiles', () => {
  it('asks the backend every time, so a new profile shows on the next right-click', async () => {
    mocks.get.mockResolvedValueOnce({ browsers: [] }).mockResolvedValueOnce({ browsers: BROWSERS });
    expect(await fetchBrowserProfiles()).toEqual([]);
    expect(await fetchBrowserProfiles()).toEqual(BROWSERS);
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.get).toHaveBeenCalledWith('/api/v1/browser-profiles');
  });

  it('lists nothing when the backend cannot answer', async () => {
    mocks.get.mockRejectedValueOnce(new Error('down'));
    expect(await fetchBrowserProfiles()).toEqual([]);
  });

  it('asks from the Electron shell, never from the hub', async () => {
    mocks.runtimeKind = 'desktop';
    mocks.get.mockResolvedValue({ browsers: BROWSERS });
    expect(await fetchBrowserProfiles()).toEqual(BROWSERS);
    mocks.runtimeKind = 'hub';
    expect(await fetchBrowserProfiles()).toEqual([]);
    expect(mocks.get).toHaveBeenCalledTimes(1);
  });
});
