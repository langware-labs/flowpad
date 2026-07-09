import { dataContext, TypeId } from '@sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ScopeFilter } from '@src/lib/scope-filter';

function normalizeRel(path: string | null | undefined): string {
  if (!path) return '';
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

export interface ExplorerComputeNode {
  /** Resolved compute_node TypeId for VFS listing (preferred), else the project
   *  fs TypeId, else null when nothing is resolvable yet. */
  typeId: TypeId | null;
  /** Entity-relative anchor path (no leading slash) for a given Explorer scope:
   *  All → '' (root), User → home, Project → the project mount. */
  anchorForScope: (scope: ScopeFilter) => string;
  /** Project mount (entity-relative), or null. */
  projectRootPath: string | null;
  /** Whether a Project scope is selectable (project + resolvable mount on a
   *  compute_node — mount paths are compute-node-relative). */
  projectAvailable: boolean;
  /** Current project id (for `projectScope`), or null. */
  projectId: string | null;
  /** Current project display name (root label / tooltip), or null. */
  projectName: string | null;
  /** Project context folders (absolute canonical posix paths) — the source for
   *  the Explorer's `context_folders` grouping root. Empty when none. */
  contextDirs: string[];
}

/**
 * useExplorerComputeNode — the shared resolution of "which compute_node VFS does
 * the Explorer browse, and where does each scope anchor". Consumed by both the
 * navigator model (`useExplorerModel`) and the body (`ExplorerView`) so the tree
 * and table agree on typeId + anchors. Mirrors the precedence the Explorer body
 * has always used: active computeNode → bootstrap default → project.getComputeNode().
 */
export function useExplorerComputeNode(): ExplorerComputeNode {
  const project = dataContext.project;
  const computeNode = dataContext.computeNode;
  const bootstrapComputeNode = dataContext.bootstrapInfo?.default_compute_node;
  const paths = dataContext.bootstrapInfo?.desktop_info?.paths;
  const workspacePath = paths?.workspace;
  const homePath = paths?.home;

  const [resolvedComputeNodeTypeId, setResolvedComputeNodeTypeId] = useState<TypeId | null>(null);
  const bootstrapComputeNodeTypeId = useMemo(() => {
    if (!bootstrapComputeNode?.id || !bootstrapComputeNode.type) return null;
    return new TypeId(bootstrapComputeNode.type, bootstrapComputeNode.id);
  }, [bootstrapComputeNode?.id, bootstrapComputeNode?.type]);

  useEffect(() => {
    let cancelled = false;

    if (computeNode?.id && computeNode.type) {
      setResolvedComputeNodeTypeId(new TypeId(computeNode.type, computeNode.id));
      return;
    }
    if (bootstrapComputeNodeTypeId) {
      setResolvedComputeNodeTypeId(bootstrapComputeNodeTypeId);
      return;
    }
    if (!project) {
      setResolvedComputeNodeTypeId(null);
      return;
    }

    void project
      .getComputeNode()
      .then((node) => {
        if (cancelled) return;
        if (node?.id && node.type) {
          setResolvedComputeNodeTypeId(new TypeId(node.type, node.id));
        }
      })
      .catch(() => {
        if (!cancelled) setResolvedComputeNodeTypeId(null);
      });

    return () => {
      cancelled = true;
    };
  }, [computeNode?.id, computeNode?.type, bootstrapComputeNodeTypeId, project]);

  const projectFsTypeId = useMemo(() => {
    if (!project?.id || !project.type) return null;
    return new TypeId(project.type, project.id);
  }, [project?.id, project?.type]);

  const typeId = useMemo(
    () => resolvedComputeNodeTypeId ?? projectFsTypeId ?? null,
    [resolvedComputeNodeTypeId, projectFsTypeId],
  );

  const projectRootPath = useMemo(() => {
    if (!project) return null;
    let path = project.fs_storage_mount_path;
    if (!path && workspacePath && project.displayName) {
      path = `${workspacePath}/${project.displayName}`;
    }
    if (!path) {
      path = project.name || project.displayName || '';
    }
    return normalizeRel(path) || null;
  }, [project, workspacePath]);

  // A project mount only anchors against a compute_node (mount paths are
  // compute-node-relative); with only the project fs typeId we can't anchor it.
  const projectAvailable = useMemo(
    () => !!(resolvedComputeNodeTypeId && projectRootPath),
    [resolvedComputeNodeTypeId, projectRootPath],
  );

  const anchorForScope = useCallback(
    (scope: ScopeFilter): string => {
      switch (scope.mode) {
        case 'user':
          return normalizeRel(homePath);
        case 'project':
          return projectAvailable ? (projectRootPath ?? '') : '';
        default:
          return '';
      }
    },
    [homePath, projectAvailable, projectRootPath],
  );

  const contextDirs = useMemo<string[]>(
    () => (project?.include_dirs ?? []).filter((d): d is string => !!d),
    [project?.include_dirs],
  );

  return {
    typeId,
    anchorForScope,
    projectRootPath,
    projectAvailable,
    projectId: project?.id ?? null,
    projectName: project?.displayName ?? project?.name ?? null,
    contextDirs,
  };
}
