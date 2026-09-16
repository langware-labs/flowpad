import { useLingui } from '@lingui/react/macro';
import { iconForType, labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { timeSince } from '@src/utils/duration';
import type { PublishedState } from '@sdk';
import type { ReactNode } from 'react';
import { ProvenanceLink } from './ProvenanceLink';
import { styleOf, type DiscoverItem } from './discover-model';

/** One grid for the header strip and every row, so the columns line up by construction. */
export const ROW_GRID =
  'grid grid-cols-[2.5rem_minmax(0,1fr)_minmax(0,13rem)_minmax(0,9rem)_6.5rem_auto] items-center gap-3 px-3 py-1.5';

export function StateChip({ state }: { state: PublishedState | null }) {
  // The macro only transforms `t` bound here, so the labels live in the component.
  const { t } = useLingui();
  const label =
    state === 'in_use'
      ? t`In use`
      : state === 'install'
        ? t`Installable`
        : state === 'stale'
          ? t`Changed since publish`
          : state === 'missing'
            ? t`Missing`
            : t`Not published`;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${styleOf(state).chip}`}
      data-state={state ?? 'unpublished'}
      data-testid="discover-state"
    >
      {label}
    </span>
  );
}

/**
 * A directory row: rank, type glyph and name, provenance, publisher, age, and
 * whatever actions the mode puts in the slot. Clicking the row opens the
 * asset; the actions slot stops propagation itself. Hover/focus reports the
 * row so the command block can show its install line.
 */
export function DiscoverRow({
  item,
  rank,
  selected = false,
  onOpen,
  onHover,
  actions,
}: {
  item: DiscoverItem;
  rank: number;
  selected?: boolean;
  onOpen: () => void;
  onHover?: (item: DiscoverItem | null) => void;
  actions?: ReactNode;
}) {
  const { t } = useLingui();
  const Icon = iconForType(item.type);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      onMouseEnter={() => onHover?.(item)}
      onMouseLeave={() => onHover?.(null)}
      onFocus={() => onHover?.(item)}
      onBlur={() => onHover?.(null)}
      className={`${ROW_GRID} cursor-pointer border-b border-border/60 border-s-[3px] ${styleOf(item.state).border} transition-colors hover:bg-muted/40 focus:outline-none focus-visible:bg-muted/40 ${
        selected ? 'bg-accent' : ''
      }`}
      data-testid="discover-row"
      data-typeid={item.typeid}
      data-state={item.state ?? 'unpublished'}
    >
      <span className="font-mono text-xs tabular-nums text-muted-foreground">{rank}</span>
      <span className="flex min-w-0 items-center gap-2.5">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-muted text-foreground/80">
          <Icon className="h-4 w-4" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{item.name}</span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {item.description || labelForType(item.type)}
          </span>
        </span>
      </span>
      <ProvenanceLink origin={item.origin} />
      <span className="truncate text-xs text-muted-foreground" title={item.sourceProjectName ?? undefined}>
        {item.sourceProjectName ?? '—'}
      </span>
      <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
        {item.publishedAt ? timeSince(item.publishedAt, t`never`) : <StateChip state={null} />}
      </span>
      <span className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        {actions}
      </span>
    </div>
  );
}

export function DiscoverHeaderStrip({ actionsLabel }: { actionsLabel?: string }) {
  const { t } = useLingui();
  return (
    <div className={`${ROW_GRID} border-b border-border bg-muted/30 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground`}>
      <span>#</span>
      <span>{t`Asset`}</span>
      <span>{t`Source`}</span>
      <span>{t`Project`}</span>
      <span>{t`Published`}</span>
      <span className="text-end">{actionsLabel ?? ''}</span>
    </div>
  );
}
