/**
 * The ribbon's Shown chip — where a run's `flow show` history lives, beside the
 * Open-Plan chip (it replaced a glyph on the process's tab chip).
 *
 * `display_stack` is stored oldest-first; the chip opens the NEWEST, and the
 * chevron lists every entry newest-first.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DisplayEntry } from '@sdk';
import { TerminalBottomRibbon } from '@src/components/terminal/interactive-terminal/TerminalBottomRibbon';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/components/view-mode', () => ({ useIsAdvanced: () => false }));
vi.mock('@src/components/prompt-library/PromptLibraryMenu', () => ({ PromptLibraryMenu: () => null }));

const baseProps = {
  fileCount: 0,
  isActive: true,
  openTabs: [],
  activeSideTab: null,
  onOpenSideTab: vi.fn(),
  process: null,
};

afterEach(() => cleanup());

const file = (name: string, shownAt: string) =>
  ({ kind: 'file', path: `/repo/${name}`, shown_at: shownAt }) as DisplayEntry;

describe('TerminalBottomRibbon — Shown chip', () => {
  it('renders nothing when the run has shown nothing', () => {
    render(<TerminalBottomRibbon {...baseProps} shown={[]} onOpenShown={vi.fn()} />);

    expect(screen.queryByTestId('ribbon-shown')).toBeNull();
  });

  it('one stack button lists every show newest-first; a row opens it', async () => {
    const onOpenShown = vi.fn();
    const older = file('older.md', '2026-09-28T09:00:00Z');
    const newest = file('newest.md', '2026-09-28T12:00:00Z');
    render(<TerminalBottomRibbon {...baseProps} shown={[older, newest]} onOpenShown={onOpenShown} />);

    expect(screen.getByTestId('ribbon-shown').textContent).toContain('2');
    expect(screen.queryAllByTestId('display-history-row')).toHaveLength(0);

    await userEvent.click(screen.getByTestId('ribbon-shown'));
    const rows = screen.getAllByTestId('display-history-row');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('newest.md'),
      expect.stringContaining('older.md'),
    ]);
    await userEvent.click(rows[1]);
    expect(onOpenShown).toHaveBeenCalledWith(older);
  });
});
