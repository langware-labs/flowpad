import { useId, useRef, useState } from 'react';
import { Paperclip, FileUp, Boxes, X, ChevronDown } from 'lucide-react';
import type { AssetDescriptor } from '@sdk';
import { Popover, PopoverContent, PopoverTrigger } from '@src/components/ui/popover';
import { AssetPickerPopover } from '@src/components/asset-manager/AssetPickerPopover';
import {
  displayLabelForTypeid,
  parseTypeid,
} from '@src/components/asset-manager/asset-row-helpers';

interface AttachMenuProps {
  assetRefs: AssetDescriptor[];
  onAssetRefsChange: (next: AssetDescriptor[]) => void;
  onFilesPicked: (files: FileList | null) => void;
  disabled?: boolean;
  /** Suppress the inline asset-chip list (parent renders chips externally
   *  via {@link AssetRefChips} — used by composer rows in flex layouts). */
  hideAssetList?: boolean;
}

/**
 * Attach trigger that fans out to the OS file picker or the asset picker.
 *
 * Implemented as two stacked Radix Popovers driven by a single piece of state
 * (``view``): ``"menu"`` shows the File/Asset choice; ``"asset"`` swaps the
 * content for the AssetPickerPopover. We deliberately avoid nesting
 * DropdownMenu + Popover — the portal/focus cascade between two Radix
 * primitives keeps closing the inner popover immediately after open.
 */
export function AttachMenu({
  assetRefs,
  onAssetRefsChange,
  onFilesPicked,
  disabled,
  hideAssetList,
}: AttachMenuProps) {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'menu' | 'asset'>('menu');

  const handlePick = (d: AssetDescriptor) => {
    if (assetRefs.some((a) => a.typeid === d.typeid && a.source === d.source)) return;
    onAssetRefsChange([...assetRefs, d]);
  };

  const openMenu = (next: boolean) => {
    setOpen(next);
    if (!next) setView('menu');
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Popover open={open && view === 'menu'} onOpenChange={openMenu}>
          <PopoverTrigger
            disabled={disabled}
            className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            data-testid="attach-menu-trigger"
          >
            <Paperclip className="h-3.5 w-3.5" />
            <span>Attach</span>
            <ChevronDown className="h-3 w-3" />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-40 p-1">
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => {
                setOpen(false);
                fileInputRef.current?.click();
              }}
              data-testid="attach-menu-file"
            >
              <FileUp className="h-3.5 w-3.5" />
              File
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
              onClick={() => setView('asset')}
              data-testid="attach-menu-asset"
            >
              <Boxes className="h-3.5 w-3.5" />
              Asset
            </button>
          </PopoverContent>
        </Popover>

        {/* AssetPickerPopover — opens centered on screen when
            ``view === 'asset'``. The trigger is incidental (the menu fans out
            to it programmatically), so the picker renders as a centered modal
            rather than anchored to the Attach button. */}
        <AssetPickerPopover
          trigger={<span className="sr-only" aria-hidden />}
          centered
          open={open && view === 'asset'}
          onOpenChange={(next) => {
            if (!next) {
              setOpen(false);
              setView('menu');
            }
          }}
          onPick={handlePick}
          filter={() => true}
          searchPlaceholder="Search assets…"
        />

        <input
          id={inputId}
          ref={fileInputRef}
          type="file"
          multiple
          className="sr-only"
          disabled={disabled}
          onChange={(e) => {
            onFilesPicked(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {!hideAssetList && assetRefs.length > 0 && (
        <AssetRefChips assetRefs={assetRefs} onChange={onAssetRefsChange} disabled={disabled} />
      )}
    </div>
  );
}

interface AssetRefChipsProps {
  assetRefs: AssetDescriptor[];
  onChange: (next: AssetDescriptor[]) => void;
  disabled?: boolean;
}

export function AssetRefChips({ assetRefs, onChange, disabled }: AssetRefChipsProps) {
  if (assetRefs.length === 0) return null;
  const remove = (typeid: string, source: string) =>
    onChange(assetRefs.filter((a) => !(a.typeid === typeid && a.source === source)));
  return (
    <ul className="space-y-1" data-testid="attach-menu-asset-list">
      {assetRefs.map((a) => {
        const { type } = parseTypeid(a.typeid);
        const label = displayLabelForTypeid(a.typeid);
        return (
          <li
            key={`${a.typeid}|${a.source}`}
            className="flex items-center gap-2 rounded-md border border-input bg-muted/40 px-2 py-1 text-xs"
          >
            <Boxes className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate text-foreground" title={a.typeid}>
              {label}
            </span>
            <span className="shrink-0 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              {type}
            </span>
            <button
              type="button"
              onClick={() => remove(a.typeid, a.source)}
              disabled={disabled}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive disabled:pointer-events-none"
              data-testid={`attach-menu-asset-remove-${a.typeid}`}
            >
              <X className="h-3 w-3" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
