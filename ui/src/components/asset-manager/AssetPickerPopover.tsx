import { useCallback, useEffect, useMemo, useState } from 'react';
import { isReadOnlySource, type AssetDescriptor } from '@sdk';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { Dialog, DialogContent, DialogTitle } from '@src/components/ui/dialog';
import { useAssetTypes } from '@src/hooks/use-asset-types';
import { useProcessAssets } from './useProcessAssets';
import {
  displayLabelForTypeid,
  makeIconForType,
  parseTypeid,
} from './asset-row-helpers';
import { EntityTypeBar, type EntityTypeFilter } from './EntityTypeBar';
import { ScopeFilterIconBar } from '@src/components/scope-filter/ScopeFilterIconBar';
import { useDefaultScopeFilter } from '@src/hooks/use-default-scope-filter';
import { ALL_SCOPE_FILTER } from '@src/lib/scope-filter';
import { useAllProjects } from '@src/hooks/use-all-projects';
import { Boxes, Lock, Search, type LucideIcon } from 'lucide-react';
import { openExternalFromComputeNode } from '@sdk/entities/compute-node';

interface AssetPickerPopoverProps {
  /** Popover trigger (typically a Run button); passed to PopoverTrigger asChild. */
  trigger: React.ReactNode;
  /** Called once when the user clicks an asset row. The popover closes. */
  onPick: (descriptor: AssetDescriptor) => void;
  /**
   * Restrict the visible candidates. Default keeps only executable assets
   * (skills + agents). Workflows are intentionally excluded — they are
   * runnable themselves rather than embeddable into another process.
   */
  filter?: (descriptor: AssetDescriptor) => boolean;
  /** Optional override for the placeholder text in the search input. */
  searchPlaceholder?: string;
  /** Optional controlled open state. When provided, the parent drives the
   *  popover (e.g. opening it programmatically from a dropdown menu item).
   *  When omitted the component manages its own open state. */
  open?: boolean;
  /** Required when `open` is provided. Called when the popover should close
   *  or open (e.g. user clicks outside, or after `onPick`). */
  onOpenChange?: (open: boolean) => void;
  /** Preferred side to open on. Defaults to `'bottom'`. Pass `'top'` when the
   *  trigger sits near the bottom of the viewport (e.g. a message composer)
   *  so the picker opens upward and its contents stay visible. Collision
   *  detection still flips it back if there's no room on the preferred side. */
  side?: 'top' | 'bottom';
  /** When true, render the picker as a centered modal dialog instead of a
   *  popover anchored to the trigger. Use when the trigger is incidental
   *  (e.g. a fan-out attach menu) and the picker should sit in the middle of
   *  the screen. `side`/`align` are ignored in this mode. */
  centered?: boolean;
}

const DEFAULT_FILTER = (d: AssetDescriptor): boolean =>
  d.typeid.startsWith('skill-') || d.typeid.startsWith('agent-');

/**
 * Single-select asset picker. Shares the data hook (`useProcessAssets`) and
 * descriptor model with `AssetManagerPopover`, but renders one row per
 * `(typeid, source)` pair and emits a single `onPick(descriptor)` rather
 * than driving an attach/detach toggle.
 *
 * Designed for "Run on this file" — the host wires `onPick` to an action that
 * spawns an `AgenticProcess` with the descriptor as an embedded asset.
 */
export function AssetPickerPopover({
  trigger,
  onPick,
  filter = DEFAULT_FILTER,
  searchPlaceholder = 'Search agents and skills…',
  open: controlledOpen,
  onOpenChange,
  side = 'bottom',
  centered = false,
}: AssetPickerPopoverProps) {
  const isControlled = controlledOpen !== undefined;
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      if (isControlled) onOpenChange?.(next);
      else setUncontrolledOpen(next);
    },
    [isControlled, onOpenChange],
  );
  const [query, setQuery] = useState('');
  // Independent per-type toggles. Empty set = no type filter (show all). Each
  // icon toggles its own type on/off without affecting the others.
  const [selectedTypes, setSelectedTypes] = useState<string[]>([]);
  const toggleType = useCallback(
    (t: string) =>
      setSelectedTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t])),
    [],
  );
  const clearTypes = useCallback(() => setSelectedTypes([]), []);
  const [scope, setScope, currentProjectId] = useDefaultScopeFilter();
  const { projects: allProjects } = useAllProjects({ enabled: open });
  const scopeProjectIds = useMemo(() => {
    const ids = new Set(scope.projects);
    for (const p of allProjects) {
      if (scope.projects.includes(p.id) && p.record_project_id) ids.add(p.record_project_id);
    }
    return ids;
  }, [allProjects, scope.projects]);

  // process: null → useProcessAssets returns the synthetic Agent + Skill list
  // pulled from the global entity queries. No process needs to exist yet.
  const { descriptors, isLoading, refresh } = useProcessAssets(null, { enabled: open });
  const { types: assetTypes } = useAssetTypes();
  const iconForType = useMemo(() => makeIconForType(assetTypes), [assetTypes]);

  // On open: refresh the list and start from "All" so every agent/skill is
  // visible by default (the project-scoped default would hide user assets).
  useEffect(() => {
    if (open) {
      void refresh();
      setScope({ ...ALL_SCOPE_FILTER });
    }
  }, [open, refresh, setScope]);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) {
      setQuery('');
      setSelectedTypes([]);
    }
  }, [setOpen]);

  // Type counts respect the host-level ``filter`` so the chips reflect what
  // could actually appear in the list (e.g. when the host restricts to
  // executable assets only).
  const typeCounts = useMemo(() => {
    const counts: Partial<Record<EntityTypeFilter, number>> = { all: 0 };
    for (const d of descriptors) {
      if (!filter(d)) continue;
      counts.all = (counts.all ?? 0) + 1;
      const { type } = parseTypeid(d.typeid);
      if (type === 'agent' || type === 'skill' || type === 'markdown' || type === 'spec') {
        counts[type] = (counts[type] ?? 0) + 1;
      }
    }
    return counts;
  }, [descriptors, filter]);

  // Only the asset types the host filter actually admits (those with candidates)
  // become toggles — keeps the bar from overflowing with types that can't appear.
  const allowedTypes = useMemo(
    () =>
      (['agent', 'skill', 'markdown', 'spec'] as const).filter((t) => (typeCounts[t] ?? 0) > 0),
    [typeCounts],
  );

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return descriptors.filter((d) => {
      if (!filter(d)) return false;
      if (selectedTypes.length > 0) {
        const { type } = parseTypeid(d.typeid);
        if (!selectedTypes.includes(type)) return false;
      }
      // Scope gate — skipped entirely when scope = "All" (show everything).
      if (!scope.all) {
        if (d.project_id) {
          if (!scopeProjectIds.has(d.project_id)) return false;
        } else if (!scope.user) {
          return false;
        }
      }
      if (q) {
        const label = displayLabelForTypeid(d.typeid).toLowerCase();
        return (
          label.includes(q) ||
          d.typeid.toLowerCase().includes(q) ||
          (typeof d.posix_path === 'string' ? d.posix_path : '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [descriptors, filter, query, selectedTypes, scope, scopeProjectIds]);

  const handlePick = useCallback(
    (d: AssetDescriptor) => {
      onPick(d);
      setOpen(false);
      setQuery('');
      setSelectedTypes([]);
    },
    [onPick, setOpen],
  );

  const body = (
    <>
      <div className="flex items-center gap-1.5 border-b px-3 py-2">
        <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Select Asset</span>
        <div className="ml-auto flex items-center" data-testid="asset-picker-scope-bar">
          <ScopeFilterIconBar
            scope={scope}
            currentProjectId={currentProjectId}
            onScopeChange={setScope}
          />
        </div>
      </div>
      {allowedTypes.length > 0 && (
        <div
          className="flex items-center border-b px-3 py-1.5"
          data-testid="asset-picker-type-bar"
        >
          <EntityTypeBar
            selected={selectedTypes}
            onToggle={toggleType}
            onClear={clearTypes}
            counts={typeCounts}
            allowed={allowedTypes}
            iconForType={iconForType}
          />
        </div>
      )}
      <div className="border-b px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Search className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
          <input
            autoFocus
            type="text"
            placeholder={searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="min-w-0 flex-1 rounded border bg-background px-1.5 py-0.5 text-[11px] outline-none focus:ring-1 focus:ring-ring"
            data-testid="asset-picker-search"
          />
        </div>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="asset-picker-list"
      >
        {rows.length === 0 ? (
          <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
            {isLoading ? 'Loading…' : 'No assets to run.'}
          </div>
        ) : (
          rows.map((d, idx) => (
            <PickRow
              key={`${d.typeid}|${d.source}|${idx}`}
              descriptor={d}
              iconForType={iconForType}
              onPick={handlePick}
            />
          ))
        )}
      </div>
    </>
  );

  if (centered) {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          className="flex max-h-[min(85vh,40rem)] w-96 max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0"
          data-testid="asset-picker-popover"
        >
          <DialogTitle className="sr-only">Attach asset</DialogTitle>
          {body}
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        side={side}
        sideOffset={4}
        collisionPadding={8}
        className="flex max-h-[min(calc(100vh-6rem),var(--radix-popover-content-available-height))] w-96 flex-col p-0"
        data-testid="asset-picker-popover"
      >
        {body}
      </PopoverContent>
    </Popover>
  );
}

function PickRow({
  descriptor,
  iconForType,
  onPick,
}: {
  descriptor: AssetDescriptor;
  iconForType: (type: string) => LucideIcon;
  onPick: (d: AssetDescriptor) => void;
}) {
  const { type } = parseTypeid(descriptor.typeid);
  const Icon = iconForType(type);
  const readOnly = isReadOnlySource(descriptor.source);
  const label = displayLabelForTypeid(descriptor.typeid);

  const revealInFinder = () =>
    void openExternalFromComputeNode('@local', descriptor.posix_path!, { select: true });

  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 border-b px-3 py-1.5 text-left text-xs last:border-b-0 hover:bg-muted/50"
      onClick={() => onPick(descriptor)}
      data-testid={`asset-picker-row-${descriptor.typeid}`}
    >
      <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {readOnly &&
        (descriptor.posix_path ? (
          // Read-only assets live on local disk — clicking the lock reveals
          // the backing file in Finder/Explorer rather than picking the row.
          <span
            role="button"
            tabIndex={0}
            className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Reveal in Finder/Explorer"
            title={`Reveal in Finder/Explorer\n${descriptor.posix_path}`}
            onClick={(e) => {
              e.stopPropagation();
              revealInFinder();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                e.stopPropagation();
                revealInFinder();
              }
            }}
          >
            <Lock className="h-3 w-3" />
          </span>
        ) : (
          <Lock
            className="h-3 w-3 flex-shrink-0 text-muted-foreground"
            aria-label="Read-only source"
          />
        ))}
      <span
        className="flex-shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
        title={descriptor.source}
      >
        {type}
      </span>
    </button>
  );
}
