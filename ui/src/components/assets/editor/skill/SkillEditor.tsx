import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import {
  ComputeNode,
  FSItem,
  fsManager,
  Skill,
  SkillLoadError,
  SkillManager,
  SkillParseError,
} from '@sdk';
import { Button } from '@src/components/ui/button';
import { useToast } from '@src/hooks/use-toast';
import { Code, Eye, RefreshCw, Save } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { SkillMarkdownView } from './SkillMarkdownView';
import { SkillRawView } from './SkillRawView';
import { SkillsScope } from './skillEditorUtils';

interface SkillEditorProps {
  item: FSItem;
  userSkillManager?: SkillManager;
  projectSkillManager?: SkillManager;
  systemSkillManager?: SkillManager;
  onSkillUpdated?: () => void;
}

type ViewMode = 'raw' | 'markdown';

export function SkillEditor({
  item,
  userSkillManager,
  projectSkillManager,
  systemSkillManager,
  onSkillUpdated,
}: SkillEditorProps) {
  const { project, computeNode } = useAgentContext();
  const { toast } = useToast();
  const [skill, setSkill] = useState<Skill | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('markdown');
  const [editedContent, setEditedContent] = useState('');
  const [hasChanges, setHasChanges] = useState(false);

  // Derive scope from FSItem's entity type and path
  // System skills: ComputeNode.type with path containing .flow/system_skills
  // User skills: ComputeNode.type (not system skills)
  // Project skills: Project.type
  const scope = useMemo((): SkillsScope => {
    const isSystemSkills = item.vfs_abs_path.includes('.flow/system_skills');
    if (item.vfs_entity_type === ComputeNode.type) {
      return isSystemSkills ? SkillsScope.System : SkillsScope.User;
    }
    // Default to project scope for Project type or others
    return SkillsScope.Project;
  }, [item.vfs_entity_type, item.vfs_abs_path]);

  // Derive item properties from FSItem
  // item.is_dir is the source of truth for whether this is a directory
  const itemInfo = useMemo(() => {
    const entityPath = item.vfsPath.entitySubPath;
    const filename = item.vfsPath.filename;
    const isDir = item.is_dir;

    // For directories, we treat them as skill folders (will load SKILL.md inside)
    // For files, we load the file directly
    const isSkillMd = isDir || filename.toLowerCase() === 'skill.md';
    const isJsonFile = filename.toLowerCase().endsWith('.json');

    // Get the full path from entitySubPath
    const fullPath = entityPath;

    return {
      filename,
      fullPath,
      isDir,
      isSkillMd,
      isJsonFile,
    };
  }, [item]);

  // Determine the correct typeId for file operations based on scope
  const fsTypeId = useMemo(() => {
    if ((scope === SkillsScope.User || scope === SkillsScope.System) && computeNode?.typeId) {
      return computeNode.typeId;
    }
    if (scope === SkillsScope.Project && project?.typeId) {
      return project.typeId;
    }
    // Fallback
    return project?.typeId;
  }, [scope, computeNode?.typeId, project?.typeId]);

  // Select the appropriate SkillManager based on scope
  const activeSkillManager = useMemo(() => {
    if (scope === SkillsScope.User) {
      return userSkillManager || null;
    }
    if (scope === SkillsScope.System) {
      return systemSkillManager || null;
    }
    if (scope === SkillsScope.Project) {
      return projectSkillManager || null;
    }
    return null;
  }, [scope, userSkillManager, projectSkillManager, systemSkillManager]);

  const loadSkill = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      if (itemInfo.isDir) {
        // Directory - load SKILL.md from inside using SkillManager
        if (!activeSkillManager) {
          setLoadError('No skill manager available');
          setSkill(null);
          return;
        }

        // Extract folder name from path (last segment)
        const folderName = itemInfo.filename;
        const loadedSkill = await activeSkillManager.get(folderName);
        setSkill(loadedSkill);
        if (loadedSkill) {
          setEditedContent(loadedSkill.rawContent);
          setHasChanges(false);
          setViewMode('markdown'); // Use markdown mode for SKILL.md
        }
      } else {
        // File - load directly using fsManager
        if (!fsTypeId) {
          setLoadError('No file system context available');
          setSkill(null);
          return;
        }

        // Use the full path from VFSPath
        const filePath = itemInfo.fullPath;
        const content = (await fsManager.download(fsTypeId, filePath)) as string;

        // Create a minimal skill object for display
        setSkill({
          path: item.vfsPath.parent.entitySubPath,
          folderName: '',
          metadata: { name: itemInfo.filename, description: '', allowedTools: [], tags: [], extra: {} },
          content: content,
          rawContent: content,
        } as Skill);

        setEditedContent(content);
        setHasChanges(false);
        // JSON files default to raw view; markdown files use milkdown editor
        setViewMode(itemInfo.isJsonFile ? 'raw' : 'markdown');
      }
    } catch (error) {
      console.error('[SkillEditor] Failed to load file:', error);
      // SkillManager throws SkillLoadError (file not found) or SkillParseError (invalid format)
      if (error instanceof SkillLoadError || error instanceof SkillParseError) {
        setLoadError(error.message);
      } else {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        setLoadError(`Failed to load file: ${errorMessage}`);
      }
      setSkill(null);
    } finally {
      setIsLoading(false);
    }
  }, [itemInfo, fsTypeId, activeSkillManager, item.vfsPath]);

  useEffect(() => {
    void loadSkill();
  }, [loadSkill]);

  const handleContentChange = useCallback(
    (newContent: string) => {
      setEditedContent(newContent);
      setHasChanges(newContent !== skill?.rawContent);
    },
    [skill?.rawContent],
  );

  const handleSave = useCallback(async () => {
    if (!hasChanges) return;

    setIsSaving(true);
    try {
      if (itemInfo.isDir) {
        // Save SKILL.md using SkillManager
        const folderName = itemInfo.filename;
        const updatedSkill = (await activeSkillManager?.update(folderName, editedContent)) ?? null;
        setSkill(updatedSkill);
        setHasChanges(false);
        onSkillUpdated?.();
      } else {
        // Save file directly using fsManager
        if (!fsTypeId) {
          console.warn('[SkillEditor] No typeId available for saving file');
          return;
        }

        const filePath = itemInfo.fullPath;
        await fsManager.writeFile(fsTypeId, filePath, editedContent);

        // Update the skill object with new content
        setSkill((prev) =>
          prev
            ? {
                ...prev,
                content: editedContent,
                rawContent: editedContent,
              }
            : null,
        );
        setHasChanges(false);
        onSkillUpdated?.();
      }
    } catch (error) {
      console.error('[SkillEditor] Failed to save file:', error);
      toast({
        title: 'Save Failed',
        description: itemInfo.isDir
          ? 'Failed to save skill. Please check the SKILL.md format.'
          : 'Failed to save file.',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  }, [activeSkillManager, itemInfo, editedContent, hasChanges, onSkillUpdated, fsTypeId, toast]);

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

  if (!skill || loadError) {
    // Determine error type from message
    const isNotFound = loadError?.includes('not found');
    const isInvalidFormat =
      loadError?.includes('Invalid SKILL.md') || loadError?.includes('Missing') || loadError?.includes('frontmatter');
    const errorTitle = isInvalidFormat ? 'Invalid SKILL.md Format' : isNotFound ? 'Skill Not Found' : 'Failed to Load';

    return (
      <div className="flex h-full flex-1 flex-col bg-background">
        <div className="flex h-[52px] items-center border-b bg-muted/50 px-3">
          <div className="flex-1">
            <h3 className="text-sm font-medium text-destructive">{errorTitle}</h3>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <div className="max-w-md">
            <p className="text-muted-foreground">{loadError || 'Unknown error loading skill'}</p>
            {isInvalidFormat && (
              <p className="mt-2 text-sm text-muted-foreground">
                SKILL.md files require YAML frontmatter with at least a name and description field.
              </p>
            )}
            <Button variant="outline" className="mt-4" onClick={() => void loadSkill()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full flex-1 flex-col overflow-hidden bg-background">
      {/* Header - fixed at top, doesn't scroll with content */}
      <div className="flex h-[52px] flex-shrink-0 items-center justify-between border-b bg-muted/50 px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h3 className="truncate text-sm font-medium">{skill.metadata.name}</h3>
          {hasChanges && <span className="flex-shrink-0 text-xs text-muted-foreground">(unsaved changes)</span>}
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          {/* View Mode Toggle */}
          <div className="flex rounded-md border">
            <Button
              variant={viewMode === 'markdown' ? 'secondary' : 'ghost'}
              size="sm"
              className="rounded-r-none border-r"
              onClick={() => setViewMode('markdown')}
              title="Rich text editor"
            >
              <Eye className="mr-1 h-4 w-4" />
              Editor
            </Button>
            <Button
              variant={viewMode === 'raw' ? 'secondary' : 'ghost'}
              size="sm"
              className="rounded-l-none"
              onClick={() => setViewMode('raw')}
              title="Markdown source"
            >
              <Code className="mr-1 h-4 w-4" />
              Markdown
            </Button>
          </div>

          {/* Save Button */}
          <Button size="sm" onClick={() => void handleSave()} disabled={!hasChanges || isSaving}>
            <Save className={`mr-1 h-4 w-4 ${isSaving ? 'animate-pulse' : ''}`} />
            {isSaving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>

      {/* Content - scrollable area */}
      <div className="min-h-0 flex-1 overflow-auto">
        {viewMode === 'raw' && <SkillRawView content={editedContent} onChange={handleContentChange} />}
        {viewMode === 'markdown' && <SkillMarkdownView content={editedContent} onChange={handleContentChange} />}
      </div>
    </div>
  );
}
