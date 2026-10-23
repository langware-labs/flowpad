import { describe, expect, it } from 'vitest';

import { replyPickedUp, ticketAffordances } from '../../src/components/conversation/ticket-affordances';

const base = { helpdesk: true, cloudUserId: 'u1', isOwner: false, isParticipant: false };

describe('ticketAffordances', () => {
  it('staff not in a ticket may pick it up and settle it', () => {
    expect(ticketAffordances(base)).toEqual({ canPickup: true, canSettle: true });
  });

  it('anyone in the ticket settles it but has nothing to pick up', () => {
    expect(ticketAffordances({ ...base, isParticipant: true })).toEqual({ canPickup: false, canSettle: true });
    expect(ticketAffordances({ ...base, isOwner: true })).toEqual({ canPickup: false, canSettle: true });
  });

  it('a conversation that is not a ticket has neither button', () => {
    expect(ticketAffordances({ ...base, helpdesk: false })).toEqual({ canPickup: false, canSettle: false });
  });

  it('logged out of the hub there is no one to pick it up as', () => {
    expect(ticketAffordances({ ...base, cloudUserId: null })).toEqual({ canPickup: false, canSettle: false });
  });
});

describe('replyPickedUp', () => {
  it('is true only for staff not yet in the ticket whose own message is the newest', () => {
    expect(replyPickedUp(true, 'u1', 'u1')).toBe(true);
    expect(replyPickedUp(true, 'u2', 'u1')).toBe(false);
    expect(replyPickedUp(false, 'u1', 'u1')).toBe(false);
    expect(replyPickedUp(true, null, null)).toBe(false);
  });
});
