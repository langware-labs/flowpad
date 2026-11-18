/**
 * The bar under a closed ticket's composer: who closed it and when, and the two ways on.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TicketClosedBar } from '@src/components/conversation/TicketClosedBar';

afterEach(cleanup);

const AT = '2026-11-17T10:19:00';

describe('TicketClosedBar', () => {
  it('names the desk that closed it, and offers Reopen and Ask something new', () => {
    const onReopen = vi.fn();
    const onAskNew = vi.fn();
    render(<TicketClosedBar closedBy="Acme Support" at={AT} busy={false} onReopen={onReopen} onAskNew={onAskNew} />);

    expect(screen.getByTestId('ticket-closed-bar').textContent).toContain('✓ Acme Support closed this ticket ·');
    fireEvent.click(screen.getByTestId('ticket-closed-reopen'));
    fireEvent.click(screen.getByTestId('ticket-closed-ask-new'));
    expect(onReopen).toHaveBeenCalledTimes(1);
    expect(onAskNew).toHaveBeenCalledTimes(1);
  });

  it('says "You" when the person closed it themselves, and holds Reopen while saving', () => {
    render(<TicketClosedBar closedBy={null} at={AT} busy onReopen={vi.fn()} onAskNew={vi.fn()} />);

    expect(screen.getByTestId('ticket-closed-bar').textContent).toContain('✓ You closed this ticket');
    expect(screen.getByTestId('ticket-closed-reopen').disabled).toBe(true);
  });
});
