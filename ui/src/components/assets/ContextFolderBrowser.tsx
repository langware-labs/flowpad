import { FolderOpen, GitBranch, Loader2, Upload } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Project, TypeId } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import { useGitFolderStatus } from '@src/hooks/use-git-folder-status';
import { useProjectContextFolders } from '@src/hooks/use-project-context-folders';
import { notify } from '@src/notifications';
import { Button } from '@src/components/ui/button';
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
 * decorates: files the remote doesn't have yet render in amber, and a header
 * strip shows the branch plus a Push button (stage-all → commit → pull
 * --rebase → push). Push failures surface as an error notification.
 */
export function ContextFolderBrowser({ relPath, onNavigate, projectId }: ContextFolderBrowserProps) {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const { typeId } = useExplorerComputeNode();

  const projectTypeId = useMemo(() => (projectId ? new TypeId(Project.type, projectId) : null), [projectId]);
  const { data: project } = useEntity<Project>(projectTypeId, { watch: true, enabled: !!projectTypeId });
  const { contextDirInfos } = useProjectContextFolders(project);

  const rel = normalizeRel(relPath);
  const initialPath = rel ? `/${rel}` : '/';

  // The git-backed context folder containing the browsed path (if any) — the
  // repo root the status/push operations bind to.
  const gitWorkdir = useMemo(() => {
    const match = contextDirInfos.find((info) => {
      if (info.origin_kind !== 'git') return false;
      const dirRel = normalizeRel(info.path);
      return !!dirRel && (rel === dirRel || rel.startsWith(`${dirRel}/`));
    });
    return match ? `/${normalizeRel(match.path)}` : null;
  }, [contextDirInfos, rel]);

  const { status, hasUnpushed, isPathUnpushed, refresh, push, pushing } = useGitFolderStatus(
    gitWorkdir,
    typeId?.id ?? '@local',
  );

  const handlePathChange = useCallback(
    (path: string) => {
      onNavigate(DockPointer.forAssetFsFolder(path));
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

  const handlePush = useCallback(async () => {
    const result = await push();
    if (!result) return;
    if (result.ok) {
      notify.success({ title: result.nothing ? t`Nothing to push` : t`Pushed to remote` });
    } else {
      notify.error({ title: t`Push failed`, message: result.message });
    }
  }, [push, t]);

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
          {hasUnpushed && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-6 gap-1.5 px-2 text-xs"
              onClick={() => void handlePush()}
              disabled={pushing}
              data-testid="context-folder-git-push"
            >
              {pushing ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
              <Trans>Push</Trans>
            </Button>
          )}
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
