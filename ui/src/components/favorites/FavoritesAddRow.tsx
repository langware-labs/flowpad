import { type AssetDescriptor } from '@sdk';
import { AssetPickerPopover } from '@src/components/asset-manager/AssetPickerPopover';
import { displayLabelForTypeid, parseTypeid } from '@src/components/asset-manager/asset-row-helpers';
import { showInputPrompt } from '@src/components/ui/input-prompt-modal';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { useContext } from '@src/hooks/useContext';
import { useFavorites } from '@src/hooks/use-favorites';
import { useLingui } from '@lingui/react/macro';
import { FolderPlus, Package, Star } from 'lucide-react';
import { useState, type ReactNode } from 'react';

/**
 * The "add here" row rendered as the last child of every level of the bookmarks
 * tree menu — so you build the tree while browsing it. Everything it creates
 * files into `parentId` ('' = root), the level it sits under.
 *
 * Three actions, per the menu's remit of fast navigation-adjacent building:
 *  - Folder — a nested favorite folder (the only path to one; moveToFolder
 *    refuses folders).
 *  - Asset — any registered asset, via the same picker used elsewhere. Files
 *    that are assets (markdown, whiteboards, decks…) are reachable here.
 *  - Current — whatever entity is open right now; hidden when nothing is.
 */
export function FavoritesAddRow({ parentId }: { parentId: string }) {
  const { t } = useLingui();
  const { createFolder, addFavorite } = useFavorites();
  const { activeEntity, activeEntityTypeId } = useContext();
  const [pickerOpen, setPickerOpen] = useState(false);

  const addFolder = () =>
    showInputPrompt({
      title: t`New bookmark folder`,
      placeholder: t`Folder name`,
      onConfirm: async (name) => {
        await createFolder(name, parentId);
      },
    });

  const addAsset = (d: AssetDescriptor) => {
    const { type, id } = parseTypeid(d.typeid);
    if (!type || !id) return;
    void addFavorite(
      {
        entityType: type,
        entityId: id,
        title: displayLabelForTypeid(d.typeid),
        nav: d.posix_path ? { asset_ref: d.posix_path } : undefined,
      },
      parentId,
    );
  };

  const addCurrent =
    activeEntityTypeId && activeEntity
      ? () =>
          void addFavorite(
            {
              entityType: activeEntityTypeId.type,
              entityId: activeEntityTypeId.id,
              title: activeEntity.displayName,
            },
            parentId,
          )
      : null;

  return (
    <div className="flex items-center gap-0.5 rounded-md px-1.5 py-1 text-muted-foreground">
      <AddButton icon={<FolderPlus className="h-3.5 w-3.5" />} label={t`New folder`} onClick={addFolder} />

      {/* The visible button is standalone; the picker opens as a centered modal
          from the controlled `open` state. In centered mode its own `trigger` is
          discarded, so it gets an incidental hidden one (mirrors AttachMenu). */}
      <AddButton
        icon={<Package className="h-3.5 w-3.5" />}
        label={t`Bookmark an asset`}
        onClick={() => setPickerOpen(true)}
      />
      <AssetPickerPopover
        trigger={<span className="sr-only" aria-hidden />}
        centered
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={addAsset}
        filter={() => true}
        searchPlaceholder={t`Search assets…`}
      />

      {addCurrent && (
        <AddButton icon={<Star className="h-3.5 w-3.5" />} label={t`Bookmark what's open`} onClick={addCurrent} />
      )}
    </div>
  );
}

function AddButton({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          className="flex h-6 w-6 items-center justify-center rounded-sm transition-colors hover:bg-accent hover:text-foreground"
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
