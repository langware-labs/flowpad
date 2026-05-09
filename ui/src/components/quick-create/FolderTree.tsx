import { FSItem, type Project } from '@sdk';
import { DirectoryTree } from '@src/components/directory-tree/DirectoryTree';
import { ItemHandler } from '@src/components/directory-tree/ItemHandler';
import { useMemo } from 'react';

interface FolderTreeProps {
  project: Project | null;
  /** VFS-relative default folder (e.g. `.claude/skills`). Auto-expanded + selected. */
  defaultFolder?: string;
  /** Currently selected VFS sub-path (relative to the project mount). */
  value: string | null;
  onChange: (vfsPath: string) => void;
}

/**
 * Compact directory tree rooted at the project's `.claude/` folder, used inside
 * quick-create dialogs to let users choose the destination folder.
 *
 * Reuses the shared `DirectoryTree` component; only selection is wired — no
 * rename/create/delete affordances for this picker.
 */
export function FolderTree({ project, defaultFolder, value, onChange }: FolderTreeProps) {
  const rootFolders = useMemo<FSItem[]>(() => {
    if (!project?.typeId) return [];
    const base = `${project.typeId.type}-${project.typeId.id}`;
    const rootVfs = `${base}/.claude`;
    return [new FSItem({ vfs_abs_path: rootVfs, is_dir: true, size: 0 })];
  }, [project?.typeId]);

  const selectedPath = useMemo(() => {
    if (!project?.typeId) return null;
    const base = `${project.typeId.type}-${project.typeId.id}`;
    const rel = value ?? defaultFolder ?? '.claude';
    const trimmed = rel.replace(/^\/+/, '').replace(/\/+$/, '');
    return `${base}/${trimmed}`;
  }, [project?.typeId, value, defaultFolder]);

  const handler = useMemo(
    () =>
      new ItemHandler({
        isSelectable: (item) => item.is_dir,
      }),
    [],
  );

  if (!project) {
    return (
      <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
        Select a project to choose a folder.
      </div>
    );
  }

  return (
    <div className="h-56 overflow-hidden rounded-md border border-border">
      <DirectoryTree
        rootFolders={rootFolders}
        selectedPath={selectedPath}
        itemHandler={handler}
        enableBuiltInDelete={false}
        disableAutoSelect
        events={{
          onSelect: (item) => {
            if (!item.is_dir) return;
            const base = `${project.typeId.type}-${project.typeId.id}/`;
            const rel = item.vfs_abs_path.startsWith(base)
              ? item.vfs_abs_path.slice(base.length)
              : item.vfs_abs_path;
            onChange(rel);
          },
        }}
      />
    </div>
  );
}
