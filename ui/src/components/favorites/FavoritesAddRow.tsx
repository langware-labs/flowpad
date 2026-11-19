import { type AssetDescriptor } from '@sdk';
import { AssetManagerPopover } from '@src/components/asset-manager/AssetManagerPopover';
import { displayLabelForDescriptor, parseTypeid } from '@src/components/asset-manager/asset-row-helpers';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { useContext } from '@src/hooks/useContext';
import { useFavorites } from '@src/hooks/use-favorites';
import { useCurrentDock } from '@src/navigation/useDockNavigation';
import { favoriteTargetForDock } from '@src/components/favorites/favorite-target';
import { Trans, useLingui } from '@lingui/react/macro';
import { FolderPlus, PackagePlus, Star } from 'lucide-react';
import { useState, type ReactNode } from 'react';

/**
 * The "add here" row that leads a level of the bookmarks menu that can take a
 * row — so you build the tree while browsing it. Everything it creates files
 * into `parentId` ('' = the open project's own level).
 *
 *  - Bookmark this page — the labeled, primary action: bookmarks whatever is
 *    open. An entity-backed view by its typeid, anything else (web app, shell,
 *    lens) by its dock pointer (restored with openDock). Only disabled on a
 *    full-bleed surface (Home) with no tab.
 *  - Folder — a nested favorite folder (the only path to one; moveToFolder
 *    refuses folders). Named INLINE, not in a modal — the menu is a fast
 *    surface; a full dialog is too heavy for a one-word name.
 *  - Asset — any registered asset, via the same picker used elsewhere. Files
 *    that are assets (markdown, charts, decks…) are reachable here.
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
        title: displayLabelForDescriptor(d),
        nav: d.posix_path ? { asset_ref: d.posix_path } : undefined,
      },
      parentId,
    );
  };

  // "Bookmark what's open" — the entity-vs-dock rule lives in
  // `favoriteTargetForDock` so this row and the navigation bar's star can't
  // disagree about what a given screen bookmarks AS. Resolved at click time, not
  // subscribed, so a tab change doesn't re-render the whole menu.
  const currentTarget = () =>
    favoriteTargetForDock(
      currentDock,
      activeEntityTypeId && activeEntity ? { typeId: activeEntityTypeId, entity: activeEntity } : null,
      t`Bookmarked view`,
    );
  const hasCurrent = !!(activeEntityTypeId && activeEntity) || (!activeEntity && !!currentDock);
  const addCurrent = () => {
    const ref = currentTarget();
    if (ref) void addFavorite(ref, parentId);
  };

  return (
    <div className="flex items-center gap-0.5 rounded-md px-1.5 py-1 text-muted-foreground">
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
          <button
            type="button"
            onClick={addCurrent}
            disabled={!hasCurrent}
            title={hasCurrent ? undefined : t`Nothing open to bookmark`}
            className="flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
          >
            <Star className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="truncate">
              <Trans>Bookmark this page</Trans>
            </span>
          </button>

          <AddButton
            icon={<FolderPlus className="h-3.5 w-3.5" />}
            label={t`New folder`}
            onClick={() => setFolderName('')}
          />

          {/* The visible button is standalone; the picker opens as a centered
              modal from the controlled `open` state — which is also what lets it
              escape the enclosing bookmarks menu. */}
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
        </>
      )}
    </div>
  );
}

function AddButton({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
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
