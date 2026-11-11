/**
 * Hovering the glowing Restart button lists only what changed since the session
 * started (the short summary, not raw JSON), and "See all settings" opens the
 * full Command Status view.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgenticProcess } from '@sdk';
import { RestartChangesList } from '@src/components/terminal/interactive-terminal/RestartChangesList';

afterEach(cleanup);

function open(changes: AgenticProcess['restart_changes'], onShowAll = vi.fn()) {
  render(<RestartChangesList process={{ restart_changes: changes } as AgenticProcess} onShowAll={onShowAll} />);
  return onShowAll;
}

describe('RestartChangesList', () => {
  it('shows one row per change with its summary', () => {
    open([
      { field: 'add_dirs', loaded: '["/a/x"]', current: '["/a/x", "/b/y"]', summary: 'added y' },
      { field: 'model', loaded: 'sonnet', current: 'opus', summary: 'sonnet → opus' },
    ]);
    const rows = screen.getAllByTestId('restart-change-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('add dirs');
    expect(rows[0]).toHaveTextContent('added y');
    expect(rows[0]).not.toHaveTextContent('/b/y');
  });

  it('falls back when there are no change details, and links to all settings', () => {
    const onShowAll = open([]);
    expect(screen.queryAllByTestId('restart-change-row')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('restart-changes-show-all'));
    expect(onShowAll).toHaveBeenCalledOnce();
  });
});
