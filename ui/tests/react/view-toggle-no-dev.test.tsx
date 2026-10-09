/**
 * The footer toggle offers the three SURFACES and nothing else. Dev used to be
 * a fourth segment behind a double-click reveal; it is a switch now (double-click
 * your avatar in the profile menu), so the toggle never shows it.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';

import { ViewToggle } from '@src/components/view-toggle/view-toggle';
import { setViewMode, ViewMode } from '@src/contexts/view-mode-context';

function renderToggle() {
  const router = createMemoryRouter([{ path: '/', element: <ViewToggle /> }], { initialEntries: ['/'] });
  render(<RouterProvider router={router} />);
}

const buttons = () =>
  screen.getAllByRole('radio').map((b) => b.getAttribute('data-testid')?.replace('view-toggle-', ''));

describe('ViewToggle — three surfaces, no Dev', () => {
  beforeEach(() => {
    localStorage.clear();
    setViewMode(ViewMode.Standard);
  });
  afterEach(() => {
    cleanup();
    setViewMode(ViewMode.Standard);
  });

  it('offers exactly Terminal, Chat and Vibe', () => {
    renderToggle();
    expect(buttons()).toEqual(['advanced', 'standard', 'vibe']);
  });

  it('double-clicking the selected Terminal reveals nothing any more', () => {
    setViewMode(ViewMode.Advanced);
    renderToggle();
    fireEvent.doubleClick(screen.getByTestId('view-toggle-advanced'));
    expect(buttons()).toEqual(['advanced', 'standard', 'vibe']);
  });
});
