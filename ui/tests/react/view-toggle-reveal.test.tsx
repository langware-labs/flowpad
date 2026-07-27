import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';

import { resetRevealedModes, ViewToggle } from '@src/components/view-toggle/view-toggle';
import { setViewMode, useViewMode, ViewMode } from '@src/contexts/view-mode-context';

function Harness() {
  const mode = useViewMode();
  return (
    <div>
      <div data-testid="effective-mode">{mode}</div>
      <ViewToggle />
    </div>
  );
}

function renderToggle() {
  const router = createMemoryRouter([{ path: '/', element: <Harness /> }], {
    initialEntries: ['/'],
  });
  render(<RouterProvider router={router} />);
}

const buttons = () =>
  screen
    .getAllByRole('radio')
    .map((b) => b.getAttribute('data-testid')?.replace('view-toggle-', ''));

describe('ViewToggle progressive reveal', () => {
  beforeEach(() => {
    localStorage.clear();
    setViewMode(ViewMode.Standard);
    resetRevealedModes();
  });

  afterEach(() => {
    cleanup();
    setViewMode(ViewMode.Standard);
    resetRevealedModes();
  });

  it('normally offers only Standard and Vibe', () => {
    renderToggle();
    expect(buttons()).toEqual(['standard', 'vibe']);
  });

  it('double-click on the selected Standard reveals Advanced without selecting it', () => {
    renderToggle();
    fireEvent.doubleClick(screen.getByTestId('view-toggle-standard'));

    expect(buttons()).toEqual(['advanced', 'standard', 'vibe']);
    expect(screen.getByTestId('effective-mode').textContent).toBe('standard');
    expect(screen.getByTestId('view-toggle-advanced').getAttribute('aria-checked')).toBe('false');
  });

  it('double-click on a NON-selected button reveals nothing', () => {
    renderToggle();
    fireEvent.doubleClick(screen.getByTestId('view-toggle-vibe'));
    expect(buttons()).toEqual(['standard', 'vibe']);
  });

  it('double-click on the selected Advanced reveals Dev without selecting it', () => {
    setViewMode(ViewMode.Advanced);
    renderToggle();
    fireEvent.doubleClick(screen.getByTestId('view-toggle-advanced'));

    expect(buttons()).toEqual(['dev', 'advanced', 'standard', 'vibe']);
    expect(screen.getByTestId('effective-mode').textContent).toBe('advanced');
    expect(screen.getByTestId('view-toggle-dev').getAttribute('aria-checked')).toBe('false');
  });

  it('renders every mode at or below the current one (landing in Dev shows all four)', () => {
    setViewMode(ViewMode.Dev);
    renderToggle();
    expect(buttons()).toEqual(['dev', 'advanced', 'standard', 'vibe']);
  });

  it('a revealed mode stays for the session across remounts', () => {
    renderToggle();
    fireEvent.doubleClick(screen.getByTestId('view-toggle-standard'));
    cleanup();
    renderToggle();
    expect(buttons()).toEqual(['advanced', 'standard', 'vibe']);
  });
});
