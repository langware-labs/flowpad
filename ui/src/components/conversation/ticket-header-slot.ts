import { createContext } from 'react';

/** Where a conversation's header draws what comes BEFORE its title. A help-desk ticket's staff page puts the
 *  ticket's status there (the route owns the header, the ticket page owns the status). Null: no such header. */
export const TicketHeaderSlot = createContext<HTMLElement | null>(null);
