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
import { Input } from '@src/components/ui/input';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@src/components/ui/tooltip';
import { useActiveWorkspace } from '@src/hooks/use-workspaces';
import { useContext } from '@src/hooks/useContext';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { notify } from '@src/notifications';
import { errorDetail } from '@src/lib/error-message';
import { fsManager, vfsToOsPath, Workspace, workspaceDisplayName } from '@sdk';
import { Check, ChevronDown, Copy, FolderOpen, LayoutGrid, Loader2, Plus } from 'lucide-react';
import { type MouseEvent, useCallback, useEffect, useState } from 'react';
import { create } from 'zustand';
import { Trans, useLingui } from '@lingui/react/macro';

/**
 * The workspace switcher — a workspace is a folder of related projects
 * (`flow_sdk/builtin/workspace.py`). Two placements share one model:
 *
 * - `WorkspaceSubmenu` — the account menu's banner (always shown: "Flowpad ▾"
 *   plus "New workspace…" is how the feature is found);
 * - `WorkspacePickerRow` — the top of the project picker, only once a second
 *   workspace exists.
 *
 * Choosing a workspace only navigates (`navigation.openWorkspace`); the active one
 * is read back from the URL, never written into context.
 */

const useNewWorkspaceDialog = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

export function openNewWorkspaceDialog(): void {
  useNewWorkspaceDialog.getState().setOpen(true);
}

function useSwitchWorkspace() {
  const { navigation } = useDockNavigation();
  return useCallback(
    (workspace: Workspace) => navigation.openWorkspace(workspace.is_default ? null : workspace.id),
    [navigation],
  );
}

/** The account-menu banner pill + its submenu. Render inside a `DropdownMenuContent`. */
export function WorkspaceSubmenu() {
  const { workspaces, workspace } = useActiveWorkspace();
  const name = workspaceDisplayName(workspace);
  const switchTo = useSwitchWorkspace();
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        className="h-7 gap-1.5 rounded-full bg-background/70 px-2.5 text-xs font-medium shadow-sm backdrop-blur"
        data-testid="workspace-switcher"
      >
        <LayoutGrid className="h-3.5 w-3.5" />
        <span className="max-w-40 truncate" data-testid="workspace-switcher-name">
          {name}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuPortal>
        <DropdownMenuSubContent className="w-56">
          <WorkspaceItems workspaces={workspaces} activeId={workspace?.id} onSelect={switchTo} />
        </DropdownMenuSubContent>
      </DropdownMenuPortal>
    </DropdownMenuSub>
  );
}

/** The project picker's top row — shown only when more than one workspace exists. */
export function WorkspacePickerRow() {
  const { workspaces, workspace, hasMany } = useActiveWorkspace();
  const name = workspaceDisplayName(workspace);
  const switchTo = useSwitchWorkspace();
  if (!hasMany) return null;
  return (
    <div className="flex items-center gap-2 px-2 pb-1 pt-1.5" data-testid="project-picker-workspace-row">
      <span className="text-xs text-muted-foreground">
        <Trans>Workspace</Trans>
      </span>
      {/* Non-modal for the same reason as the account menu: "New workspace…" opens a dialog. */}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 text-sm font-medium hover:bg-accent"
            data-testid="project-picker-workspace"
          >
            <LayoutGrid className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{name}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <WorkspaceItems workspaces={workspaces} activeId={workspace?.id} onSelect={switchTo} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function WorkspaceItems({
  workspaces,
  activeId,
  onSelect,
}: {
  workspaces: Workspace[];
  activeId: string | undefined;
  onSelect: (workspace: Workspace) => void;
}) {
  return (
    <TooltipProvider delayDuration={300}>
      {workspaces.map((ws) => (
        <WorkspaceItem key={ws.id} workspace={ws} active={ws.id === activeId} onSelect={onSelect} />
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={openNewWorkspaceDialog} className="cursor-pointer" data-testid="workspace-new">
        <Plus className="me-2 h-4 w-4" />
        <Trans>New workspace…</Trans>
      </DropdownMenuItem>
    </TooltipProvider>
  );
}

/**
 * One workspace in the list: its name, and — because a workspace IS a folder — where that
 * folder is. Hovering explains the workspace and shows the full path; the row's two buttons
 * copy the path (to paste elsewhere) and open the folder in the OS file manager.
 */
function WorkspaceItem({
  workspace,
  active,
  onSelect,
}: {
  workspace: Workspace;
  active: boolean;
  onSelect: (workspace: Workspace) => void;
}) {
  const { t } = useLingui();
  const { computeNode, desktopInfo } = useContext();
  const name = workspaceDisplayName(workspace);
  // `root` is VFS-relative (what `fsManager` takes); the OS form is what a person pastes.
  const root = workspace.root ?? '';
  const path = root ? vfsToOsPath(root, desktopInfo?.paths?.root ?? '/') : '';
  const testId = workspace.is_default ? 'default' : workspace.id;

  // The buttons sit inside the menu item: stop the click there, or it also switches workspace.
  const act = (run: () => Promise<void>) => (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void run();
  };
  const copyPath = act(async () => {
    try {
      await navigator.clipboard.writeText(path);
      notify.success({ title: t`Workspace folder path copied`, message: path });
    } catch {
      notify.error({ title: t`Could not copy the path`, message: path });
    }
  });
  const openFolder = act(async () => {
    if (!computeNode?.typeId) return;
    try {
      await fsManager.open(computeNode.typeId, root);
    } catch {
      notify.error({ title: t`Could not open the workspace folder`, message: path });
    }
  });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuItem
          onClick={() => onSelect(workspace)}
          className="cursor-pointer gap-1"
          data-testid={`workspace-item-${testId}`}
        >
          <Check className={`me-1 h-4 w-4 shrink-0 ${active ? '' : 'invisible'}`} />
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {path && (
            <>
              <button
                type="button"
                onClick={copyPath}
                aria-label={t`Copy the folder path of ${name}`}
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                data-testid={`workspace-copy-path-${testId}`}
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={openFolder}
                aria-label={t`Open the folder of ${name}`}
                className="shrink-0 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                data-testid={`workspace-open-folder-${testId}`}
              >
                <FolderOpen className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </DropdownMenuItem>
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className="max-w-sm" data-testid={`workspace-tooltip-${testId}`}>
        <div className="font-medium">{name}</div>
        <div className="text-xs opacity-80">
          {workspace.is_default ? (
            <Trans>The default workspace. Every project outside another workspace's folder belongs here.</Trans>
          ) : (
            <Trans>A folder of related projects. New projects and clones are created inside it.</Trans>
          )}
        </div>
        {path && (
          <div className="mt-1 select-all break-all font-mono text-xs" data-testid={`workspace-path-${testId}`}>
            {path}
          </div>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

/** The one "New workspace" dialog, mounted once (TopNavBar); opened from either placement. */
export function NewWorkspaceDialogHost() {
  const { t } = useLingui();
  const { open, setOpen } = useNewWorkspaceDialog();
  const { computeNode, desktopInfo } = useContext();
  const { reload } = useActiveWorkspace();
  const { navigation } = useDockNavigation();
  const [name, setName] = useState('');
  // Only a folder the user PICKED is sent; otherwise the backend places the workspace
  // at `<workspaces_home>/<name>` itself, the same on every OS.
  const [picked, setPicked] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setPicked(null);
      setIsSubmitting(false);
    }
  }, [open]);

  const paths = desktopInfo?.paths;
  const osRoot = paths?.root ?? '/';
  const home = paths?.workspaces_home;
  const defaultFolder = home ? vfsToOsPath(`${home}/${name.trim() || t`<name>`}`, osRoot) : '';
  const folder = picked ?? defaultFolder;
  const canCreate = !!name.trim() && !isSubmitting;

  const handleBrowse = useCallback(async () => {
    if (!computeNode) return;
    try {
      const path = await computeNode.openPathDialog(home ? vfsToOsPath(home, osRoot) : undefined);
      if (path) setPicked(path);
    } catch {
      notify.error({ title: t`Failed to open folder picker` });
    }
  }, [computeNode, home, osRoot, t]);

  const handleCreate = useCallback(async () => {
    if (!canCreate) return;
    setIsSubmitting(true);
    try {
      const workspace = new Workspace({ name: name.trim(), ...(picked ? { root_path: picked } : {}) });
      const saved = await workspace.save();
      await reload();
      setOpen(false);
      navigation.openWorkspace(saved.id ?? workspace.id ?? null);
    } catch (err) {
      notify.error({ title: t`Could not create the workspace`, message: errorDetail(err) || undefined });
    } finally {
      setIsSubmitting(false);
    }
  }, [canCreate, name, picked, reload, setOpen, navigation, t]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-md" data-testid="new-workspace-dialog">
        <DialogHeader>
          <DialogTitle>
            <Trans>New workspace</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>A workspace is a folder of related projects. It starts empty.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            placeholder={t`Workspace name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            data-testid="new-workspace-name"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canCreate) void handleCreate();
            }}
          />
          <div className="flex items-center gap-2">
            {/* Truncated at the START: the folder's own name is the part worth seeing. */}
            <div
              className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-3 py-2 text-left font-mono text-xs text-muted-foreground [direction:rtl]"
              title={folder}
              data-testid="new-workspace-folder"
            >
              <bdi dir="ltr">{folder}</bdi>
            </div>
            <Button
              variant="outline"
              size="icon"
              onClick={() => void handleBrowse()}
              title={t`Choose folder…`}
              type="button"
              disabled={!computeNode}
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isSubmitting}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={() => void handleCreate()} disabled={!canCreate} data-testid="new-workspace-create">
            {isSubmitting && <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" />}
            <Trans>Create</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
