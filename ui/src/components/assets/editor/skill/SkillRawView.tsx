import Editor, { Monaco } from '@monaco-editor/react';
import { shikiToMonaco } from '@shikijs/monaco';
import { editor } from 'monaco-editor';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useState } from 'react';
import { createHighlighter, Highlighter } from 'shiki';

let shikiHighlighter: Highlighter | null = null;
let shikiInitPromise: Promise<Highlighter> | null = null;

function getOrCreateHighlighter(): Promise<Highlighter> {
  if (shikiHighlighter) return Promise.resolve(shikiHighlighter);
  if (!shikiInitPromise) {
    shikiInitPromise = createHighlighter({
      themes: ['dark-plus', 'light-plus'],
      langs: ['markdown'],
    }).then((h) => {
      shikiHighlighter = h;
      return h;
    });
  }
  return shikiInitPromise;
}

interface SkillRawViewProps {
  content: string;
  onChange: (content: string) => void;
}

export function SkillRawView({ content, onChange }: SkillRawViewProps) {
  const { resolvedTheme } = useTheme();
  const [isShikiReady, setIsShikiReady] = useState(!!shikiHighlighter);

  useEffect(() => {
    if (isShikiReady) return;
    void getOrCreateHighlighter().then(() => setIsShikiReady(true));
  }, [isShikiReady]);

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (value !== undefined) {
        onChange(value);
      }
    },
    [onChange],
  );

  const handleEditorDidMount = useCallback(
    (_editorInstance: editor.IStandaloneCodeEditor, monaco: Monaco) => {
      if (shikiHighlighter) {
        shikiToMonaco(shikiHighlighter, monaco);
        monaco.editor.setTheme(resolvedTheme === 'dark' ? 'dark-plus' : 'light-plus');
      }
    },
    [resolvedTheme],
  );

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <div className="flex h-8 flex-shrink-0 items-center border-b bg-muted/30 px-3">
        <span className="text-xs text-muted-foreground">SKILL.md</span>
      </div>
      <div className="min-h-0 flex-1">
        {!isShikiReady ? (
          <div className="flex h-full items-center justify-center">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : (
          <Editor
            height="100%"
            defaultLanguage="markdown"
            value={content}
            onChange={handleEditorChange}
            onMount={handleEditorDidMount}
            theme={resolvedTheme === 'dark' ? 'dark-plus' : 'light-plus'}
            options={{
              minimap: { enabled: false },
              fontSize: 13,
              lineNumbers: 'on',
              wordWrap: 'on',
              scrollBeyondLastLine: false,
              renderWhitespace: 'selection',
              tabSize: 2,
              automaticLayout: true,
            }}
          />
        )}
      </div>
    </div>
  );
}
