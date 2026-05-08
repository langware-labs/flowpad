import { render, screen } from '@testing-library/react';
import { ProjectsCounterChip } from '@src/components/terminal/ProjectsCounterChip';
import { useAllTerminals } from '@src/hooks/useActiveTerminals';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@src/hooks/useActiveTerminals', () => ({
  useAllTerminals: vi.fn(),
}));

const mockUseAllTerminals = vi.mocked(useAllTerminals);

describe('ProjectsCounterChip', () => {
  it('counts tabs using the row projectId when cached entities are stale', () => {
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

    render(<ProjectsCounterChip currentProjectId={projectA} />);

    const chip = screen.getByTestId('projects-counter-chip');
    expect(chip.textContent).toContain('3');
    expect(chip.getAttribute('aria-label')).toBe('3 active terminals across all projects');
  });
});
