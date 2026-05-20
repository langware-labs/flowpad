import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectsCounterChip } from '@src/components/terminal/ProjectsCounterChip';
import {
  useTerminalProjectBuckets,
  type TerminalProjectBucket,
} from '@src/hooks/useActiveTerminals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/hooks/useActiveTerminals', () => ({
  useTerminalProjectBuckets: vi.fn(),
}));

const mockUseTerminalProjectBuckets = vi.mocked(useTerminalProjectBuckets);

function makeProject(id: string, displayName: string) {
  return {
    typeId: { type: 'project', id },
    name: displayName,
    fs_storage_mount_path: `/tmp/${displayName}`,
    getDisplayName: () => displayName,
  };
}

function makeBucket(
  id: string,
  displayName: string,
  tabCount: number,
): TerminalProjectBucket {
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
});
