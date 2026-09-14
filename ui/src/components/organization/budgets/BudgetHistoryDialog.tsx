/**
 * A budget's history: who was given how much, who changed it, and when.
 *
 * The screen for `LLMAllowanceEvent` — rows the hub has been writing all along with nothing able
 * to show them. Three kinds of fact appear here and each answers a question `limits` cannot:
 *
 * * **given** — an allowance was created. The pool's own creation is one of these, and so is the
 *   default the hub mints for a person on their first sign-in, which is why a wallet nobody
 *   remembers handing out still has a row saying where it came from.
 * * **changed** — a cap moved, with what it moved from. A raise is otherwise invisible: `limits`
 *   simply reads a different number afterwards.
 * * **removed** — an allowance was deleted, carrying what it had already spent. Deleting an
 *   exhausted allowance and re-creating it restarts a lifetime cap at zero while every field on
 *   the new row reads exactly like the old one; this is the only place that shows.
 *
 * **Opened on a pool, scoped to its subtree.** The hub answers for the endpoint AND everything
 * drawing on it, so an organization's pot tells the whole school's story — its teams' pools and
 * its people's allowances — in one list. That is the question an administrator actually asks, and
 * reading it one endpoint at a time is what made the trail unusable even after it existed.
 *
 * Read-only, and admin-gated by the hub (`llm_endpoint.admin.allow: history`). There is nothing to
 * press here: an audit that could be edited from its own screen would not be an audit.
 */
import { llmEndpointsService, type LLMAllowanceHistoryRow } from '@sdk';
import { useQuery } from '@tanstack/react-query';
import { History, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { endpointIdFromTypeId } from '@src/components/llm-endpoints/llm-endpoints-pointer';
import { formatUsd } from '@src/components/llm-endpoints/usage-math';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@src/components/ui/table';
import { errorMessage } from '@src/lib/error-message';

/** The one place the trail's vocabulary is turned into the page's. */
function eventLabel(event: string): string {
  if (event === 'allocated') return 'given';
  if (event === 'limits_changed') return 'changed';
  if (event === 'deleted') return 'removed';
  return event;
}

/**
 * A cap as a person reads it. `null`/absent is UNCAPPED, which is not zero — printing "$0" for it
 * would report the most permissive budget in the system as the tightest one.
 */
function cap(limits: Record<string, number | null> | null | undefined): string {
  const value = limits?.cost_usd_total;
  if (value === null || value === undefined) return '—';
  return formatUsd(value);
}

/** What this event did to the money: a starting figure, or a move from one to another. */
function change(row: LLMAllowanceHistoryRow): string {
  if (row.event === 'limits_changed') return `${cap(row.limits_before)} → ${cap(row.limits_after)}`;
  if (row.event === 'deleted') return cap(row.limits_before);
  return cap(row.limits_after);
}

function when(ts: number): string {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleString();
}

export function BudgetHistoryDialog({
  open,
  onOpenChange,
  endpointId,
  scopeLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A typeid or a bare uuid — normalized before the hub call, like every other endpoint action. */
  endpointId: string;
  scopeLabel: string;
}) {
  const { t } = useLingui();
  const id = endpointIdFromTypeId(endpointId);
  // Fetched when the dialog is opened, not with the page: a history is looked at deliberately, and
  // it is a per-endpoint walk on the hub's side.
  const history = useQuery<LLMAllowanceHistoryRow[]>({
    queryKey: ['budget-history', id],
    queryFn: () => llmEndpointsService.getHistory(id),
    enabled: open,
    staleTime: 15_000,
    // A non-admin gets a flat refusal; retrying repeats the 401.
    retry: false,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            <Trans>History of {scopeLabel}’s budget</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Every allowance given, changed or removed here and in everything funded by it. Read-only.</Trans>
          </DialogDescription>
        </DialogHeader>

        {history.isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <Trans>Reading the history…</Trans>
          </div>
        ) : history.error ? (
          <p className="py-6 text-sm text-destructive" data-testid="budget-history-error">
            {errorMessage(history.error, t`Could not read this budget's history.`)}
          </p>
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <Table data-testid="budget-history-table">
              <TableHeader>
                <TableRow>
                  <TableHead>
                    <Trans>When</Trans>
                  </TableHead>
                  <TableHead>
                    <Trans>What</Trans>
                  </TableHead>
                  <TableHead>
                    <Trans>Budget</Trans>
                  </TableHead>
                  <TableHead>
                    <Trans>Held by</Trans>
                  </TableHead>
                  <TableHead>
                    <Trans>By</Trans>
                  </TableHead>
                  <TableHead className="text-end">
                    <Trans>Amount</Trans>
                  </TableHead>
                  <TableHead className="text-end">
                    <Trans>Spent then</Trans>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(history.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-6 text-center text-sm text-muted-foreground">
                      <Trans>Nothing has been given out or changed here yet.</Trans>
                    </TableCell>
                  </TableRow>
                )}
                {(history.data ?? []).map((row) => (
                  <TableRow key={row.id} data-testid={`budget-history-row-${row.id}`}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">{when(row.ts)}</TableCell>
                    <TableCell>{eventLabel(row.event)}</TableCell>
                    <TableCell>{row.endpoint_name}</TableCell>
                    {/* The id is deliberately not shown: it is what the row is keyed by, not something
                        anybody reads. An unresolvable person leaves the cell empty rather than
                        printing a uuid at a reader. */}
                    <TableCell className="text-muted-foreground">{row.beneficiary_name ?? ''}</TableCell>
                    <TableCell className="text-muted-foreground">{row.actor_name ?? ''}</TableCell>
                    <TableCell className="whitespace-nowrap text-end">{change(row)}</TableCell>
                    <TableCell className="text-end text-muted-foreground">{formatUsd(row.spent_usd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The header button. Rendered only beside a pool the caller may configure — the hub gates the read
 *  at `admin`, so offering it to a reader would only ever produce a refusal. */
export function BudgetHistoryButton({
  endpointId,
  scopeLabel,
  testId,
}: {
  endpointId: string;
  scopeLabel: string;
  testId: string;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="gap-1 text-muted-foreground"
        data-testid={testId}
        aria-label={t`History`}
        title={t`Who was given how much, and by whom`}
        onClick={() => setOpen(true)}
      >
        <History className="h-4 w-4" />
        <Trans>History</Trans>
      </Button>
      {open && (
        <BudgetHistoryDialog open={open} onOpenChange={setOpen} endpointId={endpointId} scopeLabel={scopeLabel} />
      )}
    </>
  );
}
