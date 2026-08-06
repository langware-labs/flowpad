/**
 * The navigation bar itself.
 *
 * Two invariants worth pinning beyond "it renders": the runtime signal reaches
 * the chip (it is how you know whose machine you're on), and a crumb click is
 * URL-first — `openDock` and nothing else. The second is the rule that keeps
 * quietly eroding, so it gets an explicit assertion.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FileText } from 'lucide-react';

const openDock = vi.hoisted(() => vi.fn());
const nav = vi.hoisted(() => ({
  canGoBack: true,
  canGoForward: false,
  goBack: vi.fn(),
  goForward: vi.fn(),
  reload: vi.fn(),
  hardReload: vi.fn(),
  reloading: false,
}));
// Literal, not `RuntimeKind.SANDBOX`: vi.mock factories are hoisted above the
// imports, so referencing the enum here is a TDZ error.
const runtimeKind = vi.hoisted(() => ({ current: 'sandbox' as string }));
const crumbs = vi.hoisted(() => ({ current: [] as unknown[] }));
const setContext = vi.hoisted(() => vi.fn());
const routerNavigate = vi.hoisted(() => vi.fn());

vi.mock('@src/navigation/use-history-nav', () => ({ useHistoryNav: () => nav }));
// The bar's Home falls back to the app root through the router.
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useNavigate: () => routerNavigate,
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock }, currentDock: { tabHash: 'h1' } }),
}));
vi.mock('@src/hooks/useContext', () => ({
  useContext: () => ({ runtimeKind: runtimeKind.current, project: null, activeEntity: null, activeEntityTypeId: null }),
}));
vi.mock('@src/components/top-nav-bar/use-entity-breadcrumbs', () => ({
  useEntityBreadcrumbs: () => ({
    crumbs: crumbs.current,
    resolving: false,
    targetTypeId: null,
    targetTitle: 'Design notes',
  }),
}));
vi.mock('@src/components/top-nav-bar/TopBarActions', () => ({ TopBarActions: () => null }));
// The project switcher is a heavy surface with its own tests; here we only care
// THAT the project crumb summons it.
vi.mock('@src/components/open-project-component/open-project-component', () => ({
  OpenProjectComponent: ({ open }: { open: boolean }) => (open ? <div data-testid="project-switcher" /> : null),
}));
vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));
// The single writer of URL-derived context — a crumb click must never touch it.
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return { ...actual, dataContext: { ...actual.dataContext, setContextEntityTypeId: setContext } };
});

import { RuntimeKind } from '@sdk';
import { TopNavBar } from '@src/components/top-nav-bar/TopNavBar';
import { RUNTIME_CLASS } from '@src/components/top-nav-bar/runtime-appearance';
import { TooltipProvider } from '@src/components/ui/tooltip';

/** The app mounts the bar inside App.tsx's global TooltipProvider; mirror that
 *  here so the tooltips have the context they expect. */
function renderBar() {
  return render(
    <TooltipProvider>
      <TopNavBar />
    </TooltipProvider>,
  );
}

const crumb = (key: string, kind: string, pointer: unknown = null) => ({
  key,
  label: key,
  Icon: FileText,
  pointer,
  kind,
});

beforeEach(() => {
  runtimeKind.current = RuntimeKind.SANDBOX;
  nav.canGoBack = true;
  nav.canGoForward = false;
  crumbs.current = [crumb('Acme', 'project'), crumb('Design notes', 'current')];
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('the navigation bar', () => {
  it('wears the runtime color and names the runtime', () => {
    renderBar();

    const bar = screen.getByTestId('top-nav-bar');
    expect(bar.getAttribute('data-runtime')).toBe(RuntimeKind.SANDBOX);

    const chip = screen.getByTestId('top-nav-runtime-chip');
    expect(chip.textContent).toContain('Cloud Sandbox');
    for (const token of RUNTIME_CLASS[RuntimeKind.SANDBOX].split(/\s+/)) {
      expect(chip.className).toContain(token);
    }
  });

  it('does not nest a button inside a button', () => {
    // The bar holds many independent controls; nesting them would be invalid
    // HTML that React warns about and screen readers mis-announce.
    renderBar();
    const bar = screen.getByTestId('top-nav-bar');

    expect(bar.tagName).toBe('DIV');
    expect(bar.querySelectorAll('button button')).toHaveLength(0);
  });

  it('disables each history button when there is nowhere to go', () => {
    renderBar();

    expect((screen.getByTestId('top-nav-back') as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId('top-nav-forward') as HTMLButtonElement).disabled).toBe(true);
  });

  it('carries Home, which the rail no longer does', () => {
    renderBar();

    expect(screen.getByTestId('top-nav-home')).toBeTruthy();
  });

  it('reloads softly, and hard only on a modifier click', async () => {
    const user = userEvent.setup();
    renderBar();

    await user.click(screen.getByTestId('top-nav-reload'));
    expect(nav.reload).toHaveBeenCalledTimes(1);
    expect(nav.hardReload).not.toHaveBeenCalled();

    await user.keyboard('{Meta>}');
    await user.click(screen.getByTestId('top-nav-reload'));
    await user.keyboard('{/Meta}');
    expect(nav.hardReload).toHaveBeenCalledTimes(1);
  });

  it('navigates by URL alone when a crumb is clicked', async () => {
    const pointer = { fake: 'pointer' };
    crumbs.current = [
      crumb('Acme', 'project'),
      crumb('Research', 'ancestor', pointer),
      crumb('Design notes', 'current'),
    ];
    const user = userEvent.setup();
    renderBar();

    await user.click(screen.getByText('Research'));

    expect(openDock).toHaveBeenCalledTimes(1);
    expect(openDock).toHaveBeenCalledWith(pointer);
    // URL-first: the loader is the single writer of context, never the click.
    expect(setContext).not.toHaveBeenCalled();
  });

  it('opens the project from its crumb', async () => {
    // A breadcrumb segment navigates to what it names — the project crumb is
    // not an exception.
    const pointer = { fake: 'project-pointer' };
    crumbs.current = [crumb('Acme', 'project', pointer), crumb('Design notes', 'current')];
    const user = userEvent.setup();
    renderBar();

    await user.click(screen.getByText('Acme'));

    expect(openDock).toHaveBeenCalledWith(pointer);
    expect(screen.queryByTestId('project-switcher')).toBeNull();
  });

  it('changes project from the select button beside the crumb', async () => {
    // Switching is a different verb from opening, so it gets its own control
    // rather than stealing the crumb's click.
    crumbs.current = [crumb('Acme', 'project', { fake: 'p' }), crumb('Design notes', 'current')];
    const user = userEvent.setup();
    renderBar();

    expect(screen.queryByTestId('project-switcher')).toBeNull();
    await user.click(screen.getByTestId('top-nav-project-select'));

    expect(screen.getByTestId('project-switcher')).toBeTruthy();
    expect(openDock).not.toHaveBeenCalled();
  });

  it('leaves the current crumb unclickable', async () => {
    const user = userEvent.setup();
    renderBar();

    await user.click(screen.getByText('Design notes'));

    expect(openDock).not.toHaveBeenCalled();
  });
});
