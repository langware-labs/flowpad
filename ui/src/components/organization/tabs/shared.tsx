/** Small pieces every People & teams tab uses. */
import type { TypeId } from '@sdk';
import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

import { RATIO_TONE } from '@src/components/llm-endpoints/tone';
import { formatUsd, ratioTone } from '@src/components/llm-endpoints/usage-math';
import { useCreateChildTeamForm } from '@src/components/organization/use-create-child-team';
import { Button } from '@src/components/ui/button';
import { Progress } from '@src/components/ui/progress';
import { cn } from '@src/lib/utils';

export function Loading({ label }: { label?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {label ?? <Trans>Loading…</Trans>}
    </div>
  );
}

/** A tab's title, its one-line purpose, and its single primary action on the right. */
export function TabTitle({ title, sub, action }: { title: ReactNode; sub?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold">{title}</h2>
        {sub && <p className="text-sm text-muted-foreground">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

/** "$spent / $limit" over a thin bar; the bar's colour follows the shared usage thresholds. */
export function SpendBar({
  spent,
  limit,
  className,
  testId,
}: {
  spent: number;
  limit: number | null;
  className?: string;
  testId?: string;
}) {
  const used = limit ? Math.min(1, spent / limit) : 0;
  return (
    <div className={cn('flex flex-col items-end gap-1', className)} data-testid={testId}>
      <span className="text-sm tabular-nums">
        {formatUsd(spent)}
        <span className="text-muted-foreground"> / {limit === null ? '∞' : formatUsd(limit)}</span>
      </span>
      {limit !== null && (
        <Progress value={used * 100} className={cn('h-1.5 w-28 bg-muted', RATIO_TONE[ratioTone(used)].bar)} />
      )}
    </div>
  );
}

/** Is THIS row's own cap save in flight? One mutation observer is shared by a whole table. */
export function savingCap(
  setCap: { isPending: boolean; variables?: { endpointId: string } },
  endpointId: string | null | undefined,
): boolean {
  return setCap.isPending && !!endpointId && setCap.variables?.endpointId === endpointId;
}

/**
 * The one "new team" control: a button that turns into a name field + Create / Cancel.
 * Used by the Teams tab and the graph drawers, so all three create a team the same way.
 */
export function CreateTeamInline({
  parentTypeId,
  parentLabel,
  isOrganization = true,
  onCreated,
  testIdPrefix,
  label,
}: {
  parentTypeId: TypeId;
  parentLabel: string;
  isOrganization?: boolean;
  onCreated: () => void;
  testIdPrefix: string;
  label?: ReactNode;
}) {
  const { t } = useLingui();
  const form = useCreateChildTeamForm({
    parentTypeId,
    parentLabel,
    isOrganization,
    organizationCreatedTitle: t`Team created`,
    onCreated,
  });
  if (!form.open) {
    return (
      <Button size="sm" data-testid={testIdPrefix} onClick={() => form.setOpen(true)}>
        {label ?? <Trans>+ New team</Trans>}
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <input
        autoFocus
        value={form.name}
        onChange={(e) => form.setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void form.submit();
          if (e.key === 'Escape') form.setOpen(false);
        }}
        placeholder={t`Team name…`}
        data-testid={`${testIdPrefix}-name`}
        className="w-48 rounded-md border border-border bg-background px-2.5 py-1 text-sm"
      />
      <Button
        size="sm"
        disabled={form.busy || !form.name.trim()}
        onClick={() => void form.submit()}
        data-testid={`${testIdPrefix}-submit`}
      >
        {form.busy && <Loader2 className="h-4 w-4 animate-spin" />}
        <Trans>Create</Trans>
      </Button>
      <Button size="sm" variant="outline" onClick={() => form.setOpen(false)} data-testid={`${testIdPrefix}-cancel`}>
        <Trans>Cancel</Trans>
      </Button>
    </div>
  );
}
