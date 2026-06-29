import { Suspense, lazy, useCallback, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { APIEntity, GraphContext, QueryRequest, TypeId, isTypeId } from '@sdk';
import { useEntity } from '@sdk/react/hooks';
import { useEntitiesQuery } from '@src/hooks/entity-hooks';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import { Checkbox } from '@src/components/ui/checkbox';
import { ConfirmDialog } from '@src/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { notify } from '@src/notifications';
import { cn } from '@src/lib/utils';
import { List, MoreVertical, Network, Pencil, Trash2 } from 'lucide-react';

import { RunAutomationPanel } from './RunAutomationPanel';

// Lazy — pulls sigma/WebGL only when the Graph mode actually mounts.
const ContextGraphCanvas = lazy(() => import('./ContextGraphCanvas'));

type ViewMode = 'graph' | 'list';

interface GraphContextViewerProps {
  /** The GraphContext entity id (dock pointer = /dock/graph_context/<id>). */
  pointer?: string;
}

/**
 * Phase-1 viewer for a frozen GraphContext: a sidebar listing every saved
 * context and a main pane rendering the current context's typeids as resolved
 * rows (type icon + entity name). URL-first throughout — the sidebar navigates,
 * never mutates context, and the active item is derived from the URL pointer.
 */
export function GraphContextViewer({ pointer }: GraphContextViewerProps) {
  const { t } = useLingui();
  const { navigation, currentDock } = useDockNavigation();

  const typeId = useMemo(
    () => (pointer ? new TypeId(GraphContext.type, pointer) : null),
    [pointer],
  );
  const { data: ctx, isLoading } = useEntity<GraphContext>(typeId, { enabled: !!typeId });

  // Per-type icon from the backend registry (TypeInfo.icon) — never hardcoded.
  const ContextIcon = iconForType(GraphContext.type);

  // Reactive list of all saved contexts for the sidebar (no scope = all visible).
  // Memoize the request — an inline QueryRequest re-subscribes every render and
  // loops useSyncExternalStore (InboxView.tsx uses the same memoized pattern).
  const listRequest = useMemo(() => new QueryRequest({ type: GraphContext.type }), []);
  const { data: allContexts } = useEntitiesQuery<GraphContext>(listRequest);
  const contexts = useMemo(() => allContexts ?? [], [allContexts]);

  // Main-pane view mode — graph (default) vs the resolved-rows list.
  const [mode, setMode] = useState<ViewMode>('graph');

  // ── Selection + delete state ──────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingDelete, setPendingDelete] = useState<string[] | null>(null);

  // ── Inline rename. Renaming the entity's `name` propagates to the tab chip
  // via the generic entity→tab mirror (useSyncContentTabNames). ───────────────
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const startRename = useCallback((c: GraphContext) => {
    setRenamingId(c.id);
    setDraft(c.displayName);
  }, []);
  const commitRename = useCallback(
    async (c: GraphContext) => {
      const name = draft.trim();
      setRenamingId(null);
      if (!name || name === c.displayName) return;
      try {
        c.name = name;
        await c.save();
      } catch (e) {
        notify.error({
          title: t`Could not rename context`,
          message: e instanceof Error ? e.message : t`Rename failed.`,
        });
      }
    },
    [draft],
  );

  const allSelected = contexts.length > 0 && selected.size === contexts.length;

  const toggleOne = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const selectAll = useCallback(() => setSelected(new Set(contexts.map((c) => c.id))), [contexts]);
  const clearAll = useCallback(() => setSelected(new Set()), []);

  const runDelete = useCallback(
    async (ids: string[]) => {
      const byId = new Map(contexts.map((c) => [c.id, c]));
      const deletingActiveId = typeId && ids.includes(typeId.id) ? typeId.id : null;
      let failed = 0;
      for (const id of ids) {
        const ent = byId.get(id);
        if (!ent) continue;
        try {
          await ent.delete();
        } catch {
          failed += 1;
        }
      }
      setSelected(new Set());
      if (failed > 0) {
        notify.error({
          title: t`Some contexts could not be deleted`,
          message: t`${failed} of ${ids.length} failed to delete.`,
        });
      }
      // If the open context was deleted, route to a remaining one (or close).
      if (deletingActiveId) {
        const remaining = contexts.find((c) => !ids.includes(c.id));
        if (remaining) navigation.openDock(DockPointer.forGraphContext(remaining.id));
        else navigation.openDock(null);
      }
    },
    [contexts, typeId, navigation],
  );

  const rows = useMemo(() => {
    const ids = ctx?.context_typeids ?? [];
    const slotMap = ctx?.slot_map ?? {};
    // Invert slot_map (typeid → slot label) so each row can show where it came from.
    const slotByTypeId: Record<string, string> = {};
    for (const [slot, tid] of Object.entries(slotMap)) slotByTypeId[tid] = slot;
    return ids.map((tid) => ({ tid, slot: slotByTypeId[tid] }));
  }, [ctx?.context_typeids, ctx?.slot_map]);

  return (
    <div className="flex h-full w-full">
      {/* Sidebar — all saved contexts */}
      <aside className="flex w-64 shrink-0 flex-col border-r bg-muted/20">
        <div className="flex items-center gap-2 border-b px-3 py-2 text-sm font-medium">
          <ContextIcon className="h-4 w-4" />
          <Trans>Saved Contexts</Trans>
          <DropdownMenu>
            <DropdownMenuTrigger
              className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label={t`Context list actions`}
              disabled={contexts.length === 0}
            >
              <MoreVertical className="h-4 w-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={selectAll} disabled={allSelected}>
                <Trans>Select all</Trans>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={clearAll} disabled={selected.size === 0}>
                <Trans>Clear selection</Trans>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                disabled={selected.size === 0}
                onSelect={() => setPendingDelete([...selected])}
              >
                Delete selected{selected.size > 0 ? ` (${selected.size})` : ''}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => setPendingDelete(contexts.map((c) => c.id))}
              >
                <Trans>Delete all</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Bulk-action bar — only when something is selected */}
        {selected.size > 0 && (
          <div className="flex items-center justify-between border-b px-3 py-1.5 text-xs">
            <span className="text-muted-foreground"><Trans>{selected.size} selected</Trans></span>
            <div className="flex items-center gap-2">
              <button className="hover:text-foreground" onClick={clearAll}>
                <Trans>Clear</Trans>
              </button>
              <button
                className="inline-flex items-center gap-1 text-destructive hover:underline"
                onClick={() => setPendingDelete([...selected])}
              >
                <Trash2 className="h-3.5 w-3.5" />
                <Trans>Delete</Trans>
              </button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto py-1">
          {contexts.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground"><Trans>No saved contexts yet.</Trans></div>
          ) : (
            contexts.map((c) => {
              const isActive = currentDock?.pointer === c.id;
              const isChecked = selected.has(c.id);
              return (
                <div
                  key={c.id}
                  className={cn(
                    'group flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted',
                    isActive && 'bg-muted font-medium',
                  )}
                >
                  <Checkbox
                    checked={isChecked}
                    onCheckedChange={() => toggleOne(c.id)}
                    aria-label={t`Select ${c.displayName}`}
                    onClick={(e) => e.stopPropagation()}
                  />
                  {renamingId === c.id ? (
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onBlur={() => void commitRename(c)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void commitRename(c);
                        } else if (e.key === 'Escape') {
                          setRenamingId(null);
                        }
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 text-sm outline-none focus:ring-1 focus:ring-ring"
                      data-testid={`context-rename-input-${c.id}`}
                    />
                  ) : (
                    <button
                      onClick={() => navigation.openDock(DockPointer.forGraphContext(c.id))}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <ContextIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{c.displayName}</span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {c.context_typeids?.length ?? 0}
                      </span>
                    </button>
                  )}
                  {renamingId !== c.id && (
                    <button
                      onClick={() => startRename(c)}
                      className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
                      aria-label={t`Rename ${c.displayName}`}
                      title={t`Rename context`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    onClick={() => setPendingDelete([c.id])}
                    className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                    aria-label={t`Delete ${c.displayName}`}
                    title={t`Delete context`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* Main pane — graph (default) or list of the selected context */}
      <main className="relative flex-1 overflow-hidden">
        {!typeId ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Trans>Select a context.</Trans>
          </div>
        ) : isLoading || !ctx ? (
          <div className="flex h-full items-center justify-center text-muted-foreground"><Trans>Loading…</Trans></div>
        ) : (
          <>
            {/* Maps-style mode toggle (graph ⟷ list) */}
            <div className="absolute right-3 top-3 z-20 flex overflow-hidden rounded-md border bg-background/90 shadow-sm backdrop-blur">
              <button
                onClick={() => setMode('graph')}
                className={cn(
                  'flex h-7 w-8 items-center justify-center text-muted-foreground hover:bg-muted',
                  mode === 'graph' && 'bg-muted text-foreground',
                )}
                aria-label={t`Graph view`}
                title={t`Graph view`}
              >
                <Network className="h-4 w-4" />
              </button>
              <button
                onClick={() => setMode('list')}
                className={cn(
                  'flex h-7 w-8 items-center justify-center border-l text-muted-foreground hover:bg-muted',
                  mode === 'list' && 'bg-muted text-foreground',
                )}
                aria-label={t`List view`}
                title={t`List view`}
              >
                <List className="h-4 w-4" />
              </button>
            </div>

            {mode === 'graph' ? (
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    <Trans>Loading graph…</Trans>
                  </div>
                }
              >
                <ContextGraphCanvas root={ctx} />
              </Suspense>
            ) : (
              <div className="h-full overflow-y-auto">
                <div className="mx-auto max-w-3xl p-6">
                  <div className="mb-1 text-lg font-semibold">{ctx.displayName}</div>
                  <div className="mb-4 text-sm text-muted-foreground">
                    {rows.length} {rows.length === 1 ? 'entity' : 'entities'} in this context
                  </div>
                  {rows.length === 0 ? (
                    <div className="text-sm text-muted-foreground"><Trans>This context is empty.</Trans></div>
                  ) : (
                    <div className="divide-y rounded-md border">
                      {rows.map(({ tid, slot }) => (
                        <ContextRow key={tid} typeIdStr={tid} slot={slot} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {/* Right rail — Run Automation (agent/skill) on this context. */}
      {typeId && ctx && <RunAutomationPanel ctx={ctx} />}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={
          pendingDelete && pendingDelete.length > 1
            ? t`Delete ${pendingDelete.length} contexts?`
            : t`Delete context?`
        }
        description={t`This permanently removes the saved context snapshot. This cannot be undone.`}
        confirmLabel={t`Delete`}
        variant="destructive"
        onConfirm={() => {
          if (pendingDelete) void runDelete(pendingDelete);
        }}
      />
    </div>
  );
}

/** One frozen typeid resolved to its entity (type icon + name), with the slot it came from. */
function ContextRow({ typeIdStr, slot }: { typeIdStr: string; slot?: string }) {
  const typeId = useMemo(() => (isTypeId(typeIdStr) ? new TypeId(typeIdStr) : null), [typeIdStr]);
  const { data: entity } = useEntity<APIEntity<any>>(typeId, { enabled: !!typeId });

  const Icon = useMemo(() => iconForType(typeId?.type ?? ''), [typeId?.type]);
  const label = entity?.displayName || typeIdStr;

  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm">{label}</div>
        <div className="truncate text-xs text-muted-foreground">{typeIdStr}</div>
      </div>
      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
        {slot ?? typeId?.type ?? '—'}
      </span>
    </div>
  );
}
