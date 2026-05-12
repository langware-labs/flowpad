import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ScopeFilterBar } from '@src/components/assets/ScopeFilterBar';

describe('ScopeFilterBar', () => {
  it('renders three scope buttons', () => {
    render(
      <ScopeFilterBar
        scope="all"
        projectIds={[]}
        currentProjectId={null}
        onScopeChange={() => {}}
        onProjectIdsChange={() => {}}
      />,
    );
    expect(screen.getByText('All')).toBeDefined();
    expect(screen.getByText('User')).toBeDefined();
    expect(screen.getByText('Project')).toBeDefined();
  });

  it('calls onScopeChange when a button is clicked', () => {
    const onScopeChange = vi.fn();
    render(
      <ScopeFilterBar
        scope="all"
        projectIds={[]}
        currentProjectId={null}
        onScopeChange={onScopeChange}
        onProjectIdsChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('User'));
    expect(onScopeChange).toHaveBeenCalledWith('user');
  });

  it('defaults the project scope to the current project', () => {
    const onScopeChange = vi.fn();
    const onProjectIdsChange = vi.fn();

    render(
      <ScopeFilterBar
        scope="all"
        projectIds={[]}
        currentProjectId="project-1"
        onScopeChange={onScopeChange}
        onProjectIdsChange={onProjectIdsChange}
      />,
    );

    const projectButton = screen.getByText('Project').closest('button');
    expect(projectButton?.disabled).toBe(false);

    fireEvent.click(screen.getByText('Project'));

    expect(onProjectIdsChange).toHaveBeenCalledWith(['project-1']);
    expect(onScopeChange).toHaveBeenCalledWith('project');
  });
});
