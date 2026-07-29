/**
 * HubHome's desktop card → Credentials.
 *
 * This button used to call `openDock` with a page-less MACHINE pointer, which
 * `pageRedirectUrl` bounced straight back to /dock/hub/home on a hub-only
 * server — so the button did nothing. The contract is `openPage(HUB, …)`, and
 * that is what this pins.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({
  openPage: vi.fn(),
  openDock: vi.fn(),
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: { openPage: h.openPage, openDock: h.openDock },
    currentDock: { page: 'hub' },
  }),
}));
vi.mock('@sdk/react/hooks', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useAuth: () => ({ currentUser: { id: 'u1', name: 'Ada' } }),
}));
vi.mock('@src/hooks/useContext', () => ({ useContext: () => ({ project: null }) }));
vi.mock('@src/hooks/use-projects', () => ({ useProjects: () => ({ projects: [], isLoading: false }) }));
vi.mock('@src/hooks/use-desktops', () => ({
  useDesktops: () => ({
    desktops: [{ id: 'node-1', name: 'Desk One' }],
    isLoading: false,
    refetch: vi.fn(),
    launch: vi.fn(),
    launching: false,
    steps: [],
    launchUrl: null,
    openDesktop: vi.fn(),
    renameDesktop: vi.fn(),
    deleteDesktop: vi.fn(),
    deletingId: null,
    details: {},
  }),
  nextDesktopName: () => 'Desktop 2',
}));
vi.mock('@src/pages/hub-home/NewDesktopDialog', () => ({ NewDesktopDialog: () => null }));

import { PageId, ViewType } from '@sdk';

import { HubHome } from '@src/pages/hub-home/HubHome';

describe('HubHome desktop secrets button', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it('opens Credentials on the hub page, never a page-less dock', async () => {
    render(<HubHome />);

    await userEvent.click(screen.getByTestId('desktop-secrets'));

    expect(h.openDock).not.toHaveBeenCalled();
    expect(h.openPage).toHaveBeenCalledWith(PageId.HUB, ViewType.CREDENTIALS, 'environment');
  });
});
