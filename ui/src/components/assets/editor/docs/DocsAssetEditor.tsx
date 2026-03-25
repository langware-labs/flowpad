import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { fsManager, VFSPath } from '@sdk';
import { MilkdownEditor } from '@src/components/milkdown-editor/MilkdownEditor';
import { Button } from '@src/components/ui/button';
import { useToast } from '@src/hooks/use-toast';
import { RefreshCw, Save } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

interface DocsAssetEditorProps {
  /** Absolute path to a .md file */
  sourcePath: string;
}

/**
 * Simple Milkdown viewer/editor for a docs markdown file.
 * Loads content from the filesystem and saves back via fsManager.writeFile().
 */
export function DocsAssetEditor({ sourcePath }: DocsAssetEditorProps) {
  const { computeNode } = useAgentContext();
  const { toast } = useToast();
  const [content, setContent] = useState('');
  const [editedContent, setEditedContent] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const filename = sourcePath ? sourcePath.split('/').pop() ?? sourcePath : '';

  const loadContent = useCallback(async () => {
    if (!sourcePath || !computeNode?.typeId) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const vfsPath = VFSPath.fromMachinePath(sourcePath, computeNode.typeId);
      const raw = (await fsManager.download(computeNode.typeId, vfsPath.entitySubPath)) as string;
      setContent(raw);
      setEditedContent(raw);
      setHasChanges(false);
    } catch (err) {
      console.error('[DocsAssetEditor] Failed to load:', err);
      setLoadError(err instanceof Error ? err.message : 'Failed to load file');
    } finally {
      setIsLoading(false);
    }
  }, [sourcePath, computeNode?.typeId]);

  useEffect(() => {
    void loadContent();
  }, [loadContent]);

  const handleChange = useCallback(
    (newContent: string) => {
      setEditedContent(newContent);
      setHasChanges(newContent !== content);
    },
    [content],
  );

  const handleSave = useCallback(async () => {
    if (!hasChanges || !computeNode?.typeId) return;
    setIsSaving(true);
    try {
      const vfsPath = VFSPath.fromMachinePath(sourcePath, computeNode.typeId);
      await fsManager.writeFile(computeNode.typeId, vfsPath.entitySubPath, editedContent);
      setContent(editedContent);
      setHasChanges(false);
    } catch (err) {
      console.error('[DocsAssetEditor] Failed to save:', err);
      toast({ title: 'Save Failed', variant: 'destructive' });
    } finally {
      setIsSaving(false);
    }
  }, [hasChanges, computeNode?.typeId, sourcePath, editedContent, toast]);

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-[52px] flex-shrink-0 items-center border-b bg-muted/50 px-3">
          <h3 className="text-sm font-medium">{filename}</h3>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-[52px] flex-shrink-0 items-center border-b bg-muted/50 px-3">
          <h3 className="text-sm font-medium text-destructive">Failed to Load</h3>
        </div>
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <div>
            <p className="text-muted-foreground">{loadError}</p>
            <Button variant="outline" className="mt-4" onClick={() => void loadContent()}>
              <RefreshCw className="mr-2 h-4 w-4" /> Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex h-[52px] flex-shrink-0 items-center justify-between border-b bg-muted/50 px-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">{filename}</h3>
          {hasChanges && <span className="text-xs text-muted-foreground">(unsaved)</span>}
        </div>
        <Button size="sm" onClick={() => void handleSave()} disabled={!hasChanges || isSaving}>
          <Save className={`mr-1 h-4 w-4 ${isSaving ? 'animate-pulse' : ''}`} />
          {isSaving ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <MilkdownEditor content={editedContent} onChange={handleChange} />
      </div>
    </div>
  );
}
