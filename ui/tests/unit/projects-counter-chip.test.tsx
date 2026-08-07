import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectsCounterChip } from '@src/components/terminal/ProjectsCounterChip';
import { useTabProjectBuckets, type TabProjectBucket } from '@src/tabs/useTabs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navMocks = vi.hoisted(() => ({
  openDock: vi.fn(),
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: navMocks,
  }),
  useCurrentDock: () => null,
}));

vi.mock('@src/tabs/useTabs', () => ({
  useTabProjectBuckets: vi.fn(),
}));

const entryMocks = vi.hoisted(() => ({
  dockForProjectEntry: vi.fn(() => Promise.resolve({ __dock: 'project' })),
  dockForGlobalEntry: vi.fn(() => Promise.resolve({ __dock: 'global' })),
}));

vi.mock('@src/tabs/project-entry', () => ({
  dockForProjectEntry: entryMocks.dockForProjectEntry,
  dockForGlobalEntry: entryMocks.dockForGlobalEntry,
}));

const mockUseTabProjectBuckets = vi.mocked(useTabProjectBuckets);

function makeProject(id: string, displayName: string) {
  return {
    typeId: { type: 'project', id },
    name: displayName,
    fs_storage_mount_path: `/tmp/${displayName}`,
    getDisplayName: () => displayName,
  };
}

function makeBucket(id: string, displayName: string, tabCount: number): TabProjectBucket {
  return {
    projectId: id,
    project: makeProject(id, displayName) as unknown as TabProjectBucket['project'],
    state: 'live',
    tabCount,
    recover: vi.fn(),
  };
}

describe('ProjectsCounterChip', () => {
  beforeEach(() => {
    navMocks.openDock.mockReset();
    entryMocks.dockForProjectEntry.mockClear();
    entryMocks.dockForGlobalEntry.mockClear();
    mockUseTabProjectBuckets.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  function seedBuckets(globalTabCount = 0) {
    const projectA = '11111111-1111-4111-8111-111111111111';
    const projectB = '22222222-2222-4222-8222-222222222222';
    mockUseTabProjectBuckets.mockReturnValue({
      buckets: [makeBucket(projectA, '11111111', 2), makeBucket(projectB, '22222222', 1)],
      globalTabCount,
    });
    return { projectA, projectB };
  }

  it('shows the project name plus the open-projects count, tabs count in the label only', () => {
    const { projectA } = seedBuckets();

    render(<ProjectsCounterChip currentProjectId={projectA} />);

    const chip = screen.getByTestId('projects-counter-chip');
    // Scope label + the open-PROJECTS count (2 buckets). The open-TABS count
    // (3) is not painted — it lives in the tooltip and the aria-label.
    expect(chip.textContent).toBe('111111112');
    expect(chip.getAttribute('aria-label')).toBe('11111111 — 2 open projects, 3 open tabs');
  });

  it('keeps per-project tab counts in the popover list', async () => {
    const { projectA } = seedBuckets();

    render(<ProjectsCounterChip currentProjectId={projectA} />);

    await userEvent.click(screen.getByTestId('projects-counter-chip'));

    expect(screen.getByRole('button', { name: '11111111 2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '22222222 1' })).toBeTruthy();
  });

  it('renders one row per bucket and nothing else — no action strip', async () => {
    const { projectA } = seedBuckets();

    render(<ProjectsCounterChip currentProjectId={projectA} />);
    await userEvent.click(screen.getByTestId('projects-counter-chip'));

    // Positive guard: the popover is a PURE project list. Anything re-added
    // below the rows (a worker-launch toolbar, a history button, a picker)
    // shows up as an extra button here.
    const popover = screen.getByTestId('projects-counter-popover');
    expect(within(popover).getAllByRole('button')).toHaveLength(2);
  });

  it('sorts buckets alphabetically without bumping the current project to the top', async () => {
    const idZebra = '33333333-3333-4333-8333-333333333333';
    const idAlpha = '44444444-4444-4444-8444-444444444444';
    mockUseTabProjectBuckets.mockReturnValue({
      buckets: [makeBucket(idZebra, 'zebra', 1), makeBucket(idAlpha, 'alpha', 1)],
      globalTabCount: 0,
    });

    // zebra is current — it must stay in alphabetical position, only highlighted.
    render(<ProjectsCounterChip currentProjectId={idZebra} />);
    await userEvent.click(screen.getByTestId('projects-counter-chip'));

    // Scope to the popover's rows — the chip TRIGGER button also carries the
    // current-project label ("zebra…"), which must not pollute the row list.
    const rows = within(screen.getByTestId('projects-counter-popover'))
      .getAllByRole('button')
      .map((b) => b.textContent ?? '')
      .filter((t) => t.startsWith('alpha') || t.startsWith('zebra'));
    expect(rows).toEqual(['alpha1', 'zebra1']);
    expect(screen.getByRole('button', { name: 'zebra 1' }).getAttribute('aria-current')).toBe('true');
  });

  it('hides the chip entirely when there are zero project buckets', () => {
    // A strip whose only tabs are global has no project tab to count, so the
    // chip stays hidden rather than advertising "0 / 0" — the strip's own
    // openers handle the empty case.
    mockUseTabProjectBuckets.mockReturnValue({ buckets: [], globalTabCount: 0 });

    render(<ProjectsCounterChip />);

    expect(screen.queryByTestId('projects-counter-chip')).toBeNull();
  });

  // ─── Global scope ─────────────────────────────────────────────────────────

  it('shows the violet "Global" chip when no project is selected and global tabs exist', () => {
    seedBuckets(3);

    // No currentProjectId ⇒ Global scope.
    render(<ProjectsCounterChip currentProjectId={null} />);

    const chip = screen.getByTestId('projects-counter-chip');
    expect(chip.textContent).toContain('Global');
    expect(chip.getAttribute('aria-label')).toBe('Global — 2 open projects, 3 open tabs');
  });

  it('lists a current-marked Global row (with its count) above the projects', async () => {
    seedBuckets(3);

    render(<ProjectsCounterChip currentProjectId={null} />);
    await userEvent.click(screen.getByTestId('projects-counter-chip'));

    const globalRow = screen.getByTestId('projects-counter-global');
    expect(globalRow.getAttribute('aria-current')).toBe('true');
    expect(globalRow.textContent).toContain('Global');
    expect(globalRow.textContent).toContain('3');
  });

  it('navigates to the Global scope when the Global row is clicked', async () => {
    seedBuckets(3);

    render(<ProjectsCounterChip currentProjectId={null} />);
    await userEvent.click(screen.getByTestId('projects-counter-chip'));
    await userEvent.click(screen.getByTestId('projects-counter-global'));

    expect(entryMocks.dockForGlobalEntry).toHaveBeenCalledTimes(1);
    expect(navMocks.openDock).toHaveBeenCalledWith({ __dock: 'global' });
  });

  it('does NOT show Global while a project is selected (strictly current-only)', async () => {
    const { projectA } = seedBuckets(3);

    render(<ProjectsCounterChip currentProjectId={projectA} />);
    const chip = screen.getByTestId('projects-counter-chip');
    // Trigger reads the project, not Global.
    expect(chip.textContent).not.toContain('Global');
    await userEvent.click(chip);
    expect(screen.queryByTestId('projects-counter-global')).toBeNull();
  });

  it('hides the chip when in Global scope but there are no global tabs and no projects', () => {
    mockUseTabProjectBuckets.mockReturnValue({ buckets: [], globalTabCount: 0 });

    render(<ProjectsCounterChip currentProjectId={null} />);

    expect(screen.queryByTestId('projects-counter-chip')).toBeNull();
  });
});
