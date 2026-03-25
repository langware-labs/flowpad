import { ContextEntitiesEnum, dataContext, Project } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { FolderOpen, FolderPlus, Loader2, LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

const isDirectoryPickerSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

interface ProjectFormHeaderProps {
  icon: LucideIcon;
  title: string;
  description: string;
}

function ProjectFormHeader({ icon: Icon, title, description }: ProjectFormHeaderProps) {
  return (
    <div className="mb-4">
      <div className="flex items-center gap-2 font-medium">
        <Icon className="h-4 w-4" />
        {title}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

interface FolderInputProps {
  id?: string;
  label?: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  helperText?: string;
  autoFocus?: boolean;
  onBrowse: () => void;
  showBrowse?: boolean;
}

function FolderInput({
  id,
  label,
  value,
  onChange,
  placeholder = 'Folder path',
  helperText,
  autoFocus = false,
  onBrowse,
  showBrowse = true,
}: FolderInputProps) {
  // Scroll input to show the end of the path when value changes
  const handleInputRef = (el: HTMLInputElement | null) => {
    if (el && value) {
      // Scroll to the end to show the most relevant part of the path
      el.scrollLeft = el.scrollWidth;
    }
  };

  return (
    <div className="space-y-2">
      {label && <Label htmlFor={id}>{label}</Label>}
      <div className="flex gap-2">
        <Input
          ref={handleInputRef}
          id={id}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 font-mono text-sm"
          autoFocus={autoFocus}
          dir="ltr"
        />
        {showBrowse && (
          <Button variant="outline" onClick={onBrowse} title="Browse for folder" type="button">
            <FolderOpen className="h-4 w-4" />
          </Button>
        )}
      </div>
      {helperText && <p className="text-xs text-muted-foreground">{helperText}</p>}
    </div>
  );
}

interface FormActionsProps {
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
  submitLoadingLabel?: string;
  isLoading: boolean;
  isDisabled: boolean;
}

function FormActions({ onSubmit, onCancel, submitLabel, submitLoadingLabel, isLoading, isDisabled }: FormActionsProps) {
  return (
    <div className="flex gap-2">
      <Button variant="outline" onClick={onCancel} className="flex-1">
        Back
      </Button>
      <Button onClick={onSubmit} disabled={isLoading || isDisabled} className="flex-1">
        {isLoading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {submitLoadingLabel || `${submitLabel}...`}
          </>
        ) : (
          submitLabel
        )}
      </Button>
    </div>
  );
}

export type ProjectSetupMode = 'select' | 'create' | 'open';

interface ProjectSetupScreenProps {
  /** External mode control (optional) */
  mode?: ProjectSetupMode;
  /** Callback when mode changes (optional) */
  onModeChange?: (mode: ProjectSetupMode) => void;
  /** Hide the buttons when in 'select' mode */
  hideButtons?: boolean;
  /** Callback when a project is created or opened */
  onProjectCreated?: () => void;
}

export function ProjectSetupScreen({
  mode: externalMode,
  onModeChange,
  hideButtons = false,
  onProjectCreated,
}: ProjectSetupScreenProps) {
  const [internalMode, setInternalMode] = useState<ProjectSetupMode>('select');
  const [isCreating, setIsCreating] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const defaultWorkspacePath = useMemo(() => dataContext.bootstrapInfo?.desktop_info?.paths?.workspace || '', []);
  const currentProjectPath = dataContext.project?.fs_storage_mount_path || '';
  const [parentFolderPath, setParentFolderPath] = useState('');
  const [selectedFolderPath, setSelectedFolderPath] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Use external mode if provided, otherwise use internal mode
  const mode = externalMode ?? internalMode;
  const setMode = useCallback(
    (newMode: ProjectSetupMode) => {
      if (onModeChange) {
        onModeChange(newMode);
      } else {
        setInternalMode(newMode);
      }
    },
    [onModeChange],
  );

  const isDesktop = useMemo(() => dataContext.isDesktop, []);

  // Initialize form state when mode changes externally
  useEffect(() => {
    if (externalMode === 'create') {
      setParentFolderPath(defaultWorkspacePath);
      setNewProjectName('');
      setError(null);
    } else if (externalMode === 'open') {
      setSelectedFolderPath(currentProjectPath || defaultWorkspacePath);
      setError(null);
    }
  }, [externalMode, defaultWorkspacePath, currentProjectPath]);

  const handleBrowseFolder = useCallback(
    async (setter: (path: string) => void, currentPath: string) => {
      // Electron: use native dialog via preload bridge (returns full absolute path)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const electronAPI = (window as any).electronAPI;
      if (electronAPI?.pickFolder) {
        console.log('[FolderPicker] Electron detected, using native dialog');
        const selected = await electronAPI.pickFolder(currentPath.trim());
        if (selected) {
          setter(selected);
          setError(null);
        }
        return;
      }

      console.log('[FolderPicker] Not in Electron, using browser showDirectoryPicker');

      // Browser mode: File System Access API (only returns folder name, not full path)
      if (!isDirectoryPickerSupported) {
        setError('Folder picker is not supported in this browser');
        return;
      }

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dirHandle = await (window as any).showDirectoryPicker({ mode: 'read' });
        const folderName = dirHandle.name;

        if (isDesktop) {
          const basePath = currentPath.trim() || defaultWorkspacePath;
          const newPath = basePath ? `${basePath.replace(/\/+$/, '')}/${folderName}` : folderName;
          setter(newPath);
          setError('Browser cannot access full path. Please verify the path is correct.');
        } else {
          setter(`${defaultWorkspacePath}/${folderName}`);
          setError(null);
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        console.error('Failed to open folder picker:', err);
        setError('Failed to open folder picker');
      }
    },
    [defaultWorkspacePath, isDesktop],
  );

  const saveProject = useCallback(async (path: string) => {
    const newProject = new Project({ name: path });
    await newProject.save([dataContext.someone!]);
    await newProject.setupForDesktop();
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, newProject.typeId);
    await dataContext.refreshProject();
  }, []);

  const handleSubmitProject = useCallback(
    async (action: 'create' | 'open') => {
      if (!dataContext.someone) {
        setError('You must be logged in');
        return;
      }

      const isCreate = action === 'create';
      const path = isCreate ? parentFolderPath.trim() : selectedFolderPath.trim();

      if (!path) {
        setError(isCreate ? 'Please select a parent folder' : 'Please select or enter a folder');
        return;
      }
      if (isCreate && !newProjectName.trim()) {
        setError('Please enter a project name');
        return;
      }

      const setLoading = isCreate ? setIsCreating : setIsOpening;
      setLoading(true);
      setError(null);

      try {
        const fullPath = isCreate ? `${path}/${newProjectName.trim()}` : path;
        await saveProject(fullPath);
        if (isCreate) {
          setNewProjectName('');
          setParentFolderPath(defaultWorkspacePath);
        } else {
          setSelectedFolderPath(defaultWorkspacePath);
        }
        setMode('select');
        onProjectCreated?.();
      } catch (err) {
        console.error(`Failed to ${action} project:`, err);
        setError(err instanceof Error ? err.message : `Failed to ${action} project`);
      } finally {
        setLoading(false);
      }
    },
    [parentFolderPath, selectedFolderPath, newProjectName, saveProject, defaultWorkspacePath, onProjectCreated],
  );

  const handleBack = useCallback(() => {
    setMode('select');
    setError(null);
    setSelectedFolderPath(currentProjectPath || defaultWorkspacePath);
    setParentFolderPath(defaultWorkspacePath);
    setNewProjectName('');
  }, [defaultWorkspacePath, currentProjectPath]);

  // Create project form
  if (mode === 'create') {
    return (
      <div className="w-80 space-y-3 duration-200 animate-in fade-in slide-in-from-top-2">
        <ProjectFormHeader
          icon={FolderPlus}
          title="Create New Project"
          description="Enter a name and choose where to create your project."
        />
        <div className="space-y-2">
          <Label htmlFor="project-name">Project Name</Label>
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
          label="Parent Folder"
          value={parentFolderPath}
          onChange={setParentFolderPath}
          onBrowse={() => void handleBrowseFolder(setParentFolderPath, parentFolderPath)}
          showBrowse={isDesktop}
          placeholder={defaultWorkspacePath || 'Select parent folder'}
          helperText={
            isDesktop
              ? 'Full path where your project folder will be created.'
              : 'In browser mode, projects must be in the workspace folder. Enter the full path manually.'
          }
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <FormActions
          onSubmit={() => void handleSubmitProject('create')}
          onCancel={handleBack}
          submitLabel="Create Project"
          submitLoadingLabel="Creating..."
          isLoading={isCreating}
          isDisabled={!parentFolderPath.trim() || !newProjectName.trim()}
        />
      </div>
    );
  }

  // Open project form
  if (mode === 'open') {
    return (
      <div className="w-80 space-y-3 duration-200 animate-in fade-in slide-in-from-top-2">
        <ProjectFormHeader
          icon={FolderOpen}
          title="Open Existing Project"
          description="Choose a folder to open as a project."
        />
        <FolderInput
          id="project-path"
          label="Project Folder"
          value={selectedFolderPath}
          onChange={setSelectedFolderPath}
          onBrowse={() => void handleBrowseFolder(setSelectedFolderPath, selectedFolderPath)}
          showBrowse={isDesktop}
          placeholder={defaultWorkspacePath ? `${defaultWorkspacePath}/my-project` : 'Enter folder path'}
          helperText={
            isDesktop
              ? 'Click the folder icon to browse, or enter the full path.'
              : 'In browser mode, projects must be in the workspace folder. Enter the full path manually.'
          }
          autoFocus
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <FormActions
          onSubmit={() => void handleSubmitProject('open')}
          onCancel={handleBack}
          submitLabel="Open Project"
          submitLoadingLabel="Opening..."
          isLoading={isOpening}
          isDisabled={!selectedFolderPath.trim()}
        />
      </div>
    );
  }

  // Mode: 'select' - Show project selection buttons (if not hidden)
  if (hideButtons) {
    return null;
  }

  return (
    <div className="flex gap-3">
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setParentFolderPath(defaultWorkspacePath);
          setNewProjectName('');
          setError(null);
          setMode('create');
        }}
        className="gap-1.5"
      >
        <FolderPlus className="h-4 w-4" />
        New Project
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setSelectedFolderPath(currentProjectPath || defaultWorkspacePath);
          setError(null);
          setMode('open');
        }}
        className="gap-1.5"
      >
        <FolderOpen className="h-4 w-4" />
        Open Project
      </Button>
    </div>
  );
}
