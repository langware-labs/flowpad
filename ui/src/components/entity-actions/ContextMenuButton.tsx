import { useState } from 'react';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Network, type LucideIcon } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { GraphContext, TypeId, dataContext, dataManager, type AnyEntity } from '@sdk';
import type { ContextRelation } from '@sdk/types/context-relation';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { compactEntityActionClassName } from '@src/components/entity-actions/action-button-styles';
import { iconForType, labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { useIsDev } from '@src/components/view-mode';
import { cn } from '@src/lib/utils';
import { DockPointer } from '@src/navigation/DockPointer';
import { dockPointerForTypeId } from '@src/navigation/entity-pointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { formatMoment, formatTimeAgo } from '@src/utils/format-time-ago';

const DIRECTION_ICON: Record<ContextRelation['direction'], LucideIcon> = {
  in: ArrowDownLeft,
  out: ArrowUpRight,
  both: ArrowLeftRight,
};

/**
 * The entity's context, one click away: every entity that holds this one in its
 * context or is held by it, as one list — direction, type, name, and when.
 *
 * Read on open through the entity's `context-relations` action; a row only
 * navigates. Nothing here writes context.
 */
export function ContextMenuButton({ typeId, title }: { typeId: TypeId; title?: string }) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const isDev = useIsDev();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<ContextRelation[] | null>(null);
  const [failed, setFailed] = useState(false);
  const ContextIcon = iconForType(GraphContext.type);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) return;
    setRows(null);
    setFailed(false);
    dataManager
      .getByTypeId<AnyEntity>(typeId)
      .then((entity) => (entity ? entity.getContextRelations() : []))
      .then(setRows)
      .catch((err) => {
        console.error('[ContextMenuButton] context-relations failed', err);
        setFailed(true);
      });
  };

  const openRow = async (row: ContextRelation) => {
    setOpen(false);
    const pointer = await dockPointerForTypeId(new TypeId(row.typeid));
    if (pointer) navigation.openDock(pointer);
  };

  // Freeze this entity and what its context holds into a GraphContext, and open it as the graph.
  const openAsGraph = async () => {
    const graph = new GraphContext({});
    graph.context_typeids = [typeId.toString(), ...(rows ?? []).map((row) => row.typeid)];
    graph.slot_map = {};
    graph.name = title ? t`Context of ${title}` : t`Context ${graph.id.slice(0, 8)}`;
    try {
      await graph.save(dataContext.project?.typeId ? [dataContext.project.typeId] : []);
    } catch (err) {
      notify.error({
        title: t`Could not freeze context`,
        message: err instanceof Error ? err.message : t`Failed to save the context snapshot.`,
      });
      return;
    }
    setOpen(false);
    navigation.openDock(DockPointer.forGraphContext(graph.typeId.id));
  };

  const directionLabel: Record<ContextRelation['direction'], string> = {
    in: t`Incoming`,
    out: t`Outgoing`,
    both: t`Incoming and outgoing`,
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(compactEntityActionClassName, open && 'bg-accent text-accent-foreground')}
          aria-label={t`Context`}
          title={t`Context`}
          data-testid="entity-actions-context"
        >
          <ContextIcon className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[22rem] space-y-2 p-2 text-xs" data-testid="context-menu">
        <div className="flex items-center gap-1.5">
          <ContextIcon className="h-3 w-3 text-foreground" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
            <Trans>Context</Trans>
          </span>
          {rows && <span className="text-[11px] text-muted-foreground">{rows.length}</span>}
          {isDev && (
            <button
              type="button"
              onClick={() => void openAsGraph()}
              disabled={!rows}
              title={t`Open as graph`}
              aria-label={t`Open as graph`}
              className="ms-auto inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
              data-testid="context-menu-open-graph"
            >
              <Network className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {failed ? (
          <Hint text={t`Could not load the context.`} />
        ) : rows === null ? (
          <Hint text={t`Loading…`} />
        ) : rows.length === 0 ? (
          <Hint text={t`Nothing is linked to this yet.`} />
        ) : (
          // One grid for every row (rows are subgrids), so each field starts on the same line down the list.
          <div
            role="menu"
            className="grid grid-cols-[auto_auto_auto_minmax(0,1fr)_auto] divide-y divide-border rounded border border-border bg-background"
          >
            {rows.map((row) => {
              const Direction = DIRECTION_ICON[row.direction];
              const TypeIcon = iconForType(row.type);
              const type = labelForType(row.type);
              // An entity nothing names (an untitled session) goes by the start of its id.
              const name = row.name || new TypeId(row.typeid).id.slice(0, 8);
              return (
                <button
                  key={row.typeid}
                  type="button"
                  role="menuitem"
                  onClick={() => void openRow(row)}
                  title={`${directionLabel[row.direction]} · ${type}: ${name}`}
                  className="col-span-5 grid grid-cols-subgrid items-center gap-x-2 px-2 py-1.5 text-start text-[11px] transition-colors hover:bg-muted/40"
                  data-testid="context-menu-row"
                  data-direction={row.direction}
                >
                  <Direction className="h-3 w-3 text-foreground" aria-label={directionLabel[row.direction]} />
                  <TypeIcon className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
                  <span className="whitespace-nowrap text-muted-foreground">{type}</span>
                  <span className="truncate text-foreground">{name}</span>
                  <span className="flex flex-col items-end whitespace-nowrap leading-tight">
                    <span className="text-foreground">{formatMoment(row.time) ?? '—'}</span>
                    <span className="text-[9px] text-muted-foreground">{formatTimeAgo(row.time) ?? ''}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Hint({ text }: { text: string }) {
  return (
    <div className="rounded border border-dashed border-border px-2 py-2 text-center text-[11px] italic text-muted-foreground/70">
      {text}
    </div>
  );
}
