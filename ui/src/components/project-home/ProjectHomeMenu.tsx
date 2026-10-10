import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { openNewWorkspaceDialog } from '@src/components/workspace/workspace-switcher';
import { useActiveWorkspace } from '@src/hooks/use-workspaces';
import { useContext } from '@src/hooks/useContext';
import { errorDetail } from '@src/lib/error-message';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { Project, vfsToOsPath, Workspace, workspaceDisplayName, workspaceForPath } from '@sdk';
import { lazyAssets, LazyAsset } from '@sdk/lazy';
import { Check, LayoutGrid, Loader2, Menu, Plus } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';

/**
 * The Project Home burger menu. Its one item today is **Switch workspace**: move this
 * project into another workspace (`Project.switchWorkspace` → the compute node's
 * `switch-project-workspace` action). The backend closes everything open in the project,
 * moves the folder under the workspace's root, keeps the same project row and fully
 * indexes the new location — so the dialog warns before anything happens.
 *
 * The menu is non-modal: the item opens a dialog, and a dialog opened from a modal
 * DropdownMenu leaves `body{pointer-events:none}` behind on close (219aa5e39).
 */
export function ProjectHomeMenu({ project }: { project: Project }) {
  const { t } = useLingui();
  const { workspaces, reload } = useActiveWorkspace();
  const { computeNode, desktopInfo } = useContext();
  const { navigation } = useDockNavigation();
  const [target, setTarget] = useState<Workspace | null>(null);
  const [isMoving, setIsMoving] = useState(false);

  const current = useMemo(
    () => workspaceForPath(project.fs_storage_mount_path, workspaces),
    [project.fs_storage_mount_path, workspaces],
  );
  const osRoot = desktopInfo?.paths?.root ?? '/';
  const leaf = (project.fs_storage_mount_path ?? '').replace(/\/+$/, '').split('/').pop() || project.name || '';
  const destination = target?.root ? `${vfsToOsPath(target.root, osRoot)}/${leaf}` : '';

  const handleMove = useCallback(async () => {
    if (!target || !computeNode?.id || isMoving) return;
    setIsMoving(true);
    try {
      const moved = await Project.switchWorkspace(computeNode.id, project.id, target.is_default ? undefined : target.id);
      // The picker's cached project lists are per workspace; both the old and the new one changed.
      void lazyAssets.invalidate(LazyAsset.DiscoveredProjects);
      await reload();
      setTarget(null);
      // Alerts normally go to the footer log only; the person is waiting on THIS click, so toast them.
      if (moved.indexed) notify.success({ title: t`Project moved`, message: moved.path });
      else
        notify.warning({
          title: t`Project moved, but not indexed`,
          message: t`Rebuild the index from the assets page.`,
          forceToast: true,
        });
      // URL-first: the project is now in another workspace, so the pointer must name it —
      // the loader drops a project that is outside the URL's workspace.
      navigation.openProjectInWorkspace(project.id, target.is_default ? null : target.id);
    } catch (err) {
      notify.error({ title: t`Could not move the project`, message: errorDetail(err) || undefined, forceToast: true });
    } finally {
      setIsMoving(false);
    }
  }, [target, computeNode, isMoving, project.id, reload, navigation, t]);

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            data-testid="project-home-menu"
            aria-label={t`Project menu`}
          >
            <Menu className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-testid="project-home-switch-workspace">
              <LayoutGrid className="me-2 h-4 w-4" />
              <Trans>Switch workspace</Trans>
            </DropdownMenuSubTrigger>
            <DropdownMenuPortal>
              <DropdownMenuSubContent className="w-56">
                {workspaces.map((ws) => {
                  const active = ws.id === current?.id;
                  const testId = ws.is_default ? 'default' : ws.id;
                  return (
                    <DropdownMenuItem
                      key={ws.id}
                      disabled={active}
                      onClick={() => setTarget(ws)}
                      className="cursor-pointer"
                      data-testid={`project-home-workspace-${testId}`}
                    >
                      <Check className={`me-2 h-4 w-4 shrink-0 ${active ? '' : 'invisible'}`} />
                      <span className="truncate">{workspaceDisplayName(ws)}</span>
                    </DropdownMenuItem>
                  );
                })}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={openNewWorkspaceDialog}
                  className="cursor-pointer"
                  data-testid="project-home-workspace-new"
                >
                  <Plus className="me-2 h-4 w-4" />
                  <Trans>New workspace…</Trans>
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuPortal>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={target !== null} onOpenChange={(open) => !open && !isMoving && setTarget(null)}>
        <DialogContent className="sm:max-w-md" data-testid="switch-workspace-dialog">
          <DialogHeader>
            <DialogTitle>
              <Trans>
                Move {project.displayName ?? project.name} to {workspaceDisplayName(target)}?
              </Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                Every open tab and running process of this project will be closed. The project folder is then
                moved and indexed again at its new location.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          {destination && (
            <div
              className="truncate rounded-md border bg-muted/40 px-3 py-2 text-left font-mono text-xs text-muted-foreground [direction:rtl]"
              title={destination}
              data-testid="switch-workspace-destination"
            >
              <bdi dir="ltr">{destination}</bdi>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)} disabled={isMoving}>
              <Trans>Cancel</Trans>
            </Button>
            <Button onClick={() => void handleMove()} disabled={isMoving || !computeNode} data-testid="switch-workspace-confirm">
              {isMoving && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
              <Trans>Close everything and move</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
