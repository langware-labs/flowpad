/**
 * The assets sidebar header "+" (NewAssetMenu) lists creatable types even when the scope has
 * none of them yet — the per-row "+" only exists on types with rows.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@src/components/quick-create/registry', () => ({
  getDescriptor: (type: string) => ({ group: type === 'diagnosis_request' ? 'connect' : 'build' }),
}));

vi.mock('@src/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    DropdownMenu: Pass, DropdownMenuTrigger: Pass, DropdownMenuContent: Pass,
    DropdownMenuLabel: Pass, DropdownMenuSeparator: () => null,
    DropdownMenuItem: ({ children, onSelect }: { children?: React.ReactNode; onSelect: () => void }) => (
      <button type="button" onClick={onSelect}>{children}</button>
    ),
  };
});

import { NewAssetMenu } from '@src/components/assets/NewAssetMenu';

const type = (type_name: string, label: string, creatable = true) => ({ type_name, label, creatable }) as never;

describe('assets header "+" menu', () => {
  it('offers an empty creatable type and creates it on select; skips non-creatable', () => {
    const onNew = vi.fn();
    render(<NewAssetMenu types={[type('diagnosis_request', 'Diagnosis request'), type('tag', 'Tag', false)]} onNew={onNew} />);
    expect(screen.queryByText('Tag')).toBeNull();
    fireEvent.click(screen.getByText('Diagnosis request'));
    expect(onNew).toHaveBeenCalledWith('diagnosis_request');
  });
});
