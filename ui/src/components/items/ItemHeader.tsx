import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import { ItemActions, ItemChip, RoleChip, StatePill, hasActions, useItemTime, type ItemCardValue } from './ItemCard';

/**
 * The top of every item's own page — agent, deployment, machine, issue, channel, project — on hub
 * and desktop. It reads the SAME value as the item's card, so what the card said is what the page
 * says. A reader gets the read-only strip; their edit controls are the page's to hide (`canDo`).
 */
export function ItemHeader({
  item,
  kind,
  children,
}: {
  item: ItemCardValue;
  /** The kind word shown as a chip ("Agent", "Machine"). */
  kind: ReactNode;
  /** Extra header content below the description (a services row, a funding line). */
  children?: ReactNode;
}) {
  const time = useItemTime(item.at);
  const Icon = item.icon;
  return (
    <div className="flex flex-col gap-3" data-testid="item-header">
      <div className="flex items-start gap-4">
        {Icon && (
          <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-muted">
            <Icon className="size-6 text-muted-foreground" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-xl font-semibold text-foreground" data-testid="item-header-title">
              {item.title}
              {item.sub && <span className="font-normal text-muted-foreground"> {item.sub}</span>}
            </h1>
            {item.state && <StatePill state={item.state} />}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <ItemChip>{kind}</ItemChip>
            <RoleChip role={item.role} />
            {time && <span>· {time}</span>}
            {item.chips?.map((c, i) => <ItemChip key={i}>{c}</ItemChip>)}
          </div>
          {item.warning && <p className="mt-2 text-xs text-amber-500">⚠ {item.warning}</p>}
          {item.description && <p className="mt-2 text-sm text-muted-foreground">{item.description}</p>}
        </div>
        {hasActions(item.actions) && (
          <div className="flex shrink-0 gap-2">
            <ItemActions actions={item.actions} size="md" testIdPrefix="item-header-action" />
          </div>
        )}
      </div>
      {children}
      {item.footer}
      {item.role === 'reader' && (
        <div
          className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-2 text-sm text-sky-300"
          data-testid="item-readonly-strip"
        >
          <Trans>Shared with you as a reader — you can open it, not change it.</Trans>
        </div>
      )}
    </div>
  );
}
