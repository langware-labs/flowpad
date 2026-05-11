import { useCallback, useEffect, useMemo, useState } from 'react';
import { isReadOnlySource, type AssetDescriptor } from '@sdk';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { useAssetTypes } from '@src/hooks/use-asset-types';
import { useProcessAssets } from './useProcessAssets';
import {
  displayLabelForTypeid,
  makeIconForType,
  parseTypeid,
} from './asset-row-helpers';
import { Boxes, Lock, Search, type LucideIcon } from 'lucide-react';

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
}: AssetPickerPopoverProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  // process: null → useProcessAssets returns the synthetic Agent + Skill list
  // pulled from the global entity queries. No process needs to exist yet.
  const { descriptors, isLoading, refresh } = useProcessAssets(null, { enabled: open });
  const { types: assetTypes } = useAssetTypes();
  const iconForType = useMemo(() => makeIconForType(assetTypes), [assetTypes]);

  // Refresh when opening so the list reflects newly-added agents/skills.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (!next) setQuery('');
  }, []);

  const rows = useMemo(() => {
    const candidates = descriptors.filter(filter);
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((d) => {
      const label = displayLabelForTypeid(d.typeid).toLowerCase();
      return (
        label.includes(q) ||
        d.typeid.toLowerCase().includes(q) ||
        (typeof d.posix_path === 'string' ? d.posix_path : '').toLowerCase().includes(q)
      );
    });
  }, [descriptors, filter, query]);

  const handlePick = useCallback(
    (d: AssetDescriptor) => {
      onPick(d);
      setOpen(false);
      setQuery('');
    },
    [onPick],
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex max-h-[calc(100vh-6rem)] w-96 flex-col p-0"
        data-testid="asset-picker-popover"
      >
        <div className="flex items-center gap-1.5 border-b px-3 py-2">
          <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">Run with…</span>
        </div>
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

  return (
    <button
      type="button"
      className="flex w-full items-center gap-2 border-b px-3 py-1.5 text-left text-xs last:border-b-0 hover:bg-muted/50"
      onClick={() => onPick(descriptor)}
      data-testid={`asset-picker-row-${descriptor.typeid}`}
    >
      <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {readOnly && (
        <Lock
          className="h-3 w-3 flex-shrink-0 text-muted-foreground"
          aria-label="Read-only source"
        />
      )}
      <span
        className="flex-shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
        title={descriptor.source}
      >
        {type}
      </span>
    </button>
  );
}
