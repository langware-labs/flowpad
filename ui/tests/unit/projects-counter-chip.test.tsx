import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectsCounterChip } from '@src/components/terminal/ProjectsCounterChip';
import { useAllTerminals } from '@src/hooks/useActiveTerminals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/hooks/useActiveTerminals', () => ({
  useAllTerminals: vi.fn(),
}));

const mockUseAllTerminals = vi.mocked(useAllTerminals);

describe('ProjectsCounterChip', () => {
  beforeEach(() => {
    mockUseAllTerminals.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  function mockTerminalData() {
    const projectA = '11111111-1111-4111-8111-111111111111';
    const projectB = '22222222-2222-4222-8222-222222222222';

    mockUseAllTerminals.mockReturnValue({
      data: [
        { projectId: projectA, agenticProcess: { project_id: null } },
        { projectId: projectA, agenticProcess: { project_id: null } },
        { projectId: projectB, shell: { project_id: null } },
      ],
      refresh: vi.fn(),
      pushTerminal: vi.fn(),
      removeTerminal: vi.fn(),
      updateTerminal: vi.fn(),
    } as unknown as ReturnType<typeof useAllTerminals>);

    return { projectA, projectB };
  }

  it('counts active projects while including terminal total in the label', () => {
    const { projectA } = mockTerminalData();

    render(<ProjectsCounterChip currentProjectId={projectA} />);

    const chip = screen.getByTestId('projects-counter-chip');
    expect(chip.textContent).toContain('2');
    expect(chip.getAttribute('aria-label')).toBe('2 active projects with 3 terminals');
  });

  it('keeps per-project terminal counts in the popover list', async () => {
    const { projectA } = mockTerminalData();

    render(<ProjectsCounterChip currentProjectId={projectA} />);

    await userEvent.click(screen.getByTestId('projects-counter-chip'));

    expect(screen.getByRole('button', { name: '11111111 2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '22222222 1' })).toBeTruthy();
  });
});
