import { t } from '@lingui/core/macro';
import { ChevronDown } from 'lucide-react';

import { cn } from '@src/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { ticketChip, type TicketFacet, type TicketState } from './conversation-category';
import { ticketActionClassName } from './ticket-affordances';

/**
 * A help desk ticket's status, as the button desk staff change it from: it wears the same label and
 * colour as the ticket's chip in the StreamInbox list, and opens the three states a ticket can be moved to.
 */
export function TicketStatusControl({
  ticket,
  mine,
  busy,
  onChoose,
}: {
  ticket: TicketFacet;
  /** The viewer is one of the staff in the ticket. */
  mine: boolean;
  busy?: boolean;
  onChoose: (target: TicketState) => void;
}) {
  const chip = ticketChip(ticket);
  if (!chip) return null;
  // Someone else's ticket is theirs to hand back: the viewer can take it or close it, not release it.
  const othersTicket = ticket.state === 'picked' && !mine;
  const options: { value: TicketState; label: string; hint: string; disabled?: boolean }[] = [
    { value: 'waiting', label: t`Not picked up`, hint: t`Back to the desk queue`, disabled: othersTicket },
    { value: 'picked', label: t`Picked up by you`, hint: t`You are answering it` },
    { value: 'closed', label: t`Closed`, hint: t`Answered, off the queue` },
  ];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={busy}>
        <button
          type="button"
          title={t`Ticket status — click to change`}
          data-testid="ticket-status-button"
          data-state-value={ticket.state}
          className={cn(ticketActionClassName, chip.className)}
        >
          <chip.icon className="h-4 w-4" />
          {busy ? t`Saving…` : chip.label}
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64" data-testid="ticket-status-menu">
        <DropdownMenuLabel className="text-xs text-muted-foreground">{t`Ticket status`}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={othersTicket ? '' : ticket.state}
          onValueChange={(v) => onChoose(v as TicketState)}
        >
          {options.map((o) => (
            <DropdownMenuRadioItem
              key={o.value}
              value={o.value}
              disabled={o.disabled}
              data-testid={`ticket-status-${o.value}`}
            >
              <span className="flex flex-col items-start leading-tight">
                <span>{o.label}</span>
                <span className="text-[11px] text-muted-foreground">{o.hint}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
