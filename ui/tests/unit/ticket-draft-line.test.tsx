/**
 * An agent's draft in a ticket's team conversation: Send / Edit / Discard while pending, who decided once the hub
 * has. Send carries the edited text only when the person edited it.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => [] as unknown[][]);
vi.mock('@sdk/entities/conversation', () => ({
  sendTicketDraft: (...args: unknown[]) => {
    sent.push(args);
    return Promise.resolve();
  },
  discardTicketDraft: () => Promise.resolve(),
}));

import { TicketDraftStatus } from '@sdk/entities/flow-message';
import { TicketDraftLine } from '@src/components/conversation/TicketDraftLine';

afterEach(() => {
  cleanup();
  sent.length = 0;
});

describe('TicketDraftLine', () => {
  it('sends the draft as written', async () => {
    render(
      <TicketDraftLine
        draft={{ ticket_id: 't-1', status: TicketDraftStatus.PENDING }}
        messageId="m-1"
        text="Try again."
      />,
    );
    fireEvent.click(screen.getByTestId('ticket-draft-send'));
    await waitFor(() => expect(sent).toEqual([['t-1', 'm-1', undefined]]));
  });

  it('sends the edited text', async () => {
    render(
      <TicketDraftLine
        draft={{ ticket_id: 't-1', status: TicketDraftStatus.PENDING }}
        messageId="m-1"
        text="Try again."
      />,
    );
    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(screen.getByTestId('ticket-draft-editor'), { target: { value: 'Sign out and in.' } });
    fireEvent.click(screen.getByTestId('ticket-draft-send'));
    await waitFor(() => expect(sent).toEqual([['t-1', 'm-1', 'Sign out and in.']]));
  });

  it('a decided draft says who decided, with no buttons', () => {
    render(
      <TicketDraftLine
        draft={{ ticket_id: 't-1', status: TicketDraftStatus.DISCARDED, by: 'Noa' }}
        messageId="m-1"
        text="x"
      />,
    );
    expect(screen.getByTestId('ticket-draft-settled').textContent).toBe('Discarded by Noa');
    expect(screen.queryByTestId('ticket-draft-send')).toBeNull();
  });
});
