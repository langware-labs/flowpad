import { useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';
import { cn } from '@src/lib/utils';
import { itMachineName } from './it-reply';
import type { ItSend, ItSendRow } from './it-sends';
import { ItReplyButtons, ItStatePill, ItValueChips } from './ItReplyLine';

/**
 * Under an IT request: one row per machine that answered this send -- Machine · Status · Response -- with the row's
 * action at its end. A done row opens its full response and value fields under it. The answers are messages of the
 * conversation; this is how the request draws the ones that name its send (`indexItSends`).
 */
export function ItSendTable({ send, conversationId }: { send: ItSend; conversationId: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const agentId = send.request.agent_id ?? '';
  return (
    <div className="mt-2 max-w-4xl rounded-md border border-border" data-testid="it-send-table">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-8 w-24 text-[11px] uppercase tracking-widest">
              <Trans>Machine</Trans>
            </TableHead>
            <TableHead className="h-8 w-52 text-[11px] uppercase tracking-widest">
              <Trans>Status</Trans>
            </TableHead>
            <TableHead className="h-8 text-[11px] uppercase tracking-widest">
              <Trans>Response</Trans>
            </TableHead>
            <TableHead className="h-8 w-px" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {send.rows.map((row) => (
            <ItSendTableRow
              key={row.messageId}
              row={row}
              agentId={agentId}
              conversationId={conversationId}
              open={open === row.messageId}
              onToggle={() => setOpen((cur) => (cur === row.messageId ? null : row.messageId))}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ItSendTableRow({
  row,
  agentId,
  conversationId,
  open,
  onToggle,
}: {
  row: ItSendRow;
  agentId: string;
  conversationId: string;
  open: boolean;
  onToggle: () => void;
}) {
  // A machine that ran it has a response to open; a refused or silent one says why in its status alone.
  const answered = row.reply.state === 'done' || row.reply.state === 'failed';
  return (
    <>
      <TableRow
        className={cn('text-xs', answered && 'cursor-pointer', open && 'border-b-0')}
        onClick={answered ? onToggle : undefined}
        aria-expanded={answered ? open : undefined}
        data-testid="it-send-row"
        data-it-state={row.reply.state}
      >
        <TableCell className="px-3 py-1.5 font-mono">{itMachineName(row.reply)}</TableCell>
        <TableCell className="px-3 py-1.5">
          <ItStatePill reply={row.reply} />
        </TableCell>
        <TableCell className="max-w-0 truncate px-3 py-1.5 text-muted-foreground">{answered ? row.text : ''}</TableCell>
        <TableCell className="px-3 py-1.5 text-end" onClick={(e) => e.stopPropagation()}>
          <ItReplyButtons reply={row.reply} agentId={agentId} conversationId={conversationId} />
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="hover:bg-transparent" data-testid="it-send-row-open">
          <TableCell colSpan={4} className="bg-muted/30 px-3 pb-2 pt-1">
            <p className="whitespace-pre-wrap text-sm">{row.text}</p>
            <ItValueChips value={row.reply.value} className="mt-1" />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
