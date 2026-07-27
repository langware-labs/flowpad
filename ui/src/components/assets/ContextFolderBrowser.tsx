import { VFSPath } from '@sdk';
import { FolderOpen, GitBranch } from 'lucide-react';
import { useCallback } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useGitFolderStatus } from '@src/hooks/use-git-folder-status';
import { useContextFolderForRel } from '@src/hooks/use-context-folder-for-rel';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { useExplorerComputeNode } from '@src/components/explorer-view/useExplorerComputeNode';
import { normalizeRel } from '@src/components/browseable-tree/adapters/fsFolderRoot';
import { SimpleFileManager } from '@src/components/simple-file-manager';

interface ContextFolderBrowserProps {
  /** Compute-node-relative path (no leading slash) from the `fs/` pointer. */
  relPath: string;
  /** Host navigation (AssetsPage's `navigateAsset`) — re-stamps the active
   *  scope so folder navigation stays in the same assets/project tab. */
  onNavigate: (p: DockPointer) => void;
  /** Scoped project whose context folders this path belongs to — resolves the
   *  containing git-backed context folder for status/push decoration. */
  projectId?: string | null;
}

/**
 * ContextFolderBrowser — the Assets body for an `fs/<relPath>` pointer: a real
 * file explorer (the Explorer's `SimpleFileManager`) anchored at a project
 * context folder. URL-first: navigating into a subfolder rewrites the pointer;
 * double-clicking a file dispatches through `navigation.openFile`.
 *
 * When the browsed path lies inside a GIT-backed context folder, the browser
 * decorates: files the remote doesn't have yet render in amber, and a slim
 * header strip shows the branch + an unpushed badge. The git ACTIONS (changes
 * diff + push/notify) live on the folder's tree row — see
 * {@link ContextFolderGitBadge} — not in this pane.
 */
export function ContextFolderBrowser({ relPath, onNavigate, projectId }: ContextFolderBrowserProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  // The VFS the file manager browses. `useContextFolderForRel` resolves the same
  // compute node for its git-ops workdir, but the manager needs the TypeId itself.
  const { typeId } = useExplorerComputeNode();

  const rel = normalizeRel(relPath);
  const initialPath = rel ? `/${rel}` : '/';

  // The context folder containing the browsed path; this pane only decorates the
  // GIT-backed ones, so a local folder reads as "no workdir" exactly as before.
  const folder = useContextFolderForRel(projectId, relPath);
  const gitWorkdir = folder?.originKind === 'git' ? folder.workdir : null;

  const { status, hasUnpushed, isPathUnpushed, refresh } = useGitFolderStatus(
    gitWorkdir,
    folder?.computeNodeId ?? '@local',
  );

  const handlePathChange = useCallback(
    (vfs: string) => {
      // The file manager reports a VFS path (`compute_node-<id>/Users/…`); the
      // `fs/` grammar is compute-node-RELATIVE. Without the strip the typeid
      // rides into the pointer and comes back as part of `initialPath`, which
      // lists as an empty folder.
      onNavigate(DockPointer.forAssetFsFolder(VFSPath.parse(vfs).entitySubPath));
    },
    [onNavigate],
  );

  const handleFileSelect = useCallback(
    (path: string) => {
      // Extension dispatch (md → assets document viewer, else code editor)
      // lives in openFile — mirror the Explorer body.
      navigation.openFile(path);
    },
    [navigation],
  );

  if (!typeId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2">
        <FolderOpen className="h-12 w-12 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          <Trans>No compute node available</Trans>
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {gitWorkdir && (
        <div
          className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-1.5"
          data-testid="context-folder-git-bar"
        >
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <GitBranch className="h-3.5 w-3.5 flex-shrink-0" />
            <span className="truncate">{status?.branch ?? t`git`}</span>
            {hasUnpushed && (
              <span className="flex-shrink-0 rounded-full bg-amber-500/15 px-2 py-px text-[10px] font-medium text-amber-600 dark:text-amber-400">
                <Trans>Unpushed changes</Trans>
              </span>
            )}
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1">
        <SimpleFileManager
          typeId={typeId}
          initialPath={initialPath}
          onPathChange={handlePathChange}
          onFileSelect={handleFileSelect}
          onFsMutated={gitWorkdir ? () => void refresh() : undefined}
          isPathHighlighted={gitWorkdir ? isPathUnpushed : undefined}
          className="h-full"
        />
      </div>
    </div>
  );
}
