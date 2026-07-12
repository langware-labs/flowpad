/**
 * DisplayHistoryButton — the display-history popover. Lists a process's
 * `flow show` stack NEWEST-FIRST with an "ago" label; clicking a row opens that
 * target as its own tab (`onOpen`). The stack is stored oldest-first.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DisplayEntry } from '@sdk';
import { DisplayHistoryButton } from '@src/pages/flow-page/display-history-button';

const OLD: DisplayEntry = { kind: 'vfs', path: '/proj/old.md', shown_at: '2020-01-01T00:00:00Z' };
const NEW: DisplayEntry = { kind: 'entity', type: 'markdown', typeid: 'markdown-x', shown_at: '2020-01-02T00:00:00Z' };

describe('DisplayHistoryButton', () => {
  afterEach(cleanup);

  it('renders nothing when the stack is empty', () => {
    const { container } = render(<DisplayHistoryButton stack={[]} onOpen={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('lists entries NEWEST-first and opens the clicked target', async () => {
    const onOpen = vi.fn();
    render(<DisplayHistoryButton stack={[OLD, NEW]} onOpen={onOpen} />);

    await userEvent.click(screen.getByTestId('display-history'));
    const rows = within(screen.getByTestId('display-history-popover')).getAllByTestId('display-history-row');
    expect(rows).toHaveLength(2);
    // Stored oldest-first ([OLD, NEW]) → shown newest-first: NEW row is first.
    expect(rows[0].textContent).toContain('markdown');
    expect(rows[1].textContent).toContain('old.md');

    await userEvent.click(rows[0]);
    expect(onOpen).toHaveBeenCalledWith(NEW);
  });
});
