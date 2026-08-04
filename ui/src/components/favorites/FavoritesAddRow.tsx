import { type AssetDescriptor } from '@sdk';
import { AssetManagerPopover } from '@src/components/asset-manager/AssetManagerPopover';
import { displayLabelForTypeid, parseTypeid } from '@src/components/asset-manager/asset-row-helpers';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { useContext } from '@src/hooks/useContext';
import { useFavorites } from '@src/hooks/use-favorites';
import { useCurrentDock } from '@src/navigation/useDockNavigation';
import { getAllTabsSnapshot } from '@src/tabs/all-tabs-store';
import { useLingui } from '@lingui/react/macro';
import { FolderPlus, PackagePlus, Plus, Star } from 'lucide-react';
import { useState, type ReactNode } from 'react';

/**
 * The "add here" row rendered as the last child of every level of the bookmarks
 * tree menu — so you build the tree while browsing it. Everything it creates
 * files into `parentId` ('' = root), the level it sits under.
 *
 * Leads with a green "+" marker (not a button) so the row reads as a create
 * toolbar rather than a mystery cluster of icons. Three actions:
 *  - Folder — a nested favorite folder (the only path to one; moveToFolder
 *    refuses folders). Named INLINE, not in a modal — the menu is a fast
 *    surface; a full dialog is too heavy for a one-word name.
 *  - Asset — any registered asset, via the same picker used elsewhere. Files
 *    that are assets (markdown, whiteboards, decks…) are reachable here.
 *  - Current — bookmarks whatever is open: an entity-backed view by its typeid,
 *    anything else (web app, shell, lens) by its dock pointer (restored with
 *    openDock). Only disabled on a full-bleed surface (Home) with no tab.
 */
export function FavoritesAddRow({ parentId }: { parentId: string }) {
  const { t } = useLingui();
  const { createFolder, addFavorite } = useFavorites();
  const { activeEntity, activeEntityTypeId } = useContext();
  const currentDock = useCurrentDock();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [folderName, setFolderName] = useState<string | null>(null); // null = not naming

  const commitFolder = () => {
    const name = (folderName ?? '').trim();
    setFolderName(null);
    if (name) void createFolder(name, parentId);
  };

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

  // "Bookmark what's open" works for ANY open view. An entity-backed dock
  // (editor, task, project, session) bookmarks that entity, so it navigates back
  // relocation-proof via its typeid. Anything else (a web app, a shell, a lens)
  // bookmarks the DOCK itself — the whole pointer, restored by openDock. Only a
  // full-bleed surface like Home has no tab identity, so nothing to bookmark.
  const hasCurrent = !!(activeEntityTypeId && activeEntity) || (!activeEntity && !!currentDock);
  const addCurrent = () => {
    if (activeEntityTypeId && activeEntity) {
      void addFavorite(
        { entityType: activeEntityTypeId.type, entityId: activeEntityTypeId.id, title: activeEntity.displayName },
        parentId,
      );
      return;
    }
    if (!activeEntity && currentDock) {
      const dockPointer = currentDock.toJSON();
      // Snapshot, not the useAllTabs hook: the title is only needed at click
      // time, and subscribing would re-render this row on every tab change.
      const tab = getAllTabsSnapshot().find((t) => t.getKey() === currentDock.tabHash);
      void addFavorite(
        {
          entityType: 'dock',
          entityId: currentDock.tabHash ?? dockPointer,
          title: tab?.name || t`Bookmarked view`,
          nav: { pointer: dockPointer },
        },
        parentId,
      );
    }
  };

  return (
    <div className="flex items-center gap-0.5 rounded-md px-1.5 py-1 text-muted-foreground">
      {/* A green "+" marks the row as a create toolbar. Not a button — no
          hover, default cursor. `text-green-500` is the app's cross-theme green
          (reads on both light and dark). */}
      <Plus className="mr-1 h-4 w-4 shrink-0 cursor-default select-none text-green-500" aria-hidden />

      {folderName !== null ? (
        <input
          autoFocus
          value={folderName}
          placeholder={t`Folder name`}
          onChange={(e) => setFolderName(e.target.value)}
          onBlur={commitFolder}
          // Don't leak keys/clicks to the tree row (navigation, hover-expand).
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              commitFolder();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setFolderName(null);
            }
          }}
          aria-label={t`New folder name`}
          className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      ) : (
        <>
          <AddButton
            icon={<FolderPlus className="h-3.5 w-3.5" />}
            label={t`New folder`}
            onClick={() => setFolderName('')}
          />

          {/* The visible button is standalone; the picker opens as a centered
              modal from the controlled `open` state — which is also what lets it
              escape the enclosing bookmarks-tree menu. */}
          <AddButton
            icon={<PackagePlus className="h-3.5 w-3.5" />}
            label={t`Bookmark an asset`}
            onClick={() => setPickerOpen(true)}
          />
          <AssetManagerPopover
            centered
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onPick={addAsset}
            searchPlaceholder={t`Search assets…`}
          />

          <AddButton
            icon={<Star className="h-3.5 w-3.5" />}
            label={hasCurrent ? t`Bookmark what's open` : t`Nothing open to bookmark`}
            onClick={addCurrent}
            disabled={!hasCurrent}
          />
        </>
      )}
    </div>
  );
}

function AddButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
          className="flex h-6 w-6 items-center justify-center rounded-sm transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
