/**
 * The requester's "Your questions" rows wear a ticket state chip next to "New reply".
 *
 * `HelpdeskMyItems` itself reads live conversations through data hooks that need a backend, so
 * this renders the exact chip it renders (`TicketStateChip`) over facets derived from real
 * requester-side conversation shapes — no mocks.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Conversation, ConversationKind } from '@sdk';
import { ConversationStatus } from '@sdk/entities/conversation';
import { TicketStateChip } from '@src/components/conversation/CategoryChips';
import { conversationFacets } from '@src/components/conversation/conversation-category';

afterEach(cleanup);

const REQUESTER = 'u-req';

function requesterFacets(status: ConversationStatus, staff: boolean) {
  const conv = {
    kind: ConversationKind.HELPDESK,
    status,
    initiated_by: REQUESTER,
    members: [{ user_id: REQUESTER, role: 'owner' }, ...(staff ? [{ user_id: 'u-staff', name: 'Dana' }] : [])],
  } as unknown as Conversation;
  return conversationFacets({ conv, viewer: { email: '', cloudUserId: REQUESTER, localUserId: null } });
}

describe('HelpdeskMyItems state chip', () => {
  it.each([
    [ConversationStatus.OPEN, false, 'Waiting for pickup', 'ticket-waiting'],
    [ConversationStatus.OPEN, true, 'Picked up', 'ticket-picked'],
    [ConversationStatus.CLOSED, true, 'Closed', 'ticket-closed'],
  ])('%s staff=%s → %s', (status, staff, label, key) => {
    render(<TicketStateChip ticket={requesterFacets(status, staff).ticket} />);
    const chip = screen.getByTestId('ticket-state-chip');
    expect(chip.textContent).toBe(label);
    expect(chip.getAttribute('data-chip-type')).toBe(key);
  });

  it('renders nothing for a non-ticket', () => {
    const { container } = render(<TicketStateChip ticket={undefined} />);
    expect(container.textContent).toBe('');
  });
});
