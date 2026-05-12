import { useId, useRef } from 'react';
import { Paperclip, FileUp, Boxes, X, ChevronDown } from 'lucide-react';
import type { AssetDescriptor } from '@sdk';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
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
}

export function AttachMenu({
  assetRefs,
  onAssetRefsChange,
  onFilesPicked,
  disabled,
}: AttachMenuProps) {
  const inputId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Hidden trigger that AssetPickerPopover anchors to; we click it
  // programmatically from the dropdown's "Asset" item.
  const assetTriggerRef = useRef<HTMLButtonElement | null>(null);

  const handlePick = (d: AssetDescriptor) => {
    if (assetRefs.some((a) => a.typeid === d.typeid && a.source === d.source)) return;
    onAssetRefsChange([...assetRefs, d]);
  };

  const removeAsset = (typeid: string, source: string) => {
    onAssetRefsChange(assetRefs.filter((a) => !(a.typeid === typeid && a.source === source)));
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={disabled}
            className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-xs text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            data-testid="attach-menu-trigger"
          >
            <Paperclip className="h-3.5 w-3.5" />
            <span>Attach</span>
            <ChevronDown className="h-3 w-3" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[10rem]">
            <DropdownMenuItem
              onSelect={() => fileInputRef.current?.click()}
              data-testid="attach-menu-file"
            >
              <FileUp className="mr-2 h-3.5 w-3.5" />
              File
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                // Defer past the dropdown's close animation so the popover
                // anchor element has its layout settled.
                setTimeout(() => assetTriggerRef.current?.click(), 0);
              }}
              data-testid="attach-menu-asset"
            >
              <Boxes className="mr-2 h-3.5 w-3.5" />
              Asset
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Hidden anchor for the asset popover. Pickable assets: all (no filter). */}
        <AssetPickerPopover
          trigger={
            <button
              ref={assetTriggerRef}
              type="button"
              aria-hidden
              tabIndex={-1}
              className="sr-only"
              data-testid="attach-menu-asset-anchor"
            />
          }
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

      {assetRefs.length > 0 && (
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
                  onClick={() => removeAsset(a.typeid, a.source)}
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
      )}
    </div>
  );
}
