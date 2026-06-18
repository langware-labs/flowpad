import { FSItem, fsManager, TypeId } from '@sdk';
import { InputDialog } from '@src/components/ui/input-dialog';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useCallback, useMemo, useRef, useState } from 'react';
import { DirectoryTree } from './DirectoryTree';
import { ItemHandler } from './ItemHandler';

/**
 * Build the single root `FSItem` for an editable tree rooted at an entity-scoped
 * folder. The `/.` suffix is the root marker the tree expects (mirrors the
 * project root built in `CodeEditor`). Pure — safe to unit test.
 *
 * @param typeId  The entity the path is relative to (e.g. `compute_node-@local`).
 * @param path    Absolute folder path (leading slash is stripped by `vfs_abs_path`).
 * @param label   Display name for the root row.
 */
export function buildRootFolder(typeId: TypeId, path: string, label: string): FSItem {
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  return new FSItem({
    is_dir: true,
    vfs_abs_path: `${typeId.type}-${typeId.id}/${cleanPath}/.`,
    size: 0,
    display_name: label,
  });
}

export interface EditableFileTreeProps {
  /** Entity the tree is rooted in — used for listing and create/delete ops. */
  rootTypeId: TypeId;
  /** Absolute folder path within `rootTypeId` to show as the tree root. */
  rootPath: string;
  /** Display label for the root row. */
  rootLabel: string;
  /** Currently selected item's `vfs_abs_path` (for highlight). */
  selectedVfsPath?: string | null;
  /**
   * File-click handler. Defaults to opening the file in the editor via its
   * full `vfs_abs_path` (resolves cross-context).
   */
  onFileSelect?: (item: FSItem) => void;
  className?: string;
}

/**
 * Editable file tree — a thin composition over {@link DirectoryTree} that adds
 * create-file / create-folder actions (with input dialogs) and built-in delete.
 * Rooting at any entity + folder path makes it reusable for skills, projects,
 * etc.; the canonical listing/rendering/delete all come from `DirectoryTree`.
 */
export function EditableFileTree({
  rootTypeId,
  rootPath,
  rootLabel,
  selectedVfsPath,
  onFileSelect,
  className,
}: EditableFileTreeProps) {
  const { navigation } = useDockNavigation();

  const [showFileInput, setShowFileInput] = useState(false);
  const [showFolderInput, setShowFolderInput] = useState(false);
  const pendingActionRef = useRef<{ item: FSItem; callback: (name: string) => Promise<void> } | null>(null);

  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const handleRefresh = useCallback(() => setTreeRefreshKey((prev) => prev + 1), []);

  const rootFolders = useMemo(
    () => [buildRootFolder(rootTypeId, rootPath, rootLabel)],
    // treeRefreshKey forces a fresh root identity so the tree re-lists after writes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rootTypeId.type, rootTypeId.id, rootPath, rootLabel, treeRefreshKey],
  );

  const itemHandler = useMemo(
    () =>
      new ItemHandler({
        actions: [
          ItemHandler.createFileAction((item, e) => {
            e.stopPropagation();
            pendingActionRef.current = {
              item,
              callback: async (fileName: string) => {
                try {
                  const newPath = `${item.relativePath}/${fileName}`.replace(/\/+/g, '/');
                  await fsManager.writeFile(rootTypeId, newPath, '');
                  handleRefresh();
                  navigation.openEditor(newPath);
                } catch (error) {
                  console.error('[EditableFileTree] Failed to create file:', error);
                }
              },
            };
            setShowFileInput(true);
          }),
          ItemHandler.createFolderAction((item, e) => {
            e.stopPropagation();
            pendingActionRef.current = {
              item,
              callback: async (folderName: string) => {
                try {
                  const newPath = `${item.relativePath}/${folderName}`.replace(/\/+/g, '/');
                  await fsManager.mkdir(rootTypeId, newPath);
                  handleRefresh();
                } catch (error) {
                  console.error('[EditableFileTree] Failed to create folder:', error);
                }
              },
            };
            setShowFolderInput(true);
          }),
          ItemHandler.refreshAction((_item, e) => {
            e.stopPropagation();
            handleRefresh();
          }),
          // Delete is handled by DirectoryTree's built-in delete (enableBuiltInDelete).
        ],
      }),
    [rootTypeId, navigation, handleRefresh],
  );

  const handleFileSelect = useCallback(
    (item: FSItem | null) => {
      if (!item || item.is_dir) return;
      if (onFileSelect) {
        onFileSelect(item);
        return;
      }
      navigation.openEditor(item.vfs_abs_path);
    },
    [navigation, onFileSelect],
  );

  const confirmPending = useCallback((name: string) => {
    if (pendingActionRef.current) {
      void pendingActionRef.current.callback(name);
      pendingActionRef.current = null;
    }
  }, []);

  return (
    <>
      <DirectoryTree
        rootFolders={rootFolders}
        selectedPath={selectedVfsPath ?? null}
        itemHandler={itemHandler}
        enableBuiltInDelete
        events={{
          onSelect: handleFileSelect,
          onItemDoubleClick: handleFileSelect,
          onItemDeleted: handleRefresh,
        }}
        className={className}
      />

      <InputDialog
        open={showFileInput}
        onOpenChange={(open) => {
          setShowFileInput(open);
          if (!open) pendingActionRef.current = null;
        }}
        title="Create File"
        placeholder="Enter file name"
        onConfirm={confirmPending}
      />
      <InputDialog
        open={showFolderInput}
        onOpenChange={(open) => {
          setShowFolderInput(open);
          if (!open) pendingActionRef.current = null;
        }}
        title="Create Folder"
        placeholder="Enter folder name"
        onConfirm={confirmPending}
      />
    </>
  );
}

export default EditableFileTree;
