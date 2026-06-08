import { dataContext, Project } from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import {
  canonicalPath,
  NewProjectDialog,
  projectListToSelectorItems,
  ProjectSelectorModal,
  useEnsureProject,
} from '@src/components/project-selector';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { useAllProjects } from '@src/hooks/use-all-projects';
import { notify } from '@src/notifications';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ScopeSelection, type HarnessKind, type Scope } from './ScopeSelection';
import { getDescriptor, subFolderFor, type QuickCreateDescriptor } from './registry';
import { useProjectSnapshot } from './useProjectSnapshot';

interface QuickCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Descriptor `type` (e.g. 'skill', 'agent'). Ignored when null. */
  type: string | null;
}

function projectPrefix(project: Project | null): string | null {
  if (!project) return null;
  return project.displayName ?? project.name ?? null;
}

function defaultPathFor(scope: Scope, descriptor: QuickCreateDescriptor, harness: HarnessKind): string {
  if (scope.kind === 'folder') return scope.folderPath ?? '';
  const sub = subFolderFor(descriptor, harness, scope.kind);
  const prefix = scope.kind === 'user' ? '~' : projectPrefix(scope.project);
  return [prefix, sub].filter(Boolean).join('/') || sub;
}

function initialScope(project: Project | null): Scope {
  return {
    kind: project ? 'project' : 'user',
    project,
    folderPath: null,
  };
}

export function QuickCreateDialog({ open, onOpenChange, type }: QuickCreateDialogProps) {
  const descriptor = type ? getDescriptor(type) : undefined;
  const { navigation } = useDockNavigation();
  const { project } = useProject();
  const { computeNode } = useAgentContext();
  const { projects: allProjects, isLoading: isLoadingProjects } = useAllProjects({ enabled: open });
  const { restore, commit } = useProjectSnapshot(open);

  const [name, setName] = useState('');
  const [scope, setScope] = useState<Scope>(() => initialScope(project ?? null));
  const [harness, setHarness] = useState<HarnessKind>('all');
  const [path, setPath] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);

  const defaultWorkspacePath = useMemo(() => dataContext.bootstrapInfo?.desktop_info?.paths?.workspace || '', []);

  // Reset form whenever the dialog opens for a new type
  useEffect(() => {
    if (open && descriptor) {
      const next = initialScope(project ?? null);
      setName('');
      setScope(next);
      setHarness('all');
      setPath(defaultPathFor(next, descriptor, 'all'));
      setIsSubmitting(false);
      requestAnimationFrame(() => nameRef.current?.focus());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, descriptor?.type]);

  // When the user's currently-active project changes while scope === 'project',
  // mirror it into the scope and re-seed the path (only if the user hasn't
  // hand-edited the path away from the previous default).
  useEffect(() => {
    if (!open || !descriptor) return;
    if (scope.kind !== 'project') return;
    if (scope.project?.id === project?.id) return;
    const next: Scope = { ...scope, project: project ?? null };
    setScope(next);
    setPath((current) =>
      current === defaultPathFor(scope, descriptor, harness) ? defaultPathFor(next, descriptor, harness) : current,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  const handleScopeChange = useCallback(
    (next: Scope) => {
      if (!descriptor) return;
      setScope(next);
      // Seeding the path on chip change is part of the spec: chip = default-setter.
      setPath(defaultPathFor(next, descriptor, harness));
    },
    [descriptor, harness],
  );

  const handleHarnessChange = useCallback(
    (next: HarnessKind) => {
      if (!descriptor) return;
      setHarness(next);
      setPath(defaultPathFor(scope, descriptor, next));
    },
    [descriptor, scope],
  );

  const projectItems = useMemo(() => projectListToSelectorItems(allProjects), [allProjects]);

  const currentProjectKey = useMemo(
    () => canonicalPath(project?.fs_storage_mount_path ?? ''),
    [project?.fs_storage_mount_path],
  );

  const ensureProject = useEnsureProject();

  const handleProjectPick = useCallback(
    async (pickedKey: string) => {
      const picked = allProjects.find((p) => canonicalPath(p.cwd) === pickedKey);
      if (!picked?.cwd) return;
      await ensureProject(picked.cwd);
    },
    [allProjects, ensureProject],
  );

  const handleCreateProject = useCallback(
    async (rawName: string, rawParent: string) => {
      const cleanName = rawName.trim();
      const cleanParent = rawParent.trim().replace(/\\/g, '/').replace(/\/+$/, '');
      if (!cleanName || !cleanParent) throw new Error('Name and parent folder required');
      await ensureProject(`${cleanParent}/${cleanName}`);
    },
    [ensureProject],
  );

  const handlePickFolder = useCallback(async (): Promise<string | null> => {
    if (!computeNode) {
      notify.error({ title: 'No compute node available' });
      return null;
    }
    try {
      return await computeNode.openPathDialog();
    } catch (err) {
      console.error('[QuickCreateDialog] Folder picker failed:', err);
      notify.error({ title: 'Failed to open folder picker' });
      return null;
    }
  }, [computeNode]);

  const folderVfsPath = useMemo<string | undefined>(() => {
    if (!descriptor || scope.kind !== 'project') return undefined;
    const prefix = projectPrefix(scope.project);
    if (prefix && path.startsWith(`${prefix}/`)) return path.slice(prefix.length + 1);
    return subFolderFor(descriptor, harness, 'project');
  }, [descriptor, scope, harness, path]);

  const handleCreate = useCallback(async () => {
    if (!descriptor || !name.trim() || isSubmitting) return;
    setIsSubmitting(true);
    try {
      const res = await descriptor.create({
        project: dataContext.project ?? null,
        name,
        absolutePath: path,
        scope: scope.kind,
        harness,
        folderVfsPath,
      });
      notify.success({ title: res.toastTitle });
      commit();
      if (res.pointer) navigation.openDock(res.pointer);
      onOpenChange(false);
    } catch (err) {
      console.error('[QuickCreateDialog] Create failed:', err);
      notify.error({ title: 'Failed to create' });
    } finally {
      setIsSubmitting(false);
    }
  }, [descriptor, name, path, scope.kind, harness, folderVfsPath, isSubmitting, commit, navigation, onOpenChange]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) void restore();
      onOpenChange(next);
    },
    [onOpenChange, restore],
  );

  if (!descriptor) return null;
  const Icon = descriptor.Icon;
  const canCreate = !!name.trim() && !!path.trim() && !isSubmitting;

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Icon className="h-4 w-4" />
              New {descriptor.label}
            </DialogTitle>
            <DialogDescription>Create a new {descriptor.label.toLowerCase()}.</DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3 pt-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Name</label>
              <Input
                ref={nameRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`New ${descriptor.label.toLowerCase()} name`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canCreate) void handleCreate();
                }}
                autoFocus
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Scope</label>
              <ScopeSelection
                scope={scope}
                onScopeChange={handleScopeChange}
                harness={harness}
                onHarnessChange={handleHarnessChange}
                path={path}
                onPathChange={setPath}
                onPickFolder={handlePickFolder}
                onOpenProjectPicker={() => setProjectPickerOpen(true)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button onClick={() => void handleCreate()} disabled={!canCreate}>
              {isSubmitting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ProjectSelectorModal
        open={projectPickerOpen}
        onOpenChange={setProjectPickerOpen}
        projects={projectItems}
        selectedId={currentProjectKey || null}
        onSelect={(id) => void handleProjectPick(id)}
        isLoading={isLoadingProjects}
        onCreateNew={() => {
          setProjectPickerOpen(false);
          setNewProjectOpen(true);
        }}
      />

      <NewProjectDialog
        open={newProjectOpen}
        onOpenChange={setNewProjectOpen}
        defaultParentFolder={defaultWorkspacePath}
        onPickFolder={handlePickFolder}
        onCreate={handleCreateProject}
      />
    </>
  );
}
