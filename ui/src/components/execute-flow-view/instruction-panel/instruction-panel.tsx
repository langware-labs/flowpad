import { copyToClipboard } from '@sdk';
import { Button } from '@src/components/ui/button';
import { Progress } from '@src/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@src/components/ui/tooltip';
import { toast } from '@src/hooks/use-toast';
import Editor from '@monaco-editor/react';
import { Copy, FileText, FilePlus, Loader2, Pencil, Save, X } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { InstructionExecutionContext } from '../types';
import { EphemeralPromptInput } from './ephemeral-prompt-input';
import { ExecutionControls } from './execution-controls';
import { InstructionList } from './instruction-list';

interface InstructionPanelProps {
  context: InstructionExecutionContext | null;
  fileContent: string | null;
  isLoading?: boolean;
  onExecute: () => void;
  onExecuteEphemeralPrompt: (content: string) => void;
  onNewEphemeral: () => void;
  onSaveFile: (content: string) => Promise<void>;
  onStop: () => void;
  onRetry: (instructionId: string) => void;
  onSkip: (instructionId: string) => void;
  onToggleExpand: (instructionId: string) => void;
}

export function InstructionPanel({
  context,
  fileContent,
  isLoading,
  onExecute,
  onExecuteEphemeralPrompt,
  onNewEphemeral,
  onSaveFile,
  onStop,
  onRetry,
  onSkip,
  onToggleExpand,
}: InstructionPanelProps): JSX.Element {
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const { resolvedTheme } = useTheme();
  const filePath = context?.filePath;

  // Reset to execution view when navigating between files
  useEffect(() => {
    setIsEditing(false);
    setEditContent('');
  }, [filePath]);

  const fileName = useMemo(() => {
    if (!filePath) return '';
    const parts = filePath.split('/');
    return parts[parts.length - 1] || filePath;
  }, [filePath]);

  const handleCopyPath = useCallback(() => {
    if (filePath) {
      void copyToClipboard(filePath);
      toast.success('Path copied', { description: 'File path copied to clipboard' });
    }
  }, [filePath]);

  const handleStartEdit = useCallback(() => {
    if (fileContent !== null) {
      setEditContent(fileContent);
      setIsEditing(true);
    }
  }, [fileContent]);

  const handleCancelEdit = useCallback(() => {
    setIsEditing(false);
    setEditContent('');
  }, []);

  const handleSaveEdit = useCallback(async () => {
    try {
      await onSaveFile(editContent);
      setIsEditing(false);
      toast.success('File saved', { description: 'Changes saved successfully' });
    } catch (error) {
      console.error('[InstructionPanel] Failed to save:', error);
      toast.error('Save failed', { description: 'Could not save changes' });
    }
  }, [editContent, onSaveFile]);

  if (isLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span className="text-sm">Loading file...</span>
      </div>
    );
  }

  if (!context) {
    return <EphemeralPromptInput onSave={onExecuteEphemeralPrompt} />;
  }

  const { status, progress, rootInstructions, currentInstructionId } = context;
  const progressPercent = progress.total > 0 ? (progress.completed / progress.total) * 100 : 0;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b p-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <FileText className="h-4 w-4 flex-shrink-0" />
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-help truncate">{fileName}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-md">
              <div className="flex items-center gap-2">
                <span className="break-all text-xs">{filePath}</span>
                <Button variant="ghost" size="sm" className="h-6 w-6 flex-shrink-0 p-0" onClick={handleCopyPath}>
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
            </TooltipContent>
          </Tooltip>
          {!isEditing && (
            <div className="ml-auto flex gap-1">
              {fileContent !== null && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={handleStartEdit}>
                      <Pencil className="h-3 w-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Edit file</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onNewEphemeral}>
                    <FilePlus className="h-3 w-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>New prompt</TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
        {!isEditing && (
          <>
            <div className="mt-2 text-xs text-muted-foreground">
              {progress.completed} / {progress.total} instructions completed
              {progress.failed > 0 && ` · ${progress.failed} failed`}
            </div>
            <Progress value={progressPercent} className="mt-2 h-1" />
          </>
        )}
      </div>
      {isEditing ? (
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex-1">
            <Editor
              height="100%"
              language="markdown"
              value={editContent}
              onChange={(value) => setEditContent(value ?? '')}
              theme={resolvedTheme === 'dark' ? 'dark-plus' : 'light-plus'}
              options={{
                fontSize: 13,
                lineHeight: 20,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                automaticLayout: true,
                wordWrap: 'on',
                padding: { top: 8, bottom: 8 },
                lineNumbers: 'on',
                folding: true,
              }}
            />
          </div>
          <div className="flex justify-end gap-2 border-t p-2">
            <Button variant="ghost" size="sm" onClick={handleCancelEdit}>
              <X className="mr-1 h-3 w-3" />
              Cancel
            </Button>
            <Button size="sm" onClick={() => void handleSaveEdit()}>
              <Save className="mr-1 h-3 w-3" />
              Save
            </Button>
          </div>
        </div>
      ) : (
        <>
          <ExecutionControls
            status={status}
            onExecute={onExecute}
            onStop={onStop}
            disabled={rootInstructions.length === 0}
          />
          <div className="flex-1 overflow-hidden">
            <InstructionList
              instructions={rootInstructions}
              currentInstructionId={currentInstructionId}
              onRetry={onRetry}
              onSkip={onSkip}
              onToggleExpand={onToggleExpand}
            />
          </div>
        </>
      )}
    </div>
  );
}
