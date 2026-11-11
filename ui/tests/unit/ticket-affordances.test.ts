import { describe, expect, it } from 'vitest';

import {
  replyPickedUp,
  ticketAffordances,
  ticketStatusSteps,
} from '../../src/components/conversation/ticket-affordances';

const base = { helpdesk: true, cloudUserId: 'u1', isOwner: false, isParticipant: false };

describe('ticketAffordances', () => {
  it('staff not in a ticket may pick it up and settle it', () => {
    expect(ticketAffordances(base)).toEqual({ canPickup: true, canSettle: true });
  });

  it('staff in the ticket settle it; the person who asked has a conversation, nothing to settle', () => {
    expect(ticketAffordances({ ...base, isParticipant: true })).toEqual({ canPickup: false, canSettle: true });
    expect(ticketAffordances({ ...base, isOwner: true })).toEqual({ canPickup: false, canSettle: false });
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

describe('ticketStatusSteps', () => {
  const open = { closed: false, mine: true };
  it('closes an open ticket, and leaves a closed one alone', () => {
    expect(ticketStatusSteps('closed', open)).toEqual(['close']);
    expect(ticketStatusSteps('closed', { closed: true, mine: true })).toEqual([]);
  });

  it('hands my ticket back to the queue; one I am not in has nothing to hand back', () => {
    expect(ticketStatusSteps('waiting', open)).toEqual(['return']);
    expect(ticketStatusSteps('waiting', { closed: false, mine: false })).toEqual([]);
  });

  it('picks up a ticket I am not in, and does nothing when it is already mine', () => {
    expect(ticketStatusSteps('picked', { closed: false, mine: false })).toEqual(['pickup']);
    expect(ticketStatusSteps('picked', open)).toEqual([]);
  });

  it('reopens a closed ticket on its way to either open state', () => {
    expect(ticketStatusSteps('picked', { closed: true, mine: false })).toEqual(['reopen', 'pickup']);
    expect(ticketStatusSteps('waiting', { closed: true, mine: true })).toEqual(['reopen', 'return']);
  });
});
