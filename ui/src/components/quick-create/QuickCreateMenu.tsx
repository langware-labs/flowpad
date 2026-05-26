import { ContextEntitiesEnum, dataContext, Project } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import {
  NewProjectDialog,
  NewProjectFromGitDialog,
  ProjectSelectorModal,
  useEnsureProject,
  useSelectExistingProject,
} from '@src/components/project-selector';
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
import { useToast } from '@src/hooks/use-toast';
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
  const { types: serverTypes } = useAssetTypes();
  const { project: currentProject } = useProject();
  const { projects, isLoading: isLoadingProjects } = useProjects();
  const { computeNode } = useAgentContext();
  const { toast } = useToast();
  const ensureProject = useEnsureProject();
  const selectExisting = useSelectExistingProject();
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [newLocalProjectOpen, setNewLocalProjectOpen] = useState(false);
  const [newGitProjectOpen, setNewGitProjectOpen] = useState(false);

  const defaultWorkspacePath = useMemo(
    () => dataContext.bootstrapInfo?.desktop_info?.paths?.workspace || '',
    [],
  );

  const handlePickFolder = useCallback(async (): Promise<string | null> => {
    if (!computeNode) {
      toast({ title: 'No compute node available', variant: 'destructive' });
      return null;
    }
    try {
      return await computeNode.openPathDialog();
    } catch (err) {
      console.error('[QuickCreateMenu] Folder picker failed:', err);
      toast({ title: 'Failed to open folder picker', variant: 'destructive' });
      return null;
    }
  }, [computeNode, toast]);

  const handleCreateLocalProject = useCallback(
    async (rawName: string, rawParent: string) => {
      const cleanName = rawName.trim();
      const cleanParent = rawParent.trim().replace(/\\/g, '/').replace(/\/+$/, '');
      if (!cleanName || !cleanParent) throw new Error('Name and parent folder required');
      await ensureProject(`${cleanParent}/${cleanName}`);
    },
    [ensureProject],
  );

  const handleCreateGitProject = useCallback(
    async (
      url: string,
      acceptSuggested?: string,
    ): Promise<{ ok: true } | { ok: false; suggestedName: string; attemptedName: string }> => {
      if (!computeNode) {
        throw new Error('No compute node available');
      }
      const result = await Project.createFromGitUrl(computeNode.id, url, acceptSuggested);
      if (result.kind === 'ok') {
        await selectExisting(result.project);
        return { ok: true };
      }
      if (result.kind === 'collision') {
        return { ok: false, suggestedName: result.suggestedName, attemptedName: result.attemptedName };
      }
      throw new Error(result.message);
    },
    [computeNode, selectExisting],
  );

  const projectItems = useMemo(
    () =>
      (projects ?? []).map((p) => ({
        id: p.id,
        name: p.displayName,
        path: p.fs_storage_mount_path ?? '',
        modifiedAt: p.updated_date ?? null,
      })),
    [projects],
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
    const serverCreatable = new Set(
      serverTypes.filter((t) => t.creatable).map((t) => t.type_name),
    );
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
              title="Switch project"
            >
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Project
              </span>
              <span className="truncate">{currentProject?.displayName ?? 'Select…'}</span>
            </button>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>New project</DropdownMenuLabel>
          <DropdownMenuItem
            onSelect={() => {
              onOpenChange(false);
              setNewLocalProjectOpen(true);
            }}
          >
            <FolderPlus className="mr-2 h-4 w-4" />
            Project (local)
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              onOpenChange(false);
              setNewGitProjectOpen(true);
            }}
          >
            <GitBranch className="mr-2 h-4 w-4" />
            Project (git)
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Create new…</DropdownMenuLabel>
          {items.map((item) => {
            const Icon = item.Icon;
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
            <DropdownMenuItem disabled>No creatable types available</DropdownMenuItem>
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
