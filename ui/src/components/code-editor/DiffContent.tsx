import { DiffEditor, Monaco } from '@monaco-editor/react';
import { shikiToMonaco } from '@shikijs/monaco';
import gitDiffParser, { Change, File as DiffFile, Hunk } from 'gitdiff-parser';
import { GitBranch, HardDrive } from 'lucide-react';
import { editor } from 'monaco-editor';
import { useTheme } from 'next-themes';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { createHighlighter, Highlighter } from 'shiki';

let shikiHighlighter: Highlighter | null = null;
let themeLoadingPromise: Promise<void> | null = null;

interface DiffContentProps {
  diffString: string;
}

export const DiffContent: React.FC<DiffContentProps> = ({ diffString }) => {
  const { resolvedTheme } = useTheme();
  const monacoRef = useRef<Monaco | null>(null);
  const editorInstancesRef = useRef<Map<string, editor.IStandaloneDiffEditor>>(new Map());

  useEffect(() => {
    const editorInstances = editorInstancesRef.current;
    return () => {
      editorInstances.forEach((ed) => {
        try { ed.dispose(); } catch { /* ignore */ }
      });
      editorInstances.clear();
    };
  }, []);

  useEffect(() => {
    if (!themeLoadingPromise) {
      themeLoadingPromise = createHighlighter({ themes: ['dark-plus', 'light-plus'], langs: ['text'] })
        .then((h) => { shikiHighlighter = h; })
        .catch(() => { themeLoadingPromise = null; });
    }
  }, []);

  const handleEditorDidMount = useCallback(
    (diffEditor: editor.IStandaloneDiffEditor, monaco: Monaco, editorKey: string) => {
      editorInstancesRef.current.set(editorKey, diffEditor);
      monacoRef.current = monaco;
      async function setup() {
        if (themeLoadingPromise) await themeLoadingPromise;
        if (!shikiHighlighter) return;
        monaco.languages.register({ id: 'text' });
        shikiToMonaco(shikiHighlighter, monaco);
        monaco.editor.setTheme(resolvedTheme === 'dark' ? 'dark-plus' : 'light-plus');
      }
      void setup();
    },
    [resolvedTheme],
  );

  const renderHunk = useCallback(
    (hunk: Hunk, hunkIndex: number, fileIndex: number) => {
      const editorKey = `file-${fileIndex}-hunk-${hunkIndex}`;
      const originalLines = hunk.changes
        .filter((c: Change) => c.type === 'delete' || c.type === 'normal')
        .map((c: Change) => `${c.type === 'delete' ? '-' : ' '}${c.content}`)
        .join('\n');
      const modifiedLines = hunk.changes
        .filter((c: Change) => c.type === 'insert' || c.type === 'normal')
        .map((c: Change) => `${c.type === 'insert' ? '+' : ' '}${c.content}`)
        .join('\n');
      const hunkHeader = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
      const original = `${hunkHeader}\n${originalLines}`;
      const modified = `${hunkHeader}\n${modifiedLines}`;
      const maxLines = Math.max(original.split('\n').length, modified.split('\n').length) + 1;
      const lineHeight = 20;
      const vPad = 16;
      const height = maxLines * lineHeight + vPad * 2;
      return (
        <div key={editorKey} className="border-t last:border-t-0">
          <div className="bg-muted/50 px-3 py-1 text-xs text-muted-foreground">
            Hunk {hunkIndex + 1}: Lines {hunk.oldStart}–{hunk.oldStart + hunk.oldLines - 1} →{' '}
            {hunk.newStart}–{hunk.newStart + hunk.newLines - 1}
          </div>
          <DiffEditor
            height={`${height}px`}
            language="text"
            original={original}
            modified={modified}
            onMount={(ed, monaco) => { void handleEditorDidMount(ed, monaco, editorKey); }}
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
              padding: { top: vPad, bottom: vPad },
              lineNumbers: 'on',
              glyphMargin: true,
              renderLineHighlight: 'all',
              scrollbar: { alwaysConsumeMouseWheel: false },
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
          case 'add': return `(+) ${fileDiff.newPath}`;
          case 'delete': return `(-) ${fileDiff.oldPath}`;
          case 'rename': return `${fileDiff.oldPath} → ${fileDiff.newPath}`;
          case 'copy': return `${fileDiff.oldPath} → copy → ${fileDiff.newPath}`;
          default: return fileDiff.newPath;
        }
      };
      return (
        <div key={fileIndex} className="overflow-hidden rounded-lg border">
          <div className="border-b bg-muted px-4 py-2 text-sm font-medium">{getFilePath()}</div>
          <div className="grid grid-cols-2 border-b bg-muted/40">
            <div className="flex items-center gap-1.5 border-r px-4 py-1.5">
              <GitBranch className="h-3 w-3 text-muted-foreground" />
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">HEAD</span>
              <span className="ml-1 text-xs text-muted-foreground/60">— before</span>
            </div>
            <div className="flex items-center gap-1.5 px-4 py-1.5">
              <HardDrive className="h-3 w-3 text-muted-foreground" />
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Working Tree</span>
              <span className="ml-1 text-xs text-muted-foreground/60">— current</span>
            </div>
          </div>
          <div className="space-y-2">
            {fileDiff.hunks.map((hunk: Hunk, hunkIndex: number) => renderHunk(hunk, hunkIndex, fileIndex))}
          </div>
        </div>
      );
    },
    [renderHunk],
  );

  const parsedDiff: DiffFile[] = useMemo(() => {
    if (!diffString) return [];
    try { return gitDiffParser.parse(diffString); } catch { return []; }
  }, [diffString]);

  if (parsedDiff.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-muted-foreground">
        No changes to show
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      {parsedDiff.map((fileDiff, fileIndex) => renderFile(fileDiff, fileIndex))}
    </div>
  );
};
