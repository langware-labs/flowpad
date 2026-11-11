/**
 * The assets "+" on a type (NewOfTypeDialog): a type whose quick-create descriptor brings its own
 * Dialog (a chart asks for its format) opens that dialog; any other type keeps the name-only form.
 */
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@src/components/quick-create/registry', () => ({
  getDescriptor: (type: string) =>
    type === 'chart'
      ? { Dialog: ({ open, projectId }: { open: boolean; projectId?: string | null }) => (open ? <div data-testid="custom-dialog">{projectId}</div> : null) }
      : { create: vi.fn() },
}));
vi.mock('@src/components/ui/input-dialog', () => ({
  InputDialog: ({ open }: { open: boolean }) => (open ? <div data-testid="name-dialog" /> : null),
}));

import { NewOfTypeDialog } from '@src/components/quick-create/NewOfTypeDialog';

const props = { open: true, onOpenChange: vi.fn(), projectId: 'p1', onConfirmName: vi.fn() };

describe('assets "+" dialog', () => {
  it('opens the type’s own dialog (a chart asks its format), in the given project', () => {
    render(<NewOfTypeDialog type="chart" {...props} />);
    expect(screen.getByTestId('custom-dialog').textContent).toBe('p1');
    expect(screen.queryByTestId('name-dialog')).toBeNull();
  });

  it('keeps the name-only form for a type without one', () => {
    render(<NewOfTypeDialog type="markdown" {...props} />);
    expect(screen.getByTestId('name-dialog')).toBeTruthy();
    expect(screen.queryByTestId('custom-dialog')).toBeNull();
  });
});
