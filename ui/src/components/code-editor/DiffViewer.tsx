import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { ActionInfo, AgenticProcess } from '@sdk';
import { useDockNavigation } from '@src/navigation';
import { useAction } from '@src/hooks/use-action';
import { useProcessCheckpoints } from '@src/hooks/flow-hooks';
import { DiffEditor, Monaco } from '@monaco-editor/react';
import { shikiToMonaco } from '@shikijs/monaco';
import gitDiffParser, { Change, File as DiffFile, Hunk } from 'gitdiff-parser';
import { editor } from 'monaco-editor';
import { useTheme } from 'next-themes';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useParams } from 'react-router';
import { createHighlighter, Highlighter } from 'shiki';

const parseDiff = (diff: string) => gitDiffParser.parse(diff);

interface DiffViewerProps {
  checkpoint_hash: string;
}

let shikiHighlighter: Highlighter | null = null;
let themeLoadingPromise: Promise<void> | null = null;

const DiffViewer: React.FC<DiffViewerProps> = ({ checkpoint_hash }) => {
  const { processId } = useParams();
  const { resolvedTheme } = useTheme();
  const monacoRef = useRef<Monaco | null>(null);
  const editorInstancesRef = useRef<Map<string, editor.IStandaloneDiffEditor>>(new Map());
  const { flow } = useAgentContext();
  const { navigation } = useDockNavigation();
  const { checkpoints, loading: checkpointsLoading } = useProcessCheckpoints(flow);

  // Track component mount/unmount
  useEffect(() => {
    const editorInstances = editorInstancesRef.current;
    return () => {
      // Dispose all editor instances properly
      editorInstances.forEach((editor) => {
        try {
          editor.dispose();
        } catch (err) {
          console.warn('[DiffViewer] Error disposing editor:', err);
        }
      });
      editorInstances.clear();
    };
  }, []);

  const getGitDiffActionInfo = React.useMemo(() => {
    if (!processId || !checkpoint_hash) {
      return null;
    }
    const actionInfo = new ActionInfo('checkpoint-diff', AgenticProcess.type, processId, 'GET');
    actionInfo.queryParameters = { checkpoint_hash };
    return actionInfo;
  }, [processId, checkpoint_hash]);

  const { data: gitDiff, loading: diffLoading, error: diffError } = useAction<string>(getGitDiffActionInfo);
  const parsedDiff: DiffFile[] = useMemo(() => {
    if (!gitDiff) {
      return [];
    }
    try {
      return parseDiff(gitDiff);
    } catch (error) {
      console.error('Error parsing git diff:', gitDiff, error);
      return [];
    }
  }, [gitDiff]);

  // Initialize Shiki highlighter
  useEffect(() => {
    if (!themeLoadingPromise) {
      themeLoadingPromise = createHighlighter({
        themes: ['dark-plus', 'light-plus'],
        langs: ['text'],
      })
        .then((highlighter) => {
          shikiHighlighter = highlighter;
        })
        .catch((error) => {
          console.error('Failed to initialize Shiki highlighter:', error);
          themeLoadingPromise = null;
        });
    }
    // Monaco React handles editor disposal automatically
  }, []);

  const handleEditorDidMount = useCallback(
    (diffEditor: editor.IStandaloneDiffEditor, monaco: Monaco, editorKey: string) => {
      // Track this editor instance
      editorInstancesRef.current.set(editorKey, diffEditor);

      monacoRef.current = monaco;

      async function setupEditor() {
        // Wait for theme loading to complete
        if (themeLoadingPromise) {
          await themeLoadingPromise;
        }

        if (!shikiHighlighter) {
          console.warn('Shiki highlighter not available');
          return;
        }

        monaco.languages.register({ id: 'text' });
        shikiToMonaco(shikiHighlighter, monaco);

        // Set theme with fallback
        const themeName = resolvedTheme === 'dark' ? 'dark-plus' : 'light-plus';
        monaco.editor.setTheme(themeName);
      }
      void setupEditor();
    },
    [resolvedTheme],
  );

  const renderHunk = useCallback(
    (hunk: Hunk, hunkIndex: number, fileIndex: number) => {
      const editorKey = `file-${fileIndex}-hunk-${hunkIndex}`;

      // Create original and modified content for this specific hunk
      const originalLines = hunk.changes
        .filter((change: Change) => change.type === 'delete' || change.type === 'normal')
        .map((change: Change) => {
          const prefix = change.type === 'delete' ? '-' : ' ';
          return `${prefix}${change.content}`;
        })
        .join('\n');

      const modifiedLines = hunk.changes
        .filter((change: Change) => change.type === 'insert' || change.type === 'normal')
        .map((change: Change) => {
          const prefix = change.type === 'insert' ? '+' : ' ';
          return `${prefix}${change.content}`;
        })
        .join('\n');

      // Add hunk header
      const hunkHeader = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
      const originalWithHeader = `${hunkHeader}\n${originalLines}`;
      const modifiedWithHeader = `${hunkHeader}\n${modifiedLines}`;

      // Calculate height based on content lines
      const maxLines = Math.max(originalWithHeader.split('\n').length, modifiedWithHeader.split('\n').length) + 1;
      const lineHeight = 20;
      const vertical_padding = 16;
      const calculatedHeight = maxLines * lineHeight + vertical_padding * 2;

      return (
        <div key={editorKey} className="border-t last:border-t-0">
          <div className="bg-muted/50 px-3 py-1 text-xs text-muted-foreground">
            Hunk {hunkIndex + 1}: Lines {hunk.oldStart}-{hunk.oldStart + hunk.oldLines - 1} → {hunk.newStart}-
            {hunk.newStart + hunk.newLines - 1}
          </div>
          <DiffEditor
            height={`${calculatedHeight}px`}
            language="text"
            original={originalWithHeader}
            modified={modifiedWithHeader}
            onMount={(editor, monaco) => {
              void handleEditorDidMount(editor, monaco, editorKey);
            }}
            theme={resolvedTheme === 'dark' ? 'dark-plus' : 'light-plus'}
            options={{
              renderSideBySide: true,
              readOnly: true,
              fontSize: 14,
              lineHeight,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap: 'on',
              padding: { top: vertical_padding, bottom: vertical_padding },
              lineNumbers: 'on',
              glyphMargin: true,
              renderLineHighlight: 'all',
              scrollbar: {
                alwaysConsumeMouseWheel: false,
              },
            }}
          />
        </div>
      );
    },
    [handleEditorDidMount, resolvedTheme],
  );

  const renderFile = useCallback(
    (fileDiff: DiffFile, fileIndex: number) => {
      const getFilePath = () => {
        switch (fileDiff.type) {
          case 'add':
            return `(+) ${fileDiff.newPath}`;
          case 'delete':
            return `(-) ${fileDiff.oldPath}`;
          case 'rename':
            return `${fileDiff.oldPath} -> ${fileDiff.newPath}`;
          case 'copy':
            return `${fileDiff.oldPath} -> copy -> ${fileDiff.newPath}`;
          case 'modify':
          default:
            return fileDiff.newPath;
        }
      };

      return (
        <div key={fileIndex} className="overflow-hidden rounded-lg border">
          <div className="border-b bg-muted px-4 py-2 text-sm font-medium">{getFilePath()}</div>
          <div className="space-y-2">
            {fileDiff.hunks.map((hunk: Hunk, hunkIndex: number) => renderHunk(hunk, hunkIndex, fileIndex))}
          </div>
        </div>
      );
    },
    [renderHunk],
  );

  const handleCheckpointChange = useCallback(
    (selectedCheckpointHash: string) => {
      if (selectedCheckpointHash && selectedCheckpointHash !== checkpoint_hash) {
        navigation.openDiff(selectedCheckpointHash);
      }
    },
    [checkpoint_hash, navigation],
  );

  // Build selector options - always show current checkpoint, add others if available
  const selectorOptions = useMemo(() => {
    const currentCheckpointInList = checkpoints.find((cp) => cp.checkpointHash === checkpoint_hash);

    // If checkpoints loaded and current checkpoint is in the list, use the list
    if (!checkpointsLoading && currentCheckpointInList) {
      return checkpoints;
    }

    // Otherwise, create a minimal option for the current checkpoint
    if (checkpoint_hash) {
      const currentOption = {
        checkpointHash: checkpoint_hash,
        timestamp: new Date(),
        index: 1,
        timeAgo: 'current',
      };

      // If checkpoints loaded but current not in list, add it at the beginning
      if (!checkpointsLoading && checkpoints.length > 0) {
        return [currentOption, ...checkpoints];
      }

      // Otherwise just show current
      return [currentOption];
    }

    return checkpoints;
  }, [checkpoint_hash, checkpoints, checkpointsLoading]);

  return (
    <div className="flex h-full flex-col">
      {/* Header with checkpoint selector - show if we have a checkpoint */}
      {checkpoint_hash && selectorOptions.length > 0 && (
        <div className="border-b bg-background px-4 py-3">
          <div className="flex items-center gap-3">
            <label htmlFor="checkpoint-selector" className="text-sm font-medium">
              Checkpoint:
            </label>
            <select
              id="checkpoint-selector"
              value={checkpoint_hash}
              onChange={(e) => handleCheckpointChange(e.target.value)}
              className="flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              disabled={selectorOptions.length <= 1}
            >
              {selectorOptions.map((cp) => {
                // Format: "#1 - 2 hours ago (abc123...)"
                const shortHash = cp.checkpointHash.substring(0, 7);
                const label = `#${cp.index} - ${cp.timeAgo} (${shortHash})`;
                return (
                  <option key={cp.checkpointHash} value={cp.checkpointHash}>
                    {label}
                  </option>
                );
              })}
            </select>
          </div>
        </div>
      )}

      {/* Diff content */}
      <div key={checkpoint_hash} className="flex-1 overflow-auto pb-8">
        {diffLoading ? (
          <div className="flex h-full items-center justify-center p-4 text-muted-foreground">
            <div className="flex flex-col items-center gap-2">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-muted-foreground border-t-transparent"></div>
              <span>Loading checkpoint diff...</span>
            </div>
          </div>
        ) : diffError ? (
          <div className="flex h-full items-center justify-center p-4 text-destructive">
            Error loading checkpoint: {diffError.message || 'Checkpoint not found'}
          </div>
        ) : parsedDiff.length > 0 ? (
          <div className="space-y-4 p-4">
            {parsedDiff.map((fileDiff, fileIndex) => renderFile(fileDiff, fileIndex))}
          </div>
        ) : gitDiff ? (
          <div className="flex h-full items-center justify-center p-4 text-muted-foreground">
            <div className="rounded-lg border bg-muted/50 px-6 py-4 text-center">
              <pre className="whitespace-pre-wrap text-sm">{gitDiff}</pre>
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-4 text-muted-foreground">No changes to show</div>
        )}
      </div>
    </div>
  );
};

export default DiffViewer;
