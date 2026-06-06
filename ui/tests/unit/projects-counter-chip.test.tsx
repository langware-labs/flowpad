import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectsCounterChip } from '@src/components/terminal/ProjectsCounterChip';
import { useTerminalProjectBuckets, type TerminalProjectBucket } from '@src/hooks/useActiveTerminals';
import { useAllProjects } from '@src/hooks/use-all-projects';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/hooks/useActiveTerminals', () => ({
  useTerminalProjectBuckets: vi.fn(),
}));

vi.mock('@src/hooks/use-all-projects', () => ({
  useAllProjects: vi.fn(),
}));

const mockUseTerminalProjectBuckets = vi.mocked(useTerminalProjectBuckets);
const mockUseAllProjects = vi.mocked(useAllProjects);

function makeProject(id: string, displayName: string) {
  return {
    typeId: { type: 'project', id },
    name: displayName,
    fs_storage_mount_path: `/tmp/${displayName}`,
    getDisplayName: () => displayName,
  };
}

function makeBucket(id: string, displayName: string, tabCount: number): TerminalProjectBucket {
  const tabs = Array.from({ length: tabCount }, () => ({ projectId: id }));
  return {
    projectId: id,
    project: makeProject(id, displayName) as unknown as TerminalProjectBucket['project'],
    state: 'live',
    tabs: tabs as unknown as TerminalProjectBucket['tabs'],
    recover: vi.fn(),
  };
}

describe('ProjectsCounterChip', () => {
  beforeEach(() => {
    mockUseTerminalProjectBuckets.mockReset();
    mockUseAllProjects.mockReset();
    mockUseAllProjects.mockReturnValue({ projects: [], isLoading: false });
  });

  afterEach(() => {
    cleanup();
  });

  function seedBuckets() {
    const projectA = '11111111-1111-4111-8111-111111111111';
    const projectB = '22222222-2222-4222-8222-222222222222';
    mockUseTerminalProjectBuckets.mockReturnValue({
      buckets: [makeBucket(projectA, '11111111', 2), makeBucket(projectB, '22222222', 1)],
    });
    return { projectA, projectB };
  }

  it('counts active projects while including terminal total in the label', () => {
    const { projectA } = seedBuckets();

    render(<ProjectsCounterChip currentProjectId={projectA} />);

    const chip = screen.getByTestId('projects-counter-chip');
    expect(chip.textContent).toContain('2');
    expect(chip.getAttribute('aria-label')).toBe('2 active projects with 3 terminals');
  });

  it('keeps per-project terminal counts in the popover list', async () => {
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
    // Clicking the worker icon on the row arms it and opens the picker.
    await userEvent.click(screen.getByTestId('projects-counter-open-claude'));

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
    await userEvent.click(screen.getByTestId('projects-counter-open-codex'));
    await userEvent.click(screen.getByText('fresh-project'));

    expect(onLaunchProjectPath).toHaveBeenCalledWith('/tmp/fresh-project', 'codex');
  });

  it('opens history via the strip icon button and closes the popover', async () => {
    const { projectA } = seedBuckets();
    const onOpenHistory = vi.fn();

    render(<ProjectsCounterChip currentProjectId={projectA} onOpenHistory={onOpenHistory} />);
    await userEvent.click(screen.getByTestId('projects-counter-chip'));
    // Without a launch callback the strip carries only the history button.
    expect(screen.queryByTestId('projects-counter-open-claude')).toBeNull();
    await userEvent.click(screen.getByTestId('projects-counter-open-history'));

    expect(onOpenHistory).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('projects-counter-popover')).toBeNull();
  });

  it('renders a label-free icon strip with worker and history buttons', async () => {
    const { projectA } = seedBuckets();
    const onOpenHistory = vi.fn();

    render(
      <ProjectsCounterChip
        currentProjectId={projectA}
        onLaunchProjectPath={vi.fn()}
        onOpenHistory={onOpenHistory}
      />,
    );
    await userEvent.click(screen.getByTestId('projects-counter-chip'));

    // All actions live inside the strip — no label lines.
    const strip = screen.getByTestId('projects-counter-actions');
    expect(strip.contains(screen.getByTestId('projects-counter-open-claude'))).toBe(true);
    expect(strip.contains(screen.getByTestId('projects-counter-open-codex'))).toBe(true);
    const historyButton = screen.getByTestId('projects-counter-open-history');
    expect(strip.contains(historyButton)).toBe(true);
    expect(screen.queryByText('Open another project…')).toBeNull();
    expect(screen.queryByText('Open from history…')).toBeNull();

    await userEvent.click(historyButton);
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('projects-counter-popover')).toBeNull();
  });

  it('sorts buckets alphabetically without bumping the current project to the top', async () => {
    const idZebra = '33333333-3333-4333-8333-333333333333';
    const idAlpha = '44444444-4444-4444-8444-444444444444';
    mockUseTerminalProjectBuckets.mockReturnValue({
      buckets: [makeBucket(idZebra, 'zebra', 1), makeBucket(idAlpha, 'alpha', 1)],
    });

    // zebra is current — it must stay in alphabetical position, only highlighted.
    render(<ProjectsCounterChip currentProjectId={idZebra} />);
    await userEvent.click(screen.getByTestId('projects-counter-chip'));

    const rows = screen
      .getAllByRole('button')
      .map((b) => b.textContent ?? '')
      .filter((t) => t.startsWith('alpha') || t.startsWith('zebra'));
    expect(rows).toEqual(['alpha1', 'zebra1']);
    expect(screen.getByRole('button', { name: 'zebra 1' }).getAttribute('aria-current')).toBe('true');
  });

  it('keeps the chip clickable with zero buckets when a launch callback exists', async () => {
    mockUseTerminalProjectBuckets.mockReturnValue({ buckets: [] });
    const onLaunchProjectPath = vi.fn();

    render(<ProjectsCounterChip onLaunchProjectPath={onLaunchProjectPath} />);

    const chip = screen.getByTestId('projects-counter-chip');
    expect(chip.hasAttribute('disabled')).toBe(false);
    await userEvent.click(chip);
    expect(screen.getByTestId('projects-counter-actions')).toBeTruthy();
  });
});
