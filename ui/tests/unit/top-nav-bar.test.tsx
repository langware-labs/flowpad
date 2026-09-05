/**
 * The navigation bar itself.
 *
 * Two invariants worth pinning beyond "it renders": the runtime signal reaches
 * the chip (it is how you know whose machine you're on), and a crumb click is
 * URL-first — `openDock` and nothing else. The second is the rule that keeps
 * quietly eroding, so it gets an explicit assertion.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
/** The active project, when there is one — drives the project button's presence. */
const activeProject = vi.hoisted(() => ({
  current: null as { id: string; displayName?: string; fs_storage_mount_path?: string } | null,
}));
const activeComputeNode = vi.hoisted(() => ({ current: null as { typeId: unknown } | null }));
const copyToClipboard = vi.hoisted(() => vi.fn());
const openFolder = vi.hoisted(() => vi.fn());
vi.mock('@src/hooks/useContext', () => ({
  useContext: () => ({
    runtimeKind: runtimeKind.current,
    project: activeProject.current,
    computeNode: activeComputeNode.current,
    desktopInfo: null,
    workdir: null,
    activeEntity: null,
    activeEntityTypeId: null,
  }),
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
/** The open project buckets behind the chip's list. Mocking the tab manager is
 *  mandatory here: unmocked, the hook starts the real one against the unit
 *  tier's no-backend host. */
const buckets = vi.hoisted(() => ({ current: { buckets: [] as unknown[], globalTabCount: 0 } }));
const dockForProjectEntry = vi.hoisted(() => vi.fn(() => Promise.resolve({ __dock: 'project' })));
const dockForGlobalEntry = vi.hoisted(() => vi.fn(() => Promise.resolve({ __dock: 'global' })));
const openWikiModal = vi.hoisted(() => vi.fn());
vi.mock('@src/tabs/use-tab-manager', () => ({ useTabProjectBuckets: () => buckets.current }));
vi.mock('@src/tabs/project-entry', () => ({ dockForProjectEntry, dockForGlobalEntry }));
vi.mock('@src/components/wiki-tip/wiki-modal', () => ({ openWikiModal }));
// The single writer of URL-derived context — a crumb click must never touch it.
vi.mock('@sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sdk')>();
  return {
    ...actual,
    copyToClipboard,
    fsManager: { ...actual.fsManager, open: openFolder },
    dataContext: { ...actual.dataContext, setContextEntityTypeId: setContext },
  };
});

import { RuntimeKind, TypeId } from '@sdk';
import { TopNavBar } from '@src/components/top-nav-bar/TopNavBar';
import { RUNTIME_CLASS } from '@src/components/top-nav-bar/runtime-appearance';
import { TooltipProvider } from '@src/components/ui/tooltip';
import { DockPointer } from '@src/navigation/DockPointer';
import { makeBucket } from '../utils/terminal-tab-fixtures';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_PROJECT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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
  activeProject.current = null;
  activeComputeNode.current = null;
  nav.canGoBack = true;
  nav.canGoForward = false;
  crumbs.current = [crumb('Acme', 'project'), crumb('Design notes', 'current')];
  buckets.current = { buckets: [], globalTabCount: 0 };
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

  // Inherited from the rail's project item when that icon moved up here
  // (8d4d03dc4), and since folded into the runtime chip as its name segment.
  // Same rule it always had: URL-first. Was tests/react/assets-sidebar-scope-open.test.tsx.
  it('opens the project by URL alone from the chip name', async () => {
    activeProject.current = { id: PROJECT_ID, displayName: 'Acme' };
    const user = userEvent.setup();
    renderBar();

    await user.click(screen.getByTestId('top-nav-project'));

    expect(openDock).toHaveBeenCalledTimes(1);
    expect(openDock).toHaveBeenCalledWith(DockPointer.forProject(PROJECT_ID));
    // URL-first: the loader is the single writer of context, never the click.
    expect(setContext).not.toHaveBeenCalled();
  });

  it('opens the project list from the chip name when no project is active', async () => {
    // Without a project there is no home to address, so the name segment is
    // a second way into the list rather than a dead control.
    activeProject.current = null;
    const user = userEvent.setup();
    renderBar();

    await user.click(screen.getByTestId('top-nav-project'));

    expect(await screen.findByTestId('top-nav-project-popover')).toBeTruthy();
    expect(openDock).not.toHaveBeenCalled();
  });

  it('shows the active project name on the runtime-colored chip', () => {
    activeProject.current = { id: PROJECT_ID, displayName: 'Acme' };
    renderBar();

    const chip = screen.getByTestId('top-nav-runtime-chip');
    expect(chip.textContent).toContain('Acme');
    expect(chip.textContent).not.toContain('Cloud Sandbox');
    expect(chip.getAttribute('data-runtime')).toBe(RuntimeKind.SANDBOX);
    // The color stays: the project name replaces the runtime's word, never its signal.
    for (const token of RUNTIME_CLASS[RuntimeKind.SANDBOX].split(/\s+/)) {
      expect(chip.className).toContain(token);
    }
  });

  it('opens the project list from the chevron and switches project by URL alone', async () => {
    activeProject.current = { id: PROJECT_ID, displayName: 'Acme' };
    buckets.current = { buckets: [makeBucket(PROJECT_ID, 'Acme', 2), makeBucket(OTHER_PROJECT_ID, 'Beta', 1)], globalTabCount: 0 };
    const user = userEvent.setup();
    renderBar();

    await user.click(screen.getByTestId('top-nav-project-list'));

    const popover = await screen.findByTestId('top-nav-project-popover');
    expect(within(popover).getAllByRole('button')).toHaveLength(2);
    await user.click(within(popover).getByRole('button', { name: 'Beta 1' }));

    await waitFor(() => expect(openDock).toHaveBeenCalledWith({ __dock: 'project' }));
    expect(dockForProjectEntry).toHaveBeenCalledWith(OTHER_PROJECT_ID, { tabHash: 'h1' });
    // URL-first: the loader is the single writer of context, never the click.
    expect(setContext).not.toHaveBeenCalled();
  });

  it('explains the empty list instead of hiding the chip', async () => {
    // The strip's chip hides itself with nothing to count; this one is the
    // runtime signal too, so it stays and its click still answers.
    activeProject.current = null;
    const user = userEvent.setup();
    renderBar();

    expect(screen.getByTestId('top-nav-runtime-chip')).toBeTruthy();
    await user.click(screen.getByTestId('top-nav-project-list'));

    const popover = await screen.findByTestId('top-nav-project-popover');
    expect(popover.textContent).toContain('No project has open tabs yet.');
  });

  it('explains the runtime on hover and peeks the wiki page from Learn more', async () => {
    activeProject.current = { id: PROJECT_ID, displayName: 'Acme' };
    buckets.current = { buckets: [makeBucket(PROJECT_ID, 'Acme', 2)], globalTabCount: 0 };
    const user = userEvent.setup();
    renderBar();

    await user.hover(screen.getByTestId('top-nav-runtime-chip'));

    const card = await screen.findByTestId('top-nav-runtime-hover');
    expect(card.textContent).toContain('Acme');
    expect(card.textContent).toContain('1 open project');
    expect(card.textContent).toContain('2 open tabs');
    expect(card.textContent).toContain('This UI is served by a cloud sandbox you opened.');

    await user.click(within(card).getByRole('button', { name: 'Learn more' }));

    // A peek, not a navigation. No space named: the modal looks a shipped page
    // up in the assistant's wiki itself (`@local` would resolve against Acme).
    expect(openWikiModal).toHaveBeenCalledWith('Runtime environments', undefined, undefined);
    expect(openDock).not.toHaveBeenCalled();
  });

  it('closes the hover card when the list opens', async () => {
    activeProject.current = { id: PROJECT_ID, displayName: 'Acme' };
    const user = userEvent.setup();
    renderBar();

    await user.hover(screen.getByTestId('top-nav-runtime-chip'));
    await screen.findByTestId('top-nav-runtime-hover');
    await user.click(screen.getByTestId('top-nav-project-list'));

    await screen.findByTestId('top-nav-project-popover');
    await waitFor(() => expect(screen.queryByTestId('top-nav-runtime-hover')).toBeNull());
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

  it('opens the projects list from the project crumb', async () => {
    // The one crumb that does not navigate: it inherited the project chip's
    // job, which was choosing a project. Opening the project itself is the
    // briefcase button in the nav cluster.
    activeProject.current = { id: PROJECT_ID, displayName: 'Acme' };
    const user = userEvent.setup();
    renderBar();

    expect(screen.queryByTestId('project-switcher')).toBeNull();
    await user.click(within(screen.getByTestId('top-nav-address')).getByText('Acme'));

    expect(screen.getByTestId('project-switcher')).toBeTruthy();
    expect(openDock).not.toHaveBeenCalled();
  });

  it('shows and operates on the active project location from the project crumb', async () => {
    const user = userEvent.setup();
    const projectPath = '/Users/me/Flowpad workspace/Acme';
    const computeNodeTypeId = new TypeId('compute_node', '@local');
    activeProject.current = { id: PROJECT_ID, displayName: 'Acme', fs_storage_mount_path: projectPath };
    activeComputeNode.current = { typeId: computeNodeTypeId };
    renderBar();

    await user.hover(within(screen.getByTestId('top-nav-address')).getByText('Acme'));
    expect((await screen.findByTestId('top-nav-project-details')).textContent).toContain(projectPath);
    await user.click(screen.getByTestId('top-nav-project-copy-path'));
    await user.click(screen.getByTestId('top-nav-project-open-folder'));

    expect(copyToClipboard).toHaveBeenCalledWith(projectPath);
    expect(openFolder).toHaveBeenCalledWith(computeNodeTypeId, 'Users/me/Flowpad workspace/Acme');
  });

  it('leaves the current crumb unclickable', async () => {
    const user = userEvent.setup();
    renderBar();

    await user.click(screen.getByText('Design notes'));

    expect(openDock).not.toHaveBeenCalled();
  });

  // Search is the bar's job now — the rail's magnifier is gone — and it takes
  // over the address slot rather than opening beside it.
  it('turns the address into a query field, and Escape gives it back', async () => {
    const user = userEvent.setup();
    renderBar();

    await user.click(screen.getByTestId('top-nav-search-open'));

    expect(document.activeElement).toBe(screen.getByTestId('top-nav-search-input'));
    expect(screen.queryByTestId('top-nav-address')).toBeNull();

    await user.keyboard('{Escape}');

    expect(screen.getByTestId('top-nav-address')).toBeTruthy();
    expect(screen.queryByTestId('top-nav-search-input')).toBeNull();
  });

  it('gives the address back when the user clicks outside search', async () => {
    const user = userEvent.setup();
    renderBar();

    await user.click(screen.getByTestId('top-nav-search-open'));
    await user.click(document.body);

    expect(screen.getByTestId('top-nav-address')).toBeTruthy();
    expect(screen.queryByTestId('top-nav-search-input')).toBeNull();
  });
});
