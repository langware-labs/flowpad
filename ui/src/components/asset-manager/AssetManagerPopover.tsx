import { useCallback, useMemo, useState } from 'react';
import {
  AgenticProcess,
  ASSET_SOURCE_LABEL,
  isReadOnlySource,
  type AssetDescriptor,
  type AssetSource,
} from '@sdk';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@src/components/ui/popover';
import { useProcessAssets } from './useProcessAssets';
import { useAssetTypes, type AssetTypeInfo } from '@src/hooks/use-asset-types';
import { lucideByName } from '@src/lib/lucide-by-name';
import { ICON_BY_TYPE } from '@src/components/conversation/EntityChip';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ArrowLeft, Boxes, Lock, Plus, X, type LucideIcon } from 'lucide-react';

const READONLY_TOOLTIP_BY_SOURCE: Partial<Record<AssetSource, string>> = {
  project_dir: 'Defined in the project — edits propagate to every process under this project. Attach to get a private editable copy.',
  user_dir: 'Defined in your user folder — edits propagate to every process you run. Attach to get a private editable copy.',
  workdir: 'Lives in the agent’s working directory. Attach to get a private editable copy.',
  additional_dir: 'Lives outside the project — edits propagate everywhere this path is referenced. Attach to get a private editable copy.',
};

interface AssetManagerPopoverProps {
  /** Process whose assets we are managing. Null before first-send. */
  process: AgenticProcess | null;
  /** Currently-attached refs (typeid strings). For pre-process staging. */
  attachedRefs: string[];
  onAttach: (ref: string) => void | Promise<void>;
  onDetach: (ref: string) => void | Promise<void>;
  /** The popover trigger; passed to PopoverTrigger asChild. */
  trigger: React.ReactNode;
  /** Optional extra content rendered below the assets table (e.g. project selector). */
  footer?: React.ReactNode;
}

/**
 * Reusable asset-management popover. Driven by `process.getAssets()`.
 *
 * Each row is a single ``(typeid, source)`` descriptor. The same typeid may
 * appear multiple times with different sources (e.g. a skill that's both
 * EMBEDDED and USER_DIR). The attach/detach toggle on a row writes to the
 * process's `embedded_asset_refs`; the EMBEDDED row appears after attach.
 */
export function AssetManagerPopover({
  process,
  attachedRefs,
  onAttach,
  onDetach,
  trigger,
  footer,
}: AssetManagerPopoverProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'list' | 'add'>('list');
  const [query, setQuery] = useState('');

  const { descriptors, refresh } = useProcessAssets(process, { enabled: open });
  const { types: assetTypes } = useAssetTypes();

  const iconForType = useCallback(
    (typeName: string): LucideIcon => {
      const ti = assetTypes.find((t: AssetTypeInfo) => t.type_name === typeName);
      // Prefer lucide-by-name from the assets/types API; fall back to the chat
      // EntityChip icon registry (kept in sync) when the API hasn't loaded yet.
      const fromApi = ti?.icon ? lucideByName(ti.icon) : null;
      if (fromApi) return fromApi;
      return ICON_BY_TYPE[typeName] ?? lucideByName(null);
    },
    [assetTypes],
  );

  const attachedSet = useMemo(() => new Set(attachedRefs), [attachedRefs]);

  // Group descriptors by typeid for the "list" mode — but show one row per
  // (typeid, source) pair so duplicate sources are explicitly visible.
  const rows = useMemo(() => {
    return [...descriptors].sort((a, b) => {
      // EMBEDDED first, then by source label, then by name suffix.
      const sa = a.source === 'embedded' ? 0 : 1;
      const sb = b.source === 'embedded' ? 0 : 1;
      if (sa !== sb) return sa - sb;
      if (a.source !== b.source) return a.source.localeCompare(b.source);
      return a.typeid.localeCompare(b.typeid);
    });
  }, [descriptors]);

  // Add-mode entries: anything not currently EMBEDDED. Each row is the
  // "source" copy that the user can attach to the process.
  const addModeRows = useMemo(() => {
    const embeddedTypeids = new Set(
      descriptors.filter((d) => d.source === 'embedded').map((d) => d.typeid),
    );
    const candidates = descriptors.filter(
      (d) => d.source !== 'embedded' && !embeddedTypeids.has(d.typeid),
    );
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((d) => d.typeid.toLowerCase().includes(q));
  }, [descriptors, query]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) void refresh();
      if (!next) {
        setMode('list');
        setQuery('');
      }
    },
    [refresh],
  );

  const toggleRow = useCallback(
    (ref: string) => {
      if (attachedSet.has(ref)) void onDetach(ref);
      else void onAttach(ref);
    },
    [attachedSet, onAttach, onDetach],
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-96 p-0"
        data-testid="asset-manager-popover"
      >
        {/* Header */}
        <div className="flex items-center gap-1.5 border-b px-3 py-2">
          {mode === 'add' && (
            <button
              type="button"
              className="-ml-1 flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted"
              onClick={() => setMode('list')}
              title="Back"
              data-testid="asset-manager-back"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
          )}
          <Boxes className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">
            {mode === 'add' ? 'Add asset' : 'Assets'}
          </span>
        </div>

        {mode === 'list' ? (
          <>
            <div data-testid="asset-manager-list">
              {rows.length === 0 && (
                <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                  No assets visible to this process.
                </div>
              )}
              {rows.map((d, idx) => (
                <AssetRow
                  key={`${d.typeid}|${d.source}|${idx}`}
                  descriptor={d}
                  iconForType={iconForType}
                  attached={attachedSet.has(d.typeid)}
                  onDetach={onDetach}
                />
              ))}
              <button
                type="button"
                className="flex w-full items-center gap-2 border-b bg-muted/30 px-3 py-2 text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => setMode('add')}
                data-testid="asset-manager-add"
              >
                <Plus className="h-3.5 w-3.5" />
                Attach asset
              </button>
            </div>

            {footer}
          </>
        ) : (
          <div>
            <div className="border-b px-3 py-2">
              <input
                autoFocus
                type="text"
                placeholder="Search agents and skills…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full rounded-md border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
                data-testid="asset-manager-search"
              />
            </div>
            <div className="max-h-72 overflow-y-auto">
              {addModeRows.length === 0 && (
                <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
                  No matches.
                </div>
              )}
              {addModeRows.map((d, idx) => (
                <AddModeRow
                  key={`${d.typeid}|${d.source}|${idx}`}
                  descriptor={d}
                  iconForType={iconForType}
                  checked={attachedSet.has(d.typeid)}
                  onToggle={toggleRow}
                />
              ))}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Row components ────────────────────────────────────────────────────────────

function _parseTypeid(typeid: string): { type: string; id: string } {
  const dash = typeid.indexOf('-');
  if (dash < 0) return { type: typeid, id: '' };
  return { type: typeid.slice(0, dash), id: typeid.slice(dash + 1) };
}

interface RowSharedProps {
  descriptor: AssetDescriptor;
  iconForType: (type: string) => LucideIcon;
}

function AssetRow({
  descriptor,
  iconForType,
  attached,
  onDetach,
}: RowSharedProps & {
  attached: boolean;
  onDetach: (ref: string) => void | Promise<void>;
}) {
  const { navigation } = useDockNavigation();
  const { type, id } = _parseTypeid(descriptor.typeid);
  const Icon = iconForType(type);
  const readOnly = isReadOnlySource(descriptor.source);

  const onChipClick = useCallback(() => {
    if (!id) return;
    try {
      // Read-only sources open in viewer mode (?readOnly=1). The assets editor
      // route honors this query param to disable save affordances.
      const sub = readOnly ? `editor/${type}/${id}?readOnly=1` : `editor/${type}/${id}`;
      navigation.openDock(new DockPointer('assets' as never, sub));
    } catch {
      // ignore navigation errors
    }
  }, [navigation, type, id, readOnly]);

  const sourceLabel = ASSET_SOURCE_LABEL[descriptor.source];
  const sourceTooltip = descriptor.posix_path
    ? `${sourceLabel}\n${descriptor.posix_path}`
    : `${sourceLabel}\n(no file — inline persona)`;
  const lockTooltip = READONLY_TOOLTIP_BY_SOURCE[descriptor.source] ?? 'Read-only from this process. Attach to get a private editable copy.';

  return (
    <div
      className="flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0"
      data-testid={`asset-manager-row-${descriptor.typeid}-${descriptor.source}`}
      data-read-only={readOnly ? 'true' : 'false'}
    >
      <button
        type="button"
        onClick={onChipClick}
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded border border-border bg-muted/30 px-1.5 py-0.5 text-xs text-foreground hover:bg-muted"
        title={readOnly ? `View ${descriptor.typeid} (read-only)` : `Open ${descriptor.typeid}`}
      >
        <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{descriptor.typeid}</span>
      </button>
      {readOnly && (
        <Lock
          className="h-3 w-3 flex-shrink-0 text-muted-foreground"
          aria-label="Read-only"
          data-testid={`asset-manager-readonly-${descriptor.typeid}-${descriptor.source}`}
        >
          <title>{lockTooltip}</title>
        </Lock>
      )}
      <span
        className="flex-shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
        title={sourceTooltip}
        data-testid={`asset-manager-source-${descriptor.typeid}-${descriptor.source}`}
      >
        {sourceLabel}
      </span>
      {attached && !readOnly && (
        <button
          type="button"
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => void onDetach(descriptor.typeid)}
          title="Detach"
          data-testid={`asset-manager-detach-${descriptor.typeid}`}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function AddModeRow({
  descriptor,
  iconForType,
  checked,
  onToggle,
}: RowSharedProps & {
  checked: boolean;
  onToggle: (ref: string) => void;
}) {
  const { type } = _parseTypeid(descriptor.typeid);
  const Icon = iconForType(type);
  const readOnly = isReadOnlySource(descriptor.source);
  const lockTooltip = READONLY_TOOLTIP_BY_SOURCE[descriptor.source] ?? 'Read-only source. Attach to get a private editable copy.';
  return (
    <label
      className="flex cursor-pointer items-center gap-2 border-b px-3 py-1.5 text-xs last:border-b-0 hover:bg-muted/50"
      data-testid={`asset-manager-add-row-${descriptor.typeid}`}
      data-read-only={readOnly ? 'true' : 'false'}
    >
      <input
        type="checkbox"
        className="h-3 w-3 flex-shrink-0"
        checked={checked}
        onChange={() => onToggle(descriptor.typeid)}
      />
      <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{descriptor.typeid}</span>
      {readOnly && (
        <Lock
          className="h-3 w-3 flex-shrink-0 text-muted-foreground"
          aria-label="Read-only source"
          data-testid={`asset-manager-add-readonly-${descriptor.typeid}-${descriptor.source}`}
        >
          <title>{lockTooltip}</title>
        </Lock>
      )}
      <span
        className="flex-shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground"
        title={ASSET_SOURCE_LABEL[descriptor.source]}
      >
        {ASSET_SOURCE_LABEL[descriptor.source]}
      </span>
    </label>
  );
}
