import { ContextEntitiesEnum, dataContext } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { Trans, useLingui } from '@lingui/react/macro';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { ClaudeIcon } from '@src/components/icons/ClaudeIcon';
import { CodexIcon } from '@src/components/icons/CodexIcon';
import { CopilotIcon } from '@src/components/icons/CopilotIcon';
import { iconForType } from '@src/components/graph-view/icons/iconRegistry';
import {
  NewProjectDialog,
  NewProjectFromGitDialog,
  ProjectSelectorModal,
  useEnsureProject,
  useGitCloneDialogSubmit,
} from '@src/components/project-selector';
import { projectEntitiesToSelectorItems } from '@src/components/project-selector/project-items';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@src/components/ui/dropdown-menu';
import { useAssetTypes } from '@src/hooks/use-asset-types';
import { useProjects } from '@src/hooks/use-projects';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { openNewChat } from '@src/navigation/open-new-chat';
import { openCapabilitiesForWorker } from '@src/navigation/open-capabilities';
import { FolderOpen, FolderPlus, GitBranch } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useMemo, useState } from 'react';
import { QUICK_CREATE_REGISTRY } from './registry';

interface QuickCreateMenuProps {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (type: string) => void;
}

/**
 * Dropdown menu listing creatable entity types. The list is the intersection of
 * the UI quick-create registry and the server-reported `creatable` types (so the
 * server stays authoritative for what's actually supported).
 *
 * Top section: a chip showing the active project; click opens ProjectSelectorModal.
 */
export function QuickCreateMenu({ children, open, onOpenChange, onPick }: QuickCreateMenuProps) {
  const { t } = useLingui();
  const { types: serverTypes } = useAssetTypes();
  const { project: currentProject } = useProject();
  const { projects, isLoading: isLoadingProjects } = useProjects();
  const { computeNode } = useAgentContext();
  const { navigation } = useDockNavigation();
  const ensureProject = useEnsureProject();
  const handleCreateGitProject = useGitCloneDialogSubmit(computeNode?.id);
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [newLocalProjectOpen, setNewLocalProjectOpen] = useState(false);
  const [newGitProjectOpen, setNewGitProjectOpen] = useState(false);

  const defaultWorkspacePath = useMemo(() => dataContext.bootstrapInfo?.desktop_info?.paths?.workspace || '', []);

  const handlePickFolder = useCallback(async (): Promise<string | null> => {
    if (!computeNode) {
      notify.error({ title: t`No compute node available` });
      return null;
    }
    try {
      return await computeNode.openPathDialog();
    } catch (err) {
      console.error('[QuickCreateMenu] Folder picker failed:', err);
      notify.error({ title: t`Failed to open folder picker` });
      return null;
    }
  }, [computeNode, t]);

  const handleCreateLocalProject = useCallback(
    async (rawName: string, rawParent: string) => {
      const cleanName = rawName.trim();
      const cleanParent = rawParent.trim().replace(/\\/g, '/').replace(/\/+$/, '');
      if (!cleanName || !cleanParent) throw new Error('Name and parent folder required');
      await ensureProject(`${cleanParent}/${cleanName}`);
    },
    [ensureProject],
  );

  const projectItems = useMemo(() => projectEntitiesToSelectorItems(projects), [projects]);

  // Coding-agent sessions aren't "assets" with a name/folder — they launch a
  // live AgenticProcess immediately. Create the process, then navigate to its
  // terminal dock pointer (URL-first; the loader owns the rendered view).
  const handleStartSession = useCallback(
    async (workerType: 'claude_code' | 'codex' | 'copilot') => {
      onOpenChange(false);
      // openNewChat creates AND navigates (carrying the chat mode) — no second nav.
      // The catch is load-bearing: this is invoked as `void handleStartSession(…)`,
      // so a rejected create used to become an unhandled rejection and the user
      // got no feedback at all in any view mode.
      try {
        const process = await openNewChat(navigation, { workerType });
        if (!process) notify.error({ title: t`Failed to start session` });
      } catch (err) {
        console.error('[QuickCreateMenu] start session failed', err);
        openCapabilitiesForWorker(navigation, workerType);
      }
    },
    [navigation, onOpenChange, t],
  );

  const handleProjectSelect = useCallback(
    async (id: string) => {
      const picked = projects?.find((p) => p.id === id);
      if (!picked) return;
      await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, picked.typeId);
      await dataContext.refreshProject();
      dataContext.setWorkdir(picked.fs_storage_mount_path ?? null);
    },
    [projects],
  );

  const items = useMemo(() => {
    const serverCreatable = new Set(serverTypes.filter((t) => t.creatable).map((t) => t.type_name));
    // When server list is empty (still loading / older backend), fall back to the
    // full UI registry — it's the best-effort source of truth.
    const enforce = serverCreatable.size > 0;
    return QUICK_CREATE_REGISTRY.filter((d) => !enforce || serverCreatable.has(d.type)).map((d) => {
      const label = d.label ?? serverTypes.find((t) => t.type_name === d.type)?.label;
      return { ...d, displayLabel: label };
    });
  }, [serverTypes]);

  return (
    <>
      <DropdownMenu open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        <DropdownMenuContent align="center" className="w-60">
          <div className="p-1">
            <button
              type="button"
              onClick={() => {
                onOpenChange(false);
                setProjectModalOpen(true);
              }}
              className="flex w-full items-center gap-1.5 rounded-md border border-border bg-transparent px-2 py-1 text-xs transition-colors hover:bg-accent"
              title={t`Switch project`}
            >
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                <Trans>Project</Trans>
              </span>
              <span className="truncate">{currentProject?.displayName ?? t`Select…`}</span>
            </button>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>
            <Trans>New session</Trans>
          </DropdownMenuLabel>
          <DropdownMenuItem onSelect={() => void handleStartSession('claude_code')}>
            <ClaudeIcon className="mr-2 h-4 w-4 text-orange-500" />
            <Trans>Claude Code session</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void handleStartSession('codex')}>
            <CodexIcon className="mr-2 h-4 w-4 text-emerald-500" />
            <Trans>Codex session</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void handleStartSession('copilot')}>
            <CopilotIcon className="mr-2 h-4 w-4 text-sky-500" />
            <Trans>Copilot session</Trans>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>
            <Trans>New project</Trans>
          </DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() => {
              onOpenChange(false);
              setNewLocalProjectOpen(true);
            }}
          >
            <FolderPlus className="mr-2 h-4 w-4" />
            <Trans>Project (local)</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              onOpenChange(false);
              setNewGitProjectOpen(true);
            }}
          >
            <GitBranch className="mr-2 h-4 w-4" />
            <Trans>From git</Trans>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>
            <Trans>Create new…</Trans>
          </DropdownMenuLabel>
          {items.map((item) => {
            // Backend type registry owns the glyph (TypeInfo.icon).
            const Icon = iconForType(item.type);
            return (
              <DropdownMenuItem
                key={item.type}
                onSelect={() => {
                  onOpenChange(false);
                  onPick(item.type);
                }}
              >
                <Icon className="mr-2 h-4 w-4" />
                {item.displayLabel}
              </DropdownMenuItem>
            );
          })}
          {items.length === 0 && (
            <DropdownMenuItem disabled>
              <Trans>No creatable types available</Trans>
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <ProjectSelectorModal
        open={projectModalOpen}
        onOpenChange={setProjectModalOpen}
        projects={projectItems}
        selectedId={currentProject?.id ?? null}
        onSelect={(id) => void handleProjectSelect(id)}
        isLoading={isLoadingProjects}
      />
      <NewProjectDialog
        open={newLocalProjectOpen}
        onOpenChange={setNewLocalProjectOpen}
        defaultParentFolder={defaultWorkspacePath}
        onPickFolder={handlePickFolder}
        onCreate={handleCreateLocalProject}
      />
      <NewProjectFromGitDialog
        open={newGitProjectOpen}
        onOpenChange={setNewGitProjectOpen}
        onCreate={handleCreateGitProject}
      />
    </>
  );
}
