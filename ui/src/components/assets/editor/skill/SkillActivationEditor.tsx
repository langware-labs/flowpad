import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import {
  ActivationLoadError,
  ActivationManager,
  ActivationParseError,
  ActivationRule,
  ComputeNode,
  FSItem,
} from '@sdk';
import { Button } from '@src/components/ui/button';
import { useToast } from '@src/hooks/use-toast';
import { Code, FileText, FlaskConical, RefreshCw, Save } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivationEvalsPanel } from './ActivationEvalsPanel';
import { ActivationMetadataHeader } from './ActivationMetadataHeader';
import { ActivationRuleView } from './ActivationRuleView';
import { ActivationTriggerView } from './ActivationTriggerView';
import { SkillsScope } from './skillEditorUtils';

export type ActivationViewMode = 'rule' | 'trigger' | 'evals';

interface SkillActivationEditorProps {
  item: FSItem;
  userActivationManager?: ActivationManager;
  projectActivationManager?: ActivationManager;
  onActivationUpdated?: () => void;
  /** Initial view mode - useful when clicking on a specific file like rule.md or trigger.py */
  initialViewMode?: ActivationViewMode;
}

export function SkillActivationEditor({
  item,
  userActivationManager,
  projectActivationManager,
  onActivationUpdated,
  initialViewMode = 'rule',
}: SkillActivationEditorProps) {
  useAgentContext(); // Keep context connection for future use
  const { toast } = useToast();
  const [activation, setActivation] = useState<ActivationRule | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [viewMode, setViewMode] = useState<ActivationViewMode>(initialViewMode);
  const [editedRuleContent, setEditedRuleContent] = useState('');
  const [editedTriggerContent, setEditedTriggerContent] = useState('');
  const [hasRuleChanges, setHasRuleChanges] = useState(false);
  const [hasTriggerChanges, setHasTriggerChanges] = useState(false);

  // Update viewMode when initialViewMode changes (e.g., when clicking different files)
  useEffect(() => {
    setViewMode(initialViewMode);
  }, [initialViewMode]);

  // Derive scope from FSItem's entity type and path
  // User activations: ComputeNode.type
  // Project activations: Project.type
  const scope = useMemo((): SkillsScope => {
    if (item.vfs_entity_type === ComputeNode.type) {
      return SkillsScope.UserActivations;
    }
    // Default to project scope for Project type or others
    return SkillsScope.ProjectActivations;
  }, [item.vfs_entity_type]);

  // Derive item properties from FSItem
  // For files inside activation folders, we derive the parent folder info
  const itemInfo = useMemo(() => {
    const entityPath = item.vfsPath.entitySubPath;
    const filename = item.vfsPath.filename;
    const isDir = item.is_dir;

    if (isDir) {
      // Directory - use as-is
      return {
        filename,
        fullPath: entityPath,
        isDir: true,
        activationFolderName: filename,
      };
    } else {
      // File - derive parent folder info (the activation rule folder)
      const parentPath = item.vfsPath.parent.entitySubPath;
      const parentFolderName = item.vfsPath.parent.filename;
      return {
        filename,
        fullPath: parentPath,
        isDir: false,
        activationFolderName: parentFolderName,
      };
    }
  }, [item]);

  // Select the appropriate ActivationManager based on scope
  const activeActivationManager = useMemo(() => {
    if (scope === SkillsScope.UserActivations) {
      return userActivationManager || null;
    }
    if (scope === SkillsScope.ProjectActivations) {
      return projectActivationManager || null;
    }
    return null;
  }, [scope, userActivationManager, projectActivationManager]);

  const loadActivation = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      // Load activation from the folder (works for both folder selection and file selection)
      if (!activeActivationManager) {
        setLoadError('No activation manager available');
        setActivation(null);
        return;
      }

      // Use activationFolderName which is derived from folder or parent folder
      const folderName = itemInfo.activationFolderName;
      const loadedActivation = await activeActivationManager.get(folderName);
      setActivation(loadedActivation);
      if (loadedActivation) {
        setEditedRuleContent(loadedActivation.rawRuleContent);
        setEditedTriggerContent(loadedActivation.triggerContent);
        setHasRuleChanges(false);
        setHasTriggerChanges(false);
      }
    } catch (error) {
      console.error('[SkillActivationEditor] Failed to load activation:', error);
      if (error instanceof ActivationLoadError || error instanceof ActivationParseError) {
        setLoadError(error.message);
      } else {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        setLoadError(`Failed to load activation rule: ${errorMessage}`);
      }
      setActivation(null);
    } finally {
      setIsLoading(false);
    }
  }, [itemInfo, activeActivationManager]);

  useEffect(() => {
    void loadActivation();
  }, [loadActivation]);

  const handleRuleContentChange = useCallback(
    (newContent: string) => {
      setEditedRuleContent(newContent);
      setHasRuleChanges(newContent !== activation?.rawRuleContent);
    },
    [activation?.rawRuleContent],
  );

  const handleTriggerContentChange = useCallback(
    (newContent: string) => {
      setEditedTriggerContent(newContent);
      setHasTriggerChanges(newContent !== activation?.triggerContent);
    },
    [activation?.triggerContent],
  );

  const hasChanges = hasRuleChanges || hasTriggerChanges;

  const handleSave = useCallback(async () => {
    if (!hasChanges) return;

    setIsSaving(true);
    try {
      // Use activationFolderName which is the folder name regardless of file/folder selection
      const folderName = itemInfo.activationFolderName;

      // Save rule.md if changed
      if (hasRuleChanges && activeActivationManager) {
        const updatedActivation = await activeActivationManager.updateRule(folderName, editedRuleContent);
        setActivation(updatedActivation);
        setHasRuleChanges(false);
      }

      // Save trigger.py if changed
      if (hasTriggerChanges && activeActivationManager) {
        await activeActivationManager.updateTrigger(folderName, editedTriggerContent);
        setHasTriggerChanges(false);
        // Update the activation object with new trigger content
        setActivation((prev) =>
          prev
            ? {
                ...prev,
                triggerContent: editedTriggerContent,
              }
            : null,
        );
      }

      onActivationUpdated?.();
      toast({
        title: 'Saved',
        description: 'Activation rule saved successfully.',
      });
    } catch (error) {
      console.error('[SkillActivationEditor] Failed to save:', error);
      toast({
        title: 'Save Failed',
        description: 'Failed to save activation rule. Please check the format.',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  }, [
    hasChanges,
    hasRuleChanges,
    hasTriggerChanges,
    activeActivationManager,
    itemInfo.activationFolderName,
    editedRuleContent,
    editedTriggerContent,
    onActivationUpdated,
    toast,
  ]);

  if (isLoading) {
    return (
      <div className="flex h-full flex-1 flex-col bg-background">
        <div className="flex h-[52px] items-center border-b bg-muted/50 px-3">
          <div className="flex-1">
            <h3 className="text-sm font-medium">{itemInfo.filename}</h3>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (!activation || loadError) {
    const isNotFound = loadError?.includes('not found');
    const isInvalidFormat =
      loadError?.includes('Invalid rule.md') || loadError?.includes('Missing') || loadError?.includes('frontmatter');
    const errorTitle = isInvalidFormat ? 'Invalid rule.md Format' : isNotFound ? 'Rule Not Found' : 'Failed to Load';

    return (
      <div className="flex h-full flex-1 flex-col bg-background">
        <div className="flex h-[52px] items-center border-b bg-muted/50 px-3">
          <div className="flex-1">
            <h3 className="text-sm font-medium text-destructive">{errorTitle}</h3>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <div className="max-w-md">
            <p className="text-muted-foreground">{loadError || 'Unknown error loading activation rule'}</p>
            {isInvalidFormat && (
              <p className="mt-2 text-sm text-muted-foreground">
                rule.md files require YAML frontmatter with at least a name field.
              </p>
            )}
            <Button variant="outline" className="mt-4" onClick={() => void loadActivation()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-1 flex-col bg-background">
      {/* Header with metadata */}
      <ActivationMetadataHeader content={editedRuleContent} />

      {/* Tab bar */}
      <div className="flex h-[52px] items-center justify-between border-b bg-muted/50 px-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">{activation.metadata.name}</h3>
          {hasChanges && <span className="text-xs text-muted-foreground">(unsaved changes)</span>}
        </div>

        <div className="flex items-center gap-2">
          {/* View Mode Toggle */}
          <div className="flex rounded-md border">
            <Button
              variant={viewMode === 'rule' ? 'secondary' : 'ghost'}
              size="sm"
              className="rounded-r-none border-r"
              onClick={() => setViewMode('rule')}
              title="Edit rule.md"
            >
              <FileText className="mr-1 h-4 w-4" />
              Rule
            </Button>
            <Button
              variant={viewMode === 'trigger' ? 'secondary' : 'ghost'}
              size="sm"
              className="rounded-none border-r"
              onClick={() => setViewMode('trigger')}
              title="Edit trigger.py"
            >
              <Code className="mr-1 h-4 w-4" />
              Trigger
            </Button>
            <Button
              variant={viewMode === 'evals' ? 'secondary' : 'ghost'}
              size="sm"
              className="rounded-l-none"
              onClick={() => setViewMode('evals')}
              title="Run evaluations"
            >
              <FlaskConical className="mr-1 h-4 w-4" />
              Evals
            </Button>
          </div>

          {/* Save Button */}
          <Button size="sm" onClick={() => void handleSave()} disabled={!hasChanges || isSaving}>
            <Save className={`mr-1 h-4 w-4 ${isSaving ? 'animate-pulse' : ''}`} />
            {isSaving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {viewMode === 'rule' && <ActivationRuleView content={editedRuleContent} onChange={handleRuleContentChange} />}
        {viewMode === 'trigger' && (
          <ActivationTriggerView content={editedTriggerContent} onChange={handleTriggerContentChange} />
        )}
        {viewMode === 'evals' && <ActivationEvalsPanel />}
      </div>
    </div>
  );
}
