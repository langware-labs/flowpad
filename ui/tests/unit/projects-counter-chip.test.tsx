import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectsCounterChip } from '@src/components/terminal/ProjectsCounterChip';
import { useTabProjectBuckets, type TabProjectBucket } from '@src/tabs/useTabs';
import { useAllProjects } from '@src/hooks/use-all-projects';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navMocks = vi.hoisted(() => ({
  openDock: vi.fn(),
}));

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: navMocks,
  }),
}));

vi.mock('@src/tabs/useTabs', () => ({
  useTabProjectBuckets: vi.fn(),
}));

vi.mock('@src/hooks/use-all-projects', () => ({
  useAllProjects: vi.fn(),
}));

const mockUseTabProjectBuckets = vi.mocked(useTabProjectBuckets);
const mockUseAllProjects = vi.mocked(useAllProjects);

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
    mockUseTabProjectBuckets.mockReset();
    mockUseAllProjects.mockReset();
    mockUseAllProjects.mockReturnValue({ projects: [], isLoading: false });
    // WorkerToolbar persists the last-launched worker (rememberWorker) and reads
    // the view mode from localStorage. Clear it so every test starts in the
    // standard `lastOpened` mode with `claude_code` as the primary worker —
    // otherwise a test that launches codex would make codex primary in the next.
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  function seedBuckets() {
    const projectA = '11111111-1111-4111-8111-111111111111';
    const projectB = '22222222-2222-4222-8222-222222222222';
    mockUseTabProjectBuckets.mockReturnValue({
      buckets: [makeBucket(projectA, '11111111', 2), makeBucket(projectB, '22222222', 1)],
    });
    return { projectA, projectB };
  }

  it('counts active projects while including open-tab total in the label', () => {
    const { projectA } = seedBuckets();

    render(<ProjectsCounterChip currentProjectId={projectA} />);

    const chip = screen.getByTestId('projects-counter-chip');
    expect(chip.textContent).toContain('2');
    // The chip labels the current project as a prefix segment (added 5937eaa4):
    // `<projectName> — <count summary>`.
    expect(chip.getAttribute('aria-label')).toBe('11111111 — 2 active projects with 3 open tabs');
  });

  it('keeps per-project tab counts in the popover list', async () => {
    const { projectA } = seedBuckets();

    render(<ProjectsCounterChip currentProjectId={projectA} />);

    await userEvent.click(screen.getByTestId('projects-counter-chip'));

    expect(screen.getByRole('button', { name: '11111111 2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '22222222 1' })).toBeTruthy();
  });

  it('hides the action strip when no callbacks are provided', async () => {
    const { projectA } = seedBuckets();

    render(<ProjectsCounterChip currentProjectId={projectA} />);
    await userEvent.click(screen.getByTestId('projects-counter-chip'));

    expect(screen.queryByTestId('projects-counter-actions')).toBeNull();
  });

  it('arms claude from the row, excludes already-open projects, and launches on pick', async () => {
    const { projectA } = seedBuckets();
    // /tmp/11111111 and /tmp/22222222 are the mount paths of the open buckets.
    mockUseAllProjects.mockReturnValue({
      projects: [
        { cwd: '/tmp/11111111', modified_at: null },
        { cwd: '/tmp/fresh-project', modified_at: null },
      ] as never,
      isLoading: false,
    });
    const onLaunchProjectPath = vi.fn();

    render(<ProjectsCounterChip currentProjectId={projectA} onLaunchProjectPath={onLaunchProjectPath} />);
    await userEvent.click(screen.getByTestId('projects-counter-chip'));
    // Clicking the (primary) Claude worker icon arms it and opens the picker.
    // The launch buttons come from the shared WorkerToolbar, whose testids are
    // `<prefix>-launch-<workerType>` (claude_code is the default primary).
    await userEvent.click(screen.getByTestId('projects-counter-open-launch-claude_code'));

    // Already-open project is filtered out of the picker.
    expect(screen.getByTestId('projects-counter-picker')).toBeTruthy();
    expect(screen.queryByText('/tmp/11111111')).toBeNull();

    // Picking a project launches the armed worker immediately.
    await userEvent.click(screen.getByText('fresh-project'));
    expect(onLaunchProjectPath).toHaveBeenCalledWith('/tmp/fresh-project', 'claude_code');
  });

  it('launches codex when armed via the codex worker icon', async () => {
    const { projectA } = seedBuckets();
    mockUseAllProjects.mockReturnValue({
      projects: [{ cwd: '/tmp/fresh-project', modified_at: null }] as never,
      isLoading: false,
    });
    const onLaunchProjectPath = vi.fn();

    render(<ProjectsCounterChip currentProjectId={projectA} onLaunchProjectPath={onLaunchProjectPath} />);
    await userEvent.click(screen.getByTestId('projects-counter-chip'));
    // In standard (lastOpened) mode only the primary worker shows up front;
    // codex lives behind the "more" chevron. Expand, then arm codex.
    await userEvent.click(screen.getByTestId('projects-counter-open-launch-more'));
    await userEvent.click(screen.getByTestId('projects-counter-open-launch-codex'));
    await userEvent.click(screen.getByText('fresh-project'));

    expect(onLaunchProjectPath).toHaveBeenCalledWith('/tmp/fresh-project', 'codex');
  });

  it('opens history via the strip icon button and closes the popover', async () => {
    const { projectA } = seedBuckets();
    const onOpenHistory = vi.fn();

    render(<ProjectsCounterChip currentProjectId={projectA} onOpenHistory={onOpenHistory} />);
    await userEvent.click(screen.getByTestId('projects-counter-chip'));
    // Without a launch callback the WorkerToolbar isn't rendered — the strip
    // carries only the history button.
    expect(screen.queryByTestId('projects-counter-open-launch-toolbar')).toBeNull();
    await userEvent.click(screen.getByTestId('projects-counter-open-history'));

    expect(onOpenHistory).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('projects-counter-popover')).toBeNull();
  });

  it('renders a label-free icon strip with worker and history buttons', async () => {
    const { projectA } = seedBuckets();
    const onOpenHistory = vi.fn();

    render(
      <ProjectsCounterChip currentProjectId={projectA} onLaunchProjectPath={vi.fn()} onOpenHistory={onOpenHistory} />,
    );
    await userEvent.click(screen.getByTestId('projects-counter-chip'));

    // All actions live inside the strip — no label lines. The worker-launch
    // affordance is the shared WorkerToolbar (primary worker + "more" chevron);
    // the history icon button sits beside it.
    const strip = screen.getByTestId('projects-counter-actions');
    expect(strip.contains(screen.getByTestId('projects-counter-open-launch-toolbar'))).toBe(true);
    expect(strip.contains(screen.getByTestId('projects-counter-open-launch-claude_code'))).toBe(true);
    expect(strip.contains(screen.getByTestId('projects-counter-open-launch-more'))).toBe(true);
    const historyButton = screen.getByTestId('projects-counter-open-history');
    expect(strip.contains(historyButton)).toBe(true);
    expect(screen.queryByText('Open another project…')).toBeNull();
    expect(screen.queryByText('Open from history…')).toBeNull();

    // Codex is reachable once the chevron expands the toolbar.
    await userEvent.click(screen.getByTestId('projects-counter-open-launch-more'));
    expect(strip.contains(screen.getByTestId('projects-counter-open-launch-codex'))).toBe(true);

    await userEvent.click(historyButton);
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('projects-counter-popover')).toBeNull();
  });

  it('sorts buckets alphabetically without bumping the current project to the top', async () => {
    const idZebra = '33333333-3333-4333-8333-333333333333';
    const idAlpha = '44444444-4444-4444-8444-444444444444';
    mockUseTabProjectBuckets.mockReturnValue({
      buckets: [makeBucket(idZebra, 'zebra', 1), makeBucket(idAlpha, 'alpha', 1)],
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
    // chip stays hidden rather than advertising "0 / 0" — even when a launch
    // callback is provided (the strip's own openers handle the empty case).
    mockUseTabProjectBuckets.mockReturnValue({ buckets: [] });
    const onLaunchProjectPath = vi.fn();

    render(<ProjectsCounterChip onLaunchProjectPath={onLaunchProjectPath} />);

    expect(screen.queryByTestId('projects-counter-chip')).toBeNull();
  });
});
