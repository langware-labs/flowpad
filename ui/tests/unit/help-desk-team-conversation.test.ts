import { describe, expect, it } from 'vitest';
import { isStaffTicket, ticketOfTeamConversation } from '@sdk';

const TICKET = '28227ed9-7d6e-4226-9f35-2d7e207ad9d0';

describe('a help-desk ticket and its team conversation', () => {
  it('names the ticket of a team conversation the hub linked to it', () => {
    const team = { title: `[ticket ${TICKET}] invoices`, sharedContextEntities: [`conversation-${TICKET}`] };
    expect(ticketOfTeamConversation(team)).toBe(TICKET);
  });

  it('a conversation merely titled like one is not a team conversation', () => {
    expect(ticketOfTeamConversation({ title: `[ticket ${TICKET}] forged`, sharedContextEntities: [] })).toBeNull();
    expect(ticketOfTeamConversation({ title: 'Lunch?' })).toBeNull();
  });

  it('a ticket is a staff ticket for everyone but the person who asked', () => {
    const ticket = { kind: 'helpdesk', remote: true, initiated_by: 'dana' };
    expect(isStaffTicket(ticket, 'noa')).toBe(true);
    expect(isStaffTicket(ticket, 'dana')).toBe(false);
    expect(isStaffTicket({ ...ticket, remote: false }, 'noa')).toBe(false); // written here, not yet on the hub: mine
    expect(isStaffTicket({ ...ticket, kind: 'direct' }, 'noa')).toBe(false);
  });
});
