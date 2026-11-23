import { useEffect, useState, type RefObject } from 'react';
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, Network, type LucideIcon } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { GraphContext, TypeId, dataContext, dataManager, type AnyEntity } from '@sdk';
import type { ContextRelation, ContextVia } from '@sdk/types/context-relation';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { compactEntityActionClassName } from '@src/components/entity-actions/action-button-styles';
import { iconForType, labelForType } from '@src/components/graph-view/icons/iconRegistry';
import { useIsDev } from '@src/components/view-mode';
import { cn } from '@src/lib/utils';
import { SEGMENTED_ACTIVE, SEGMENTED_GROUP, SEGMENTED_IDLE } from '@src/components/ui/segmented';
import { DockPointer } from '@src/navigation/DockPointer';
import { dockPointerForTypeId } from '@src/navigation/entity-pointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { formatMoment, formatTimeAgo } from '@src/utils/format-time-ago';

const VIAS: readonly ContextVia[] = ['static', 'dynamic', 'user'];

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
 *
 * Two ways to use it. On its own it draws its button and owns its open state. Controlled
 * (`open` + `onOpenChange`), it draws NO button: someone else opens it (the top bar's menu) and
 * the list hangs off `anchorRef`.
 */
export interface ContextMenuButtonProps {
  typeId: TypeId;
  title?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Controlled mode: the element the list is placed against. */
  anchorRef?: RefObject<HTMLElement | null>;
}

/** Whether this runtime shows an entity's context at all. */
export function contextMenuAvailable(): boolean {
  return dataContext.caps.localFiles;
}

export function ContextMenuButton(props: ContextMenuButtonProps) {
  // Not on the hub (exception, 2026-11-13): whether the hub keeps context relationships is not yet settled.
  return contextMenuAvailable() ? <ContextMenuPopover {...props} /> : null;
}

function ContextMenuPopover({
  typeId,
  title,
  open: controlledOpen,
  onOpenChange: onControlledOpenChange,
  anchorRef,
}: ContextMenuButtonProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const isDev = useIsDev();
  const controlled = controlledOpen !== undefined;
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlled ? controlledOpen : ownOpen;
  const setOpen = (next: boolean) => {
    if (!controlled) setOwnOpen(next);
    onControlledOpenChange?.(next);
  };
  const [rows, setRows] = useState<ContextRelation[] | null>(null);
  const [failed, setFailed] = useState(false);
  // Which origins the list shows: a row stays while any way it is held is switched on.
  const [shown, setShown] = useState<ReadonlySet<ContextVia>>(() => new Set(VIAS));
  const visible = rows?.filter((row) => row.via.some((via) => shown.has(via))) ?? null;
  const toggle = (via: ContextVia) =>
    setShown((current) => {
      const next = new Set(current);
      if (next.has(via)) next.delete(via);
      else next.add(via);
      return next;
    });
  const ContextIcon = iconForType(GraphContext.type);

  // Read on every open, whoever opened it (the button here, or the controlling parent).
  const target = typeId.toString();
  useEffect(() => {
    if (!open) return;
    let stale = false;
    setRows(null);
    setFailed(false);
    dataManager
      .getByTypeId<AnyEntity>(new TypeId(target))
      .then((entity) => (entity ? entity.getContextRelations() : []))
      .then((found) => {
        if (!stale) setRows(found);
      })
      .catch((err) => {
        console.error('[ContextMenuButton] context-relations failed', err);
        if (!stale) setFailed(true);
      });
    return () => {
      stale = true;
    };
  }, [open, target]);

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

  const viaLabel: Record<ContextVia, { label: string; hint: string }> = {
    static: { label: t`Static`, hint: t`Part of its structure, like a document's project` },
    dynamic: { label: t`Dynamic`, hint: t`Linked automatically, like a plan found in a session` },
    user: { label: t`User`, hint: t`Made by someone's action, like starting a chat on it` },
  };

  const directionLabel: Record<ContextRelation['direction'], string> = {
    in: t`Incoming`,
    out: t`Outgoing`,
    both: t`Incoming and outgoing`,
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {controlled ? (
        anchorRef && <PopoverAnchor virtualRef={anchorRef as RefObject<HTMLElement>} />
      ) : (
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
      )}
      <PopoverContent align="end" className="w-[22rem] space-y-2 p-2 text-xs" data-testid="context-menu">
        <div className="flex items-center gap-1.5">
          <ContextIcon className="h-3 w-3 text-foreground" />
          <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
            <Trans>Context</Trans>
          </span>
          {visible && <span className="text-[11px] text-muted-foreground">{visible.length}</span>}
          <div className={cn(SEGMENTED_GROUP, 'ms-auto')} role="group" aria-label={t`Show`}>
            {VIAS.map((via) => (
              <button
                key={via}
                type="button"
                aria-pressed={shown.has(via)}
                onClick={() => toggle(via)}
                title={viaLabel[via].hint}
                className={cn(
                  'flex h-5 items-center rounded-sm px-1.5 text-[10px] transition-colors',
                  shown.has(via) ? SEGMENTED_ACTIVE : cn(SEGMENTED_IDLE, 'line-through'),
                )}
                data-testid={`context-menu-filter-${via}`}
              >
                {viaLabel[via].label}
              </button>
            ))}
          </div>
          {isDev && (
            <button
              type="button"
              onClick={() => void openAsGraph()}
              disabled={!rows}
              title={t`Open as graph`}
              aria-label={t`Open as graph`}
              className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
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
        ) : !visible?.length ? (
          <Hint text={t`Nothing of the kinds switched on.`} />
        ) : (
          // One grid for every row (rows are subgrids), so each field starts on the same line down the list.
          <div
            role="menu"
            className="grid grid-cols-[auto_auto_auto_minmax(0,1fr)_auto] divide-y divide-border rounded border border-border bg-background"
          >
            {visible.map((row) => {
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
                  data-via={row.via.join(' ')}
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
