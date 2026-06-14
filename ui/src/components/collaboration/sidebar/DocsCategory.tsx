import { ChevronRight, FileText, Folder } from 'lucide-react';
import { useMemo, useEffect, useState } from 'react';
import { apiClient, dataManager, Markdown, Project, TypeId } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import { useQuery } from '@tanstack/react-query';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { DockPointer } from '@src/navigation/DockPointer';
import type { RoomTab } from '../RoomTabs';

interface Props {
  projectId: string | null;
  /** When provided, doc clicks add a tab to RoomTabs in the room view. */
  onOpenTab?: (tab: RoomTab) => void;
}

/** Tree node derived from the flat doc rows. Folders are synthesized from
 *  segments of `parent_path` relative to the project mount. */
interface DocTreeNode {
  name: string;
  /** Children folders, keyed by name. */
  folders: Map<string, DocTreeNode>;
  /** Files directly in this folder. */
  files: Markdown[];
}

// Direct fetch (with `include_system=true`) instead of useEntitiesQuery,
// because the QueryRequest path doesn't expose the system-records flag the
// graph route honors. Mirrors SkillsCategory.tsx.

function newNode(name: string): DocTreeNode {
  return { name, folders: new Map(), files: [] };
}

/**
 * Group flat rows into a folder hierarchy. Each row's `parent_path` is made
 * relative to `mountAbsPrefix` (e.g. `<mount>`); the resulting path segments
 * become folder nodes ("/.claude/docs", ".claude/docs/sub", etc.).
 */
function buildTree(rows: Markdown[], mountAbsPrefix: string): DocTreeNode {
  const root = newNode('');
  for (const r of rows) {
    const parent = (r.parent_path ?? '').replace(/\/+$/, '');
    if (!parent.startsWith(mountAbsPrefix)) continue;
    const rel = parent.slice(mountAbsPrefix.length).replace(/^\/+/, '');
    const segs = rel ? rel.split('/') : [];
    let node = root;
    for (const seg of segs) {
      let child = node.folders.get(seg);
      if (!child) {
        child = newNode(seg);
        node.folders.set(seg, child);
      }
      node = child;
    }
    node.files.push(r);
  }
  return root;
}

function FolderRow({
  node,
  depth,
  onOpen,
}: {
  node: DocTreeNode;
  depth: number;
  onOpen: (d: Markdown) => void;
}) {
  // Auto-expand:
  //  - root + first level (depth < 2): preserves the existing UX.
  //  - "thin chains": a folder whose only child is another folder. Lets
  //    ``.claude/docs`` unfold so the system docs surface immediately.
  //  - "leaf-with-few-files": a folder with no subfolders and ≤ 3 files.
  //    Lets the final folder in a ``.claude/docs/`` chain show its file
  //    rows without the user clicking through.
  const isThinChain = node.folders.size === 1 && node.files.length === 0;
  const isShallowLeaf = node.folders.size === 0 && node.files.length > 0 && node.files.length <= 3;
  const [open, setOpen] = useState<boolean>(depth < 2 || isThinChain || isShallowLeaf);
  const hasChildren = node.folders.size > 0 || node.files.length > 0;
  const indent = { paddingLeft: `${depth * 12}px` };

  return (
    <>
      {node.name !== '' && (
        <div
          style={indent}
          onClick={() => setOpen((v) => !v)}
          className="flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ChevronRight
            className={`h-3 w-3 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          />
          <Folder className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate">{node.name}</span>
        </div>
      )}
      {open && hasChildren && (
        <>
          {[...node.folders.values()]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((child) => (
              <FolderRow
                key={child.name}
                node={child}
                depth={depth + 1}
                onOpen={onOpen}
              />
            ))}
          {[...node.files]
            .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
            .map((d) => (
              <div
                key={d.id}
                style={{ paddingLeft: `${(depth + 1) * 12}px` }}
                onClick={() => onOpen(d)}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <FileText className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">
                  {d.displayName}
                </span>
              </div>
            ))}
        </>
      )}
    </>
  );
}

/**
 * Docs category — lists Markdown entities scoped to the current project,
 * filtered by `project_id` (stamped onto the record by the indexer when the
 * scan was triggered via `POST /fs-records/index?project_id=...`). Rendered
 * as a folder hierarchy derived from each row's `parent_path` relative to
 * the project's `fs_storage_mount_path`.
 */
export function DocsCategory({ projectId, onOpenTab }: Props) {
  const { navigation } = useDockNavigation();

  const projectTypeId = useMemo(
    () => (projectId ? new TypeId(Project.type, projectId) : null),
    [projectId],
  );
  const { data: project } = useEntity<Project>(projectTypeId);
  const isSystemProject = !!project?.system;

  const [includeSystem, setIncludeSystem] = useState<boolean>(isSystemProject);
  useEffect(() => {
    setIncludeSystem(isSystemProject);
  }, [isSystemProject]);

  const { data: rows = [], isLoading } = useQuery<Markdown[]>({
    queryKey: ['docs-include-system'],
    queryFn: async () => {
      const records = await apiClient.get<Partial<Markdown>[]>(
        '/graph/markdown?include_system=true&limit=5000',
      );
      // Hydrate via the cache-deduping path; `new Markdown(row)` self-registers
      // in the dataManager store and collides on every refetch (see use-entity-by-path).
      return (records ?? []).map((row) => dataManager.updateEntityFromJson<Markdown>(row));
    },
    staleTime: 30_000,
  });

  const filtered = useMemo(() => {
    if (!projectId) return [];
    return rows.filter((r) => {
      if (r.project_id !== projectId) return false;
      if (!includeSystem && r.scope === 'system') return false;
      return true;
    });
  }, [rows, projectId, includeSystem]);

  const tree = useMemo(() => {
    const mount = project?.fs_storage_mount_path?.replace(/\/+$/, '') ?? '';
    if (!mount) return newNode('');
    return buildTree(filtered, mount);
  }, [filtered, project?.fs_storage_mount_path]);

  const openDoc = (d: Markdown) => {
    if (!d.asset_ref) return;
    if (onOpenTab) {
      onOpenTab({
        key: `markdown:${d.id}`,
        type: 'markdown',
        title: d.displayName,
        asset_ref: d.asset_ref,
      });
    } else {
      navigation.openDock(DockPointer.forAssetEditor('markdown', d.asset_ref));
    }
  };

  if (!projectId) {
    return <div className="px-2 py-1.5 text-xs italic text-muted-foreground">No project linked</div>;
  }

  const showToggleRow = !isSystemProject;
  const isEmpty = filtered.length === 0;

  return (
    <div className="flex flex-col gap-0.5">
      {showToggleRow && (
        <label
          className="flex cursor-pointer items-center gap-1 px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
          title="Show docs from SDK-shipped system projects"
        >
          <input
            type="checkbox"
            className="h-3 w-3 rounded border-input"
            checked={includeSystem}
            onChange={(e) => setIncludeSystem(e.target.checked)}
          />
          Show system
        </label>
      )}

      {isLoading && isEmpty ? (
        <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>
      ) : isEmpty ? (
        <div className="px-2 py-1.5 text-xs italic text-muted-foreground">No docs yet</div>
      ) : (
        <FolderRow node={tree} depth={0} onOpen={openDoc} />
      )}
    </div>
  );
}
