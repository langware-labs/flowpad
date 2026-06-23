import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ScopeFilterBar } from '@src/components/scope-filter/ScopeFilterBar';
import { userScope, projectScope } from '@src/lib/scope-filter';

describe('ScopeFilterBar', () => {
  it('renders three scope buttons', () => {
    render(
      <ScopeFilterBar
        scope={userScope()}
        currentProjectId={null}
        onScopeChange={() => {}}
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
        scope={projectScope('project-1')}
        currentProjectId={null}
        onScopeChange={onScopeChange}
      />,
    );
    fireEvent.click(screen.getByText('User'));
    // "User" = user-assets-only scope ({mode:'user'}).
    expect(onScopeChange).toHaveBeenCalledWith(userScope());
  });

  it('defaults the project scope to the current project', () => {
    const onScopeChange = vi.fn();

    render(
      <ScopeFilterBar
        scope={userScope()}
        currentProjectId="project-1"
        onScopeChange={onScopeChange}
      />,
    );

    const projectButton = screen.getByText('Project').closest('button');
    expect(projectButton?.disabled).toBe(false);

    fireEvent.click(screen.getByText('Project'));

    expect(onScopeChange).toHaveBeenCalledWith(projectScope('project-1'));
  });
});
