import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { type ProjectResourceListItem } from '@src/components/project-resource-list';
import { QuickAccessSideBar } from '@src/components/quick-access-sidebar';
import { useClaudeProjectList } from '@src/hooks/use-claude-projects';
import { useHooksSniffer } from '@src/hooks/use-hooks-sniffer';
import {
  ContextEntitiesEnum,
  dataContext,
  openTerminalFromComputeNode,
  type ProjectListItem,
  Project,
  QueryRequest,
} from '@sdk';
import { useProject } from '@sdk/react/hooks';
import { Button } from '@src/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@src/components/ui/dialog';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { useToast } from '@src/hooks/use-toast';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { FolderOpen, FolderPlus, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

const normalizePath = (path: string): string => {
  const normalized = path.trim().replace(/\\/g, '/');
  if (!normalized) return '';
  if (normalized === '/') return '/';
  return normalized.replace(/\/+$/, '');
};

const canonicalPathKey = (path: string): string => normalizePath(path).replace(/^\/+/, '');

const joinPath = (basePath: string, childSegment: string): string => {
  const base = normalizePath(basePath);
  const child = childSegment.trim().replace(/^\/+|\/+$/g, '');
  if (!base) return child;
  if (base === '/') return `/${child}`;
  return `${base}/${child}`;
};

const getProjectPath = (project: Project): string => normalizePath(project.fs_storage_mount_path || project.name || '');

export type OpenProjectMode = 'open' | 'create';

interface OpenProjectComponentProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialMode?: OpenProjectMode;
  onProjectChanged?: () => void;
}

interface FolderInputProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  helperText: string;
  showBrowse: boolean;
  onBrowse: () => void;
  autoFocus?: boolean;
}

function FolderInput({
  id,
  label,
  value,
  onChange,
  placeholder,
  helperText,
  showBrowse,
  onBrowse,
  autoFocus = false,
}: FolderInputProps) {
  const handleInputRef = (el: HTMLInputElement | null) => {
    if (el && value) {
      el.scrollLeft = el.scrollWidth;
    }
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <Input
          ref={handleInputRef}
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="flex-1 font-mono text-sm"
          dir="ltr"
          autoFocus={autoFocus}
        />
        {showBrowse && (
          <Button variant="outline" onClick={onBrowse} title="Browse for folder" type="button">
            <FolderOpen className="h-4 w-4" />
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{helperText}</p>
    </div>
  );
}

export function OpenProjectComponent({
  open,
  onOpenChange,
  initialMode = 'open',
  onProjectChanged,
}: OpenProjectComponentProps) {
  const { project: currentProject } = useProject();
  const { toast } = useToast();
  const { projects: scanProjects, isLoading: isLoadingScanProjects } = useClaudeProjectList({ enabled: open });
  const [mode, setMode] = useState<OpenProjectMode>(initialMode);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState('');
  const [parentFolderPath, setParentFolderPath] = useState('');
  const [selectedFolderPath, setSelectedFolderPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [expandedProjectEncodedName, setExpandedProjectEncodedName] = useState<string | null>(null);

  const { navigation } = useDockNavigation();
  const { computeNode } = useAgentContext();
  const { projectFlowDataCounts } = useHooksSniffer();

  // Derive current project's encoded name from the scan list
  const currentProjectEncodedName = useMemo(() => {
    if (!currentProject) return null;
    const currentPath = normalizePath(currentProject.fs_storage_mount_path || currentProject.name || '');
    const byId = scanProjects.find((p) => p.id === currentProject.id);
    if (byId?.encoded_name) return byId.encoded_name;
    if (!currentPath) return null;
    const byPath = scanProjects.find((p) => {
      const scanPath = normalizePath(p.cwd || p.name || '');
      return !!scanPath && scanPath === currentPath;
    });
    return byPath?.encoded_name || null;
  }, [scanProjects, currentProject]);

  const isDesktop = useMemo(() => dataContext.isDesktop, []);
  const defaultWorkspacePath = useMemo(() => dataContext.bootstrapInfo?.desktop_info?.paths?.workspace || '', []);

  useEffect(() => {
    if (!open) return;
    const currentProjectPath = currentProject?.fs_storage_mount_path || '';
    setMode(initialMode);
    setNewProjectName('');
    setParentFolderPath(defaultWorkspacePath);
    setSelectedFolderPath(currentProjectPath || defaultWorkspacePath);
    setError(null);
    setIsSubmitting(false);
    setOpeningProjectId(null);
    setExpandedProjectEncodedName(null);
  }, [open, initialMode, defaultWorkspacePath, currentProject?.fs_storage_mount_path]);

  const handleBrowseFolder = useCallback(
    async (setter: (path: string) => void) => {
      if (!computeNode) {
        setError('No compute node available');
        return;
      }
      try {
        const selected = await computeNode.openPathDialog();
        if (selected) {
          setter(selected);
          setError(null);
        }
      } catch (err) {
        console.error('Failed to open folder picker:', err);
        setError('Failed to open folder picker');
      }
    },
    [computeNode],
  );

  const setCurrentProjectContext = useCallback(
    async (project: Project) => {
      await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, project.typeId);
      await dataContext.refreshProject();
      onProjectChanged?.();
    },
    [onProjectChanged],
  );

  const ensureProjectAndSetContext = useCallback(
    async (path: string) => {
      if (!dataContext.someone) {
        throw new Error('You must be logged in');
      }

      const normalizedPath = normalizePath(path);
      if (!normalizedPath) {
        throw new Error('Please provide a valid project path');
      }
      const pathKey = canonicalPathKey(normalizedPath);

      const findByPath = (projectList: Project[]) =>
        projectList.find((project) => canonicalPathKey(getProjectPath(project)) === pathKey) || null;

      const freshProjects = await Project.query(
        new QueryRequest({
          type: Project.type,
          query: null,
          scope: [],
          name: 'open-project-component-dedup-query',
        }),
      );
      let targetProject = findByPath(freshProjects);
      const openedExisting = !!targetProject;

      if (!targetProject) {
        targetProject = new Project({ name: normalizedPath });
        await targetProject.save([dataContext.someone]);
      }

      await targetProject.setupForDesktop();
      await setCurrentProjectContext(targetProject);
      return { project: targetProject, openedExisting };
    },
    [setCurrentProjectContext],
  );

  const handleProjectFromList = useCallback(
    async (projectPath: string, projectId: string) => {
      setOpeningProjectId(projectId);
      setError(null);

      try {
        await ensureProjectAndSetContext(projectPath);
        onOpenChange(false);
      } catch (err) {
        console.error('Failed to open project:', err);
        setError(err instanceof Error ? err.message : 'Failed to open project');
      } finally {
        setOpeningProjectId(null);
      }
    },
    [ensureProjectAndSetContext, onOpenChange],
  );

  const handleSidebarProjectClick = useCallback(
    (project: ProjectListItem) => {
      const path = normalizePath(project.cwd || project.name || '');
      if (path) void handleProjectFromList(path, project.id);
    },
    [handleProjectFromList],
  );

  const handleExpandProject = useCallback(
    (project: ProjectListItem) => setExpandedProjectEncodedName(project.encoded_name),
    [],
  );

  const handleCollapseProject = useCallback(() => setExpandedProjectEncodedName(null), []);

  const handleNewSession = useCallback(
    (project: ProjectListItem) => {
      if (!computeNode?.id) return;
      const cwd = project.cwd || undefined;
      onOpenChange(false);
      openTerminalFromComputeNode(computeNode.id, 'claude', cwd).catch((err) => {
        console.error('[OpenProject] Failed to open new session:', err);
        toast({
          title: 'New Session Failed',
          description: `Could not open terminal: ${err instanceof Error ? err.message : 'Unknown error'}`,
          variant: 'destructive',
        });
      });
    },
    [computeNode?.id, onOpenChange, toast],
  );

  const handleResourceClick = useCallback(
    (resource: ProjectResourceListItem) => {
      onOpenChange(false);
      const navOptions = expandedProjectEncodedName
        ? { scope: 'project', project: expandedProjectEncodedName }
        : undefined;

      if (resource.type === 'skill') {
        navigation.openDock(DockPointer.forSkills(resource.skillDockPath));
        return;
      }

      switch (resource.type) {
        case 'claude_session':
          navigation.openSystemProfile('sessions', resource.itemId, navOptions);
          break;
        case 'hook':
          navigation.openSystemProfile('hooks', resource.itemId, navOptions);
          break;
        case 'command':
          navigation.openSystemProfile('commands', resource.itemId, navOptions);
          break;
        case 'agent':
          navigation.openSystemProfile('agents', resource.itemId, navOptions);
          break;
        case 'todo':
          navigation.openSystemProfile('todos', resource.itemId, navOptions);
          break;
        case 'plugin':
          navigation.openSystemProfile('plugins', resource.itemId, navOptions);
          break;
        case 'mcp_server':
          navigation.openSystemProfile('projects', undefined, {
            project: expandedProjectEncodedName ?? undefined,
          });
          break;
        case 'claude_md':
          navigation.openSystemProfile('summary', undefined, navOptions);
          break;
        default:
          navigation.openSystemProfile();
      }
    },
    [navigation, expandedProjectEncodedName, onOpenChange],
  );

  const handleSubmit = useCallback(async () => {
    const isCreate = mode === 'create';

    if (isCreate && !newProjectName.trim()) {
      setError('Please enter a project name');
      return;
    }

    const path = isCreate ? joinPath(parentFolderPath, newProjectName) : selectedFolderPath.trim();
    if (!path) {
      setError(isCreate ? 'Please select a parent folder' : 'Please select or enter a project folder');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const result = await ensureProjectAndSetContext(path);
      if (result.openedExisting) {
        toast({
          title: 'Opened existing project',
          description: result.project.displayName,
        });
      }
      onOpenChange(false);
    } catch (err) {
      console.error(`Failed to ${isCreate ? 'create' : 'open'} project:`, err);
      setError(err instanceof Error ? err.message : `Failed to ${isCreate ? 'create' : 'open'} project`);
    } finally {
      setIsSubmitting(false);
    }
  }, [mode, newProjectName, parentFolderPath, selectedFolderPath, ensureProjectAndSetContext, onOpenChange, toast]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Create Project' : 'Open Project'}</DialogTitle>
          <DialogDescription>Select an existing project or choose a folder to open or create.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto pr-1">
          <div className="rounded-lg border bg-muted/30 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Current project:</span>{' '}
            <span className="font-medium">{currentProject?.displayName || 'None selected'}</span>
          </div>

          <div className="h-64 overflow-hidden rounded-lg border border-border bg-card">
            <QuickAccessSideBar
              projects={scanProjects}
              isLoading={isLoadingScanProjects}
              onProjectClick={handleSidebarProjectClick}
              onNewProject={() => setMode('create')}
              onOpenProject={() => setMode('open')}
              currentProjectEncodedName={currentProjectEncodedName}
              onResourceClick={handleResourceClick}
              expandedProjectEncodedName={expandedProjectEncodedName}
              onExpandProject={handleExpandProject}
              onCollapseProject={handleCollapseProject}
              onNewSession={handleNewSession}
              projectFlowDataCounts={projectFlowDataCounts}
            />
          </div>

          <div className="flex items-center gap-2">
            <Button variant={mode === 'open' ? 'default' : 'outline'} onClick={() => setMode('open')} className="gap-2">
              <FolderOpen className="h-4 w-4" />
              Open Folder
            </Button>
            <Button
              variant={mode === 'create' ? 'default' : 'outline'}
              onClick={() => setMode('create')}
              className="gap-2"
            >
              <FolderPlus className="h-4 w-4" />
              Create New
            </Button>
          </div>

          {mode === 'create' ? (
            <div className="space-y-3 rounded-lg border bg-card p-4">
              <div className="space-y-2">
                <Label htmlFor="project-name">Project name</Label>
                <Input
                  id="project-name"
                  placeholder="my-awesome-project"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  autoFocus
                />
              </div>
              <FolderInput
                id="parent-folder"
                label="Parent folder"
                value={parentFolderPath}
                onChange={setParentFolderPath}
                onBrowse={() => void handleBrowseFolder(setParentFolderPath)}
                showBrowse={!!computeNode}
                placeholder={defaultWorkspacePath || 'Select parent folder'}
                helperText={
                  isDesktop
                    ? 'Full path where your project folder will be created.'
                    : 'In browser mode, projects must be inside the workspace folder.'
                }
              />
            </div>
          ) : (
            <div className="space-y-3 rounded-lg border bg-card p-4">
              <FolderInput
                id="project-path"
                label="Project folder"
                value={selectedFolderPath}
                onChange={setSelectedFolderPath}
                onBrowse={() => void handleBrowseFolder(setSelectedFolderPath)}
                showBrowse={!!computeNode}
                placeholder={defaultWorkspacePath ? `${defaultWorkspacePath}/my-project` : 'Enter folder path'}
                helperText={
                  isDesktop
                    ? 'Click the folder icon to browse, or enter the full path.'
                    : 'In browser mode, projects must be inside the workspace folder.'
                }
                autoFocus
              />
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting || !!openingProjectId}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleSubmit()}
              disabled={
                isSubmitting ||
                !!openingProjectId ||
                (mode === 'create' ? !newProjectName.trim() || !parentFolderPath.trim() : !selectedFolderPath.trim())
              }
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {mode === 'create' ? 'Creating...' : 'Opening...'}
                </>
              ) : mode === 'create' ? (
                'Create Project'
              ) : (
                'Open Project'
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default OpenProjectComponent;
