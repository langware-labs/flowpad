import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ScopeFilterBar } from '@src/components/assets/ScopeFilterBar';

describe('ScopeFilterBar', () => {
  it('renders three scope buttons', () => {
    render(<ScopeFilterBar scope="all" projectIds={[]} onScopeChange={() => {}} onProjectIdsChange={() => {}} />);
    expect(screen.getByText('All')).toBeDefined();
    expect(screen.getByText('User')).toBeDefined();
    expect(screen.getByText('Project')).toBeDefined();
  });

  it('calls onScopeChange when a button is clicked', () => {
    const onScopeChange = vi.fn();
    render(<ScopeFilterBar scope="all" projectIds={[]} onScopeChange={onScopeChange} onProjectIdsChange={() => {}} />);
    fireEvent.click(screen.getByText('User'));
    expect(onScopeChange).toHaveBeenCalledWith('user');
  });
});
