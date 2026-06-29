import { dataContext, TypeId, VFSPath } from '@sdk';
import { useViewerStore } from '@src/hooks/flow-hooks/useViewerStore';
import { FolderOpen } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { FilterDefinition, FilterName, SimpleFileManager } from '../simple-file-manager';
import './explorer-view.css';

function normalizeRelativePath(path: string | null | undefined): string {
  if (!path) return '';
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function joinRelativePath(base: string | null | undefined, sub: string | null | undefined): string {
  const normalizedBase = normalizeRelativePath(base);
  const normalizedSub = normalizeRelativePath(sub);
  if (!normalizedBase) return normalizedSub;
  if (!normalizedSub) return normalizedBase;
  return `${normalizedBase}/${normalizedSub}`;
}

export interface ExplorerViewProps {
  /** Filter definitions for file filters component */
  filterDefinitions?: FilterDefinition[];
  /** Currently enabled filter names */
  enabledFilters?: FilterName[];
  /** Callback when enabled filters change */
  onEnabledFiltersChange?: (enabledFilters: FilterName[]) => void;
  /** File selection handler - called when user double-clicks a file */
  onFileSelect: (path: string) => void;
  /** Optional path change handler - called when user navigates to a folder */
  onPathChange?: (path: string) => void;
  /** Compact mode - hides size/modified columns and table header */
  compact?: boolean;
  /** Default path to use when no target path is available from context */
  defaultPath?: string;
}

export function ExplorerView({
  filterDefinitions,
  enabledFilters,
  onEnabledFiltersChange,
  onFileSelect,
  onPathChange,
  compact = false,
  defaultPath,
}: ExplorerViewProps) {
  const project = dataContext.project;
  const computeNode = dataContext.computeNode;
  const bootstrapComputeNode = dataContext.bootstrapInfo?.default_compute_node;
  const workspacePath = dataContext.bootstrapInfo?.desktop_info?.paths?.workspace;
  const { currentContext } = useViewerStore();
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
        if (!cancelled) {
          setResolvedComputeNodeTypeId(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [computeNode?.id, computeNode?.type, bootstrapComputeNodeTypeId, project]);

  const projectRootPath = useMemo(() => {
    if (!project) return null;

    let path = project.fs_storage_mount_path;
    if (!path && workspacePath && project.displayName) {
      path = `${workspacePath}/${project.displayName}`;
    }
    if (!path) {
      path = project.name || project.displayName || '';
    }

    const normalizedPath = normalizeRelativePath(path);
    return normalizedPath || null;
  }, [project, workspacePath]);

  const projectFsTypeId = useMemo(() => {
    if (!project?.id || !project.type) return null;
    return new TypeId(project.type, project.id);
  }, [project?.id, project?.type]);

  const defaultTypeId = useMemo(
    () => resolvedComputeNodeTypeId ?? projectFsTypeId ?? null,
    [resolvedComputeNodeTypeId, projectFsTypeId],
  );

  // Get target path from URL context
  // If it's a file path, use its directory instead (to avoid browse errors)
  const targetPath = currentContext?.codeRef?.path;
  const vfsPath = useMemo(() => VFSPath.parse(targetPath), [targetPath]);
  const resolvedTypeId = useMemo(() => {
    if (vfsPath.typeId?.type === 'compute_node' && resolvedComputeNodeTypeId) {
      // URL/context may contain a stale compute node ID from a previous session.
      // Always use the active compute node to avoid browse failures on old IDs.
      return resolvedComputeNodeTypeId;
    }
    if (vfsPath.typeId?.type === 'project' && resolvedComputeNodeTypeId) {
      return resolvedComputeNodeTypeId;
    }
    return vfsPath.typeId ?? defaultTypeId;
  }, [defaultTypeId, resolvedComputeNodeTypeId, vfsPath.typeId]);
  const isComputeNodeContext = useMemo(() => {
    if (!resolvedTypeId) return false;
    if (resolvedComputeNodeTypeId && resolvedTypeId.equals(resolvedComputeNodeTypeId)) return true;
    return resolvedTypeId.type === 'compute_node';
  }, [resolvedComputeNodeTypeId, resolvedTypeId]);

  const normalizedContextPath = useMemo(() => {
    if (!targetPath) return null;

    if (vfsPath.typeId) {
      if (vfsPath.typeId.type === 'project' && resolvedTypeId?.type === 'compute_node') {
        const mapped = joinRelativePath(projectRootPath, vfsPath.entitySubPath);
        return mapped ? `/${mapped}` : '/';
      }
      const relativeSubPath = normalizeRelativePath(vfsPath.entitySubPath);
      return relativeSubPath ? `/${relativeSubPath}` : '/';
    }

    const normalizedTargetPath = targetPath.replace(/\\/g, '/').replace(/\/+/g, '/');
    return normalizedTargetPath.startsWith('/') ? normalizedTargetPath : `/${normalizedTargetPath}`;
  }, [targetPath, vfsPath.typeId, vfsPath.entitySubPath, resolvedTypeId?.type, projectRootPath]);

  const computedDefaultPath = useMemo(() => {
    if (defaultPath) return defaultPath;
    if (isComputeNodeContext && projectRootPath) {
      return `/${projectRootPath}`;
    }
    return '/';
  }, [defaultPath, isComputeNodeContext, projectRootPath]);

  const canShowProjectRoot = useMemo(() => {
    return Boolean(isComputeNodeContext && projectRootPath);
  }, [isComputeNodeContext, projectRootPath]);

  const initialPath = useMemo(() => {
    // First check if we have a targetPath from the URL context
    if (normalizedContextPath) {
      const basePath = normalizedContextPath;
      // Ensure path starts with / for consistency
      const normalizedPath = basePath.startsWith('/') ? basePath : `/${basePath}`;
      // Check if path looks like a file (has extension after last /)
      const lastSlashIndex = normalizedPath.lastIndexOf('/');
      const fileName = lastSlashIndex >= 0 ? normalizedPath.substring(lastSlashIndex + 1) : normalizedPath;
      if (fileName.includes('.')) {
        // It's a file - use its directory
        return lastSlashIndex > 0 ? normalizedPath.substring(0, lastSlashIndex) : computedDefaultPath;
      }
      return normalizedPath;
    }
    // No targetPath - use defaultPath or root
    return computedDefaultPath;
  }, [normalizedContextPath, computedDefaultPath]);

  if (!project || !resolvedTypeId) {
    return (
      <div className="explorer-view-empty">
        <FolderOpen className="h-12 w-12 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground"><Trans>No project context available</Trans></p>
      </div>
    );
  }

  return (
    <div className="explorer-view-container">
      <SimpleFileManager
        typeId={resolvedTypeId}
        initialPath={initialPath}
        onPathChange={onPathChange}
        onFileSelect={onFileSelect}
        filterDefinitions={filterDefinitions}
        enabledFilters={enabledFilters}
        onEnabledFiltersChange={onEnabledFiltersChange}
        compact={compact}
        className="h-full"
        projectPath={canShowProjectRoot ? projectRootPath : null}
      />
    </div>
  );
}
