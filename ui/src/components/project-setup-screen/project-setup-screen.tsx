import { ContextEntitiesEnum, dataContext, Project } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Input } from '@src/components/ui/input';
import { Label } from '@src/components/ui/label';
import { FolderOpen, FolderPlus, Loader2, LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react/macro';

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
        <Trans>Back</Trans>
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
  const { t } = useLingui();
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

  const computeNode = useMemo(() => dataContext.computeNode, []);

  const handleBrowseFolder = useCallback(
    async (setter: (path: string) => void) => {
      if (!computeNode) {
        setError(t`No compute node available`);
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
        setError(t`Failed to open folder picker`);
      }
    },
    [computeNode],
  );

  const saveProject = useCallback(async (path: string) => {
    let newProject = new Project({ name: path });
    newProject = await newProject.save([dataContext.someone!]);
    await newProject.setupForDesktop();
    await dataContext.setContextEntityTypeId(ContextEntitiesEnum.CurrentProjectTypeId, newProject.typeId);
    await dataContext.refreshProject();
  }, []);

  const handleSubmitProject = useCallback(
    async (action: 'create' | 'open') => {
      if (!dataContext.someone) {
        setError(t`You must be logged in`);
        return;
      }

      const isCreate = action === 'create';
      const path = isCreate ? parentFolderPath.trim() : selectedFolderPath.trim();

      if (!path) {
        setError(isCreate ? t`Please select a parent folder` : t`Please select or enter a folder`);
        return;
      }
      if (isCreate && !newProjectName.trim()) {
        setError(t`Please enter a project name`);
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
          title={t`Create New Project`}
          description={t`Enter a name and choose where to create your project.`}
        />
        <div className="space-y-2">
          <Label htmlFor="project-name"><Trans>Project Name</Trans></Label>
          <Input
            id="project-name"
            placeholder={t`my-awesome-project`}
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            autoFocus
          />
        </div>
        <FolderInput
          id="parent-folder"
          label={t`Parent Folder`}
          value={parentFolderPath}
          onChange={setParentFolderPath}
          onBrowse={() => void handleBrowseFolder(setParentFolderPath)}
          showBrowse={!!computeNode}
          placeholder={defaultWorkspacePath || t`Select parent folder`}
          helperText={
            isDesktop
              ? t`Full path where your project folder will be created.`
              : t`In browser mode, projects must be in the workspace folder. Enter the full path manually.`
          }
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <FormActions
          onSubmit={() => void handleSubmitProject('create')}
          onCancel={handleBack}
          submitLabel={t`Create Project`}
          submitLoadingLabel={t`Creating...`}
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
          title={t`Open Existing Project`}
          description={t`Choose a folder to open as a project.`}
        />
        <FolderInput
          id="project-path"
          label={t`Project Folder`}
          value={selectedFolderPath}
          onChange={setSelectedFolderPath}
          onBrowse={() => void handleBrowseFolder(setSelectedFolderPath)}
          showBrowse={!!computeNode}
          placeholder={defaultWorkspacePath ? `${defaultWorkspacePath}/my-project` : t`Enter folder path`}
          helperText={
            isDesktop
              ? t`Click the folder icon to browse, or enter the full path.`
              : t`In browser mode, projects must be in the workspace folder. Enter the full path manually.`
          }
          autoFocus
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <FormActions
          onSubmit={() => void handleSubmitProject('open')}
          onCancel={handleBack}
          submitLabel={t`Open Project`}
          submitLoadingLabel={t`Opening...`}
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
        <Trans>New Project</Trans>
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
        <Trans>Open Project</Trans>
      </Button>
    </div>
  );
}
