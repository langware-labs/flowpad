import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ScopeFilterBar } from '@src/components/scope-filter/ScopeFilterBar';

const EMPTY_SCOPE = { user: true, projects: [] as string[] };

describe('ScopeFilterBar', () => {
  it('renders three scope buttons', () => {
    render(
      <ScopeFilterBar
        scope={EMPTY_SCOPE}
        currentProjectId={null}
        onScopeChange={() => {}}
      />,
    );
    expect(screen.getByText('Both')).toBeDefined();
    expect(screen.getByText('User')).toBeDefined();
    expect(screen.getByText('Project')).toBeDefined();
  });

  it('calls onScopeChange when a button is clicked', () => {
    const onScopeChange = vi.fn();
    render(
      <ScopeFilterBar
        scope={{ user: false, projects: ['project-1'] }}
        currentProjectId={null}
        onScopeChange={onScopeChange}
      />,
    );
    fireEvent.click(screen.getByText('User'));
    expect(onScopeChange).toHaveBeenCalledWith({ user: true, projects: ['project-1'] });
  });

  it('defaults the project scope to the current project', () => {
    const onScopeChange = vi.fn();

    render(
      <ScopeFilterBar
        scope={EMPTY_SCOPE}
        currentProjectId="project-1"
        onScopeChange={onScopeChange}
      />,
    );

    const projectButton = screen.getByText('Project').closest('button');
    expect(projectButton?.disabled).toBe(false);

    fireEvent.click(screen.getByText('Project'));

    expect(onScopeChange).toHaveBeenCalledWith({ user: false, projects: ['project-1'] });
  });
});
