import { Project, TypeId } from '@sdk';
import { basename } from '@src/components/asset-manager/asset-row-helpers';
import { useContext as useDataContext } from '@src/hooks/useContext';
import { useEntity } from '@src/hooks/entity-hooks';
import { useProjectContextFolders } from '@src/hooks/use-project-context-folders';
import { FolderPlus, X } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

interface ContextFoldersProps {
  /** Resolve the target project from this spawn pin, else the active project. */
  spawnProjectId?: string | null;
}

/**
 * ContextFolders — the ProjectHome section for managing a project's context
 * folders (`include_dirs`): dirs auto-added to every agentic worker's --add-dir
 * set and browseable in the Explorer as their own root. Owns its own project
 * resolution, handlers, and drag state so ProjectHome stays a thin landing
 * surface. Renders nothing until a project resolves.
 */
export const ContextFolders: React.FC<ContextFoldersProps> = ({ spawnProjectId }) => {
  const { t } = useLingui();
  const dataCtx = useDataContext();

  // The explicit spawn pin (watched so include_dirs edits re-render) else the
  // active project from context.
  const spawnTypeId = useMemo(
    () => (spawnProjectId ? new TypeId(Project.type, spawnProjectId) : null),
    [spawnProjectId],
  );
  const { data: pinnedProject } = useEntity<Project>(spawnTypeId, { watch: true, enabled: !!spawnTypeId });
  const project = (pinnedProject ?? dataCtx.project) as Project | null;
  const computeNode = dataCtx.computeNode;

  const { contextDirs, addPaths, pickAndAdd: handlePickFolder, remove: handleRemove } =
    useProjectContextFolders(project);
  const [dragActive, setDragActive] = useState(false);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);
      // Absolute paths are only exposed by the Electron desktop shell (older
      // Electron `File.path`); browsers never reveal them. When absent, the
      // click-to-pick fallback (native folder dialog) is the universal path.
      const paths = Array.from(e.dataTransfer.files)
        .map((f) => (f as unknown as { path?: string }).path)
        .filter((p): p is string => !!p);
      if (paths.length) {
        void addPaths(paths);
      } else {
        void handlePickFolder();
      }
    },
    [addPaths, handlePickFolder],
  );

  if (!project) return null;

  return (
    <div className="flex w-full max-w-md flex-col gap-2" data-testid="project-context-folders">
      <span className="px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Trans>Context folders</Trans>
      </span>
      {contextDirs.length > 0 && (
        <div className="flex flex-col gap-1">
          {contextDirs.map((path) => (
            <div
              key={path}
              className="flex items-center gap-2 rounded border bg-muted/30 px-2.5 py-1.5"
              data-testid={`context-folder-row-${path}`}
            >
              <span className="min-w-0 flex-1 truncate text-xs text-foreground" title={path}>
                {basename(path) || path}
              </span>
              <button
                type="button"
                className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={() => void handleRemove(path)}
                title={t`Remove context folder`}
                data-testid={`context-folder-remove-${path}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => void handlePickFolder()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={handleDrop}
        disabled={!computeNode}
        className={`flex flex-col items-center justify-center gap-1 rounded border border-dashed px-3 py-4 text-xs transition-colors ${
          dragActive
            ? 'border-primary bg-primary/5 text-primary'
            : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
        } disabled:cursor-not-allowed disabled:opacity-50`}
        data-testid="context-folder-dropzone"
      >
        <FolderPlus className="h-4 w-4" />
        <span><Trans>Drop a folder here or click to add</Trans></span>
      </button>
    </div>
  );
};
