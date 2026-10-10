/**
 * The ⚡ in the navigation bar: a place (the automations list), opened by URL alone, with a
 * counter of what started in the last hour — and no badge at zero.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@src/components/ui/tooltip';

const openDock = vi.hoisted(() => vi.fn());
const started = vi.hoisted(() => ({ current: 0 }));
vi.mock('@src/navigation/use-history-nav', () => ({
  useHistoryNav: () => ({ canGoBack: false, canGoForward: false, goBack: vi.fn(), goForward: vi.fn(), reload: vi.fn() }),
}));
vi.mock('@sdk/decision', () => ({ navigationDecision: vi.fn() }));
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => vi.fn(),
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock, goHome: vi.fn(), openTab: vi.fn() }, currentDock: { tabHash: 'h1' } }),
}));
vi.mock('@src/hooks/useContext', () => ({
  useContext: () => ({ runtimeKind: 'desktop', project: null, computeNode: null, desktopInfo: null, workdir: null, activeEntity: null, activeEntityTypeId: null }),
}));
vi.mock('@src/components/top-nav-bar/use-entity-breadcrumbs', () => ({
  useEntityBreadcrumbs: () => ({ crumbs: [], resolving: false, targetTypeId: null, targetTitle: '' }),
}));
vi.mock('@src/components/top-nav-bar/TopBarActions', () => ({ TopBarActions: () => null }));
vi.mock('@src/components/top-nav-bar/NewChatButton', () => ({ NewChatButton: () => null }));
vi.mock('@src/components/top-nav-bar/RuntimeChip', () => ({ RuntimeChip: () => null }));
vi.mock('@src/components/top-nav-bar/ProjectSetupButton', () => ({ ProjectSetupButton: () => null }));
vi.mock('@src/components/workspace/workspace-switcher', () => ({ NewWorkspaceDialogHost: () => null }));
vi.mock('@src/hooks/use-workspaces', () => ({ useActiveWorkspace: () => ({ contains: () => true }) }));
vi.mock('@src/tabs/use-tab-manager', () => ({ useLastKnownTab: () => null, useTabProjectBuckets: () => ({ buckets: [], globalTabCount: 0 }) }));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() }, askNotification: vi.fn() }));
vi.mock('@src/components/floating-chat/floating-chat-context', () => ({ useOptionalFloatingChat: () => null }));
vi.mock('@src/hooks/automations/useAutomations', () => ({ useStartedLastHour: () => started.current }));

import { TopNavBar } from '@src/components/top-nav-bar/TopNavBar';
import { DockPointer } from '@src/navigation/DockPointer';

beforeEach(() => {
  started.current = 0;
  openDock.mockClear();
});
afterEach(cleanup);

describe('the automations button', () => {
  it('opens the automations list by URL alone', async () => {
    render(<TooltipProvider><TopNavBar /></TooltipProvider>);
    await userEvent.setup().click(screen.getByTestId('top-nav-automations'));
    expect(openDock).toHaveBeenCalledTimes(1);
    expect(openDock.mock.calls[0][0].toUrl('/')).toBe(DockPointer.forAutomations().toUrl('/'));
  });

  it('shows no badge at zero, and the count otherwise', () => {
    const first = render(<TooltipProvider><TopNavBar /></TooltipProvider>);
    expect(screen.queryByTestId('top-nav-automations-badge')).toBeNull();
    first.unmount();
    started.current = 3;
    render(<TooltipProvider><TopNavBar /></TooltipProvider>);
    expect(screen.getByTestId('top-nav-automations-badge').textContent).toBe('3');
    expect(screen.getByTestId('top-nav-automations').getAttribute('aria-label')).toContain('3');
  });
});
