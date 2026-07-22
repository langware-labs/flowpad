import { CUSTOM_VIEW, isCustomViewAvailable } from '@src/constants/editor';
import { MilkdownEditor } from '@src/components/milkdown-editor/MilkdownEditor';
import {
  copyToClipboard,
  downloadFile,
  EditorLanguage,
  /* FSItem, */ fsStore,
  isImagePath,
  VFSPath,
} from '@sdk';
import { useContext, useProject } from '@sdk/react/hooks';
import { Button } from '@src/components/ui/button';
import { useFS } from '@src/hooks/useFS';
import Editor, { Monaco } from '@monaco-editor/react';
import { shikiToMonaco } from '@shikijs/monaco';
import { Copy, Download, Eye, Play, /* PlayCircle, */ RefreshCw } from 'lucide-react';
import { editor } from 'monaco-editor';
import { useTheme } from 'next-themes';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createHighlighter, Highlighter } from 'shiki';
import { useLingui } from '@lingui/react/macro';

const SAVE_TIMEOUT = 1000; // 1 second

const LANGUAGE_COMMANDS = {
  python: 'python',
  javascript: 'bun',
  typescript: 'bun',
  shell: '',
} as const;

const isExecutableScript = (language: string) => {
  return language in LANGUAGE_COMMANDS;
};

/**
 * TODO: How do we want to sync the editor changes into the agent if at all?
 *
 * Placeholder for notifying the agent about file changes.
 * This could be used to:
 * - Update agent context with file changes
 * - Keep agent state in sync with file system
 *
 * @param operation - The type of operation (e.g., 'write', 'delete')
 * @param path - The file path that changed
 * @param content - The new content (for write operations)
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const notifyAgentOnChange = (_operation: string, _path: string, _content?: string) => {
  // Empty placeholder - design TBD
};

interface EditorFileData {
  path: string;
  content?: string;
  blob?: Blob;
  language: EditorLanguage;
}

interface EditorPaneProps {
  file?: EditorFileData;
  readOnly?: boolean;
  /**
   * 1-indexed line to reveal on open, from the dock's `?line=` option. A deep
   * link into a file (e.g. an interface block's "Open in editor") lands here.
   */
  revealLine?: number | null;
  onExecuteScript?: () => void;
  onShellCmd?: (command: string) => void;
  onDirtyChange?: (isDirty: boolean) => void;
}

let shikiHighlighter: Highlighter | null = null;

export const EditorPane: React.FC<EditorPaneProps> = ({
  file,
  readOnly,
  revealLine,
  onExecuteScript,
  onShellCmd,
  onDirtyChange,
}) => {
  const { t } = useLingui();
  const { agenticProcess } = useContext();
  const { project } = useProject();
  // const { navigation } = useDockNavigation();

  // Parse file path to extract typeId (if present) for cross-context file loading
  const parsedFilePath = useMemo(() => VFSPath.parse(file?.path), [file?.path]);
  // Use typeId from path if available, otherwise fall back to project's typeId
  const effectiveTypeId = useMemo(
    () => parsedFilePath.typeId ?? project?.typeId,
    [parsedFilePath.typeId, project?.typeId],
  );
  // The actual file path within the entity (without typeId prefix)
  const effectiveFilePath = useMemo(() => {
    if (!parsedFilePath.typeId) return file?.path;
    const subPath = parsedFilePath.entitySubPath;
    return subPath.startsWith('/') ? subPath : `/${subPath}`;
  }, [parsedFilePath.typeId, parsedFilePath.entitySubPath, file?.path]);

  const fs = useFS(effectiveTypeId);

  // Images are binary: render them inline via the backend download URL instead
  // of decoding the bytes as text into Monaco (which shows garbage).
  const isImage = useMemo(
    () => isImagePath(effectiveFilePath || file?.path || ''),
    [effectiveFilePath, file?.path],
  );
  const imageUrl = useMemo(
    () => (isImage && effectiveFilePath && fs ? fs.getDownloadUrl(effectiveFilePath) : null),
    [isImage, effectiveFilePath, fs],
  );

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const { resolvedTheme } = useTheme();
  const [isExecuting, setIsExecuting] = useState(false);
  const [isCustomView, setIsCustomView] = useState(isCustomViewAvailable(file?.language || ''));
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Sync custom-view default when the file (or its language) changes
  useEffect(() => {
    setIsCustomView(isCustomViewAvailable(file?.language || ''));
  }, [file?.path, file?.language]);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingExecuteRef = useRef<null | { language: string; filePath: string }>(null);

  // Get content from FSStore (reactive) - NO fallback to props
  // History is completely decoupled from editor
  // Use effectiveFilePath for FS operations (path without typeId prefix)
  const cached = effectiveFilePath && effectiveTypeId ? fs?.content(effectiveFilePath) : null;
  const fileContent = (cached?.content as string) || '';
  const isDirty = cached?.isDirty || false;

  // Auto-download file content if not in cache
  useEffect(() => {
    if (!effectiveFilePath || !effectiveTypeId) return;

    // Images are streamed straight from the download URL into an <img>; never
    // pull their bytes as text.
    if (isImage) return;

    // Check if content is already cached
    if (cached) {
      return;
    }

    // Download file content from server
    const downloadContent = async () => {
      if (!fs) return;
      try {
        await fs.download(effectiveFilePath, false);
      } catch (error) {
        console.error('[EditorPane] ❌ Error downloading content:', effectiveFilePath, error);
      }
    };

    void downloadContent();
  }, [effectiveFilePath, effectiveTypeId, cached, fs]);

  const setIsDirty = useCallback(
    (dirty: boolean) => {
      onDirtyChange?.(dirty);
    },
    [onDirtyChange],
  );

  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const userScrollRef = useRef(false);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const editorDomNode = editor.getDomNode();
    if (!editorDomNode) return;

    let lastUserScrollTime = 0;

    const markUserScroll = () => {
      lastUserScrollTime = Date.now();
    };

    const isEditorAtBottom = () => {
      const scrollTop = editor.getScrollTop();
      const scrollHeight = editor.getScrollHeight();
      const clientHeight = editor.getDomNode()?.clientHeight ?? 0;
      return scrollTop + clientHeight >= scrollHeight - 10;
    };

    editorDomNode.addEventListener('wheel', markUserScroll);
    editorDomNode.addEventListener('pointerdown', markUserScroll);
    editorDomNode.addEventListener('touchstart', markUserScroll);

    const scrollDisposable = editor.onDidScrollChange(() => {
      const timeSince = Date.now() - lastUserScrollTime;

      if (timeSince < 150 && !isEditorAtBottom()) {
        userScrollRef.current = true;
        setIsUserScrolling(true);
        return;
      }

      if (isEditorAtBottom() && userScrollRef.current) {
        userScrollRef.current = false;
        setIsUserScrolling(false);
      }
    });

    return () => {
      scrollDisposable.dispose();
      editorDomNode.removeEventListener('wheel', markUserScroll);
      editorDomNode.removeEventListener('pointerdown', markUserScroll);
      editorDomNode.removeEventListener('touchstart', markUserScroll);
    };
  }, [file]);

  // A deep link is honoured once per (file, line): re-revealing on every content
  // change would fight the user as they scroll away from it.
  const revealedRef = useRef<string | null>(null);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;

    // An explicit line wins over the tail-follow below. Without this the
    // `revealLine(getLineCount())` call would scroll a deep link straight to
    // the bottom of the file the moment content settled.
    if (revealLine && revealLine > 0) {
      const key = `${file?.path ?? ''}#${revealLine}`;
      if (revealedRef.current === key) return;
      const line = Math.min(revealLine, model.getLineCount());
      editor.revealLineInCenter(line);
      editor.setPosition({ lineNumber: line, column: 1 });
      revealedRef.current = key;
      return;
    }

    if (isUserScrolling) return;
    editor.revealLine(model.getLineCount());
  }, [file, file?.content, isUserScrolling, revealLine]);

  const clearSaveTimeout = useCallback(() => {
    if (!saveTimeoutRef.current) return;
    clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = null;
  }, []);

  const executeScript = useCallback(
    (language: string, filePath: string) => {
      if (!agenticProcess) return;

      setIsExecuting(true);

      try {
        onExecuteScript?.();

        const command = LANGUAGE_COMMANDS[language as keyof typeof LANGUAGE_COMMANDS] || '';
        const shellCommand = command ? `${command} ${filePath}` : filePath.includes('/') ? filePath : `./${filePath}`;

        // Notify parent about shell command
        onShellCmd?.(shellCommand);
      } catch (error) {
        console.error('Error executing script:', error);
      } finally {
        setIsExecuting(false);
      }
    },
    [agenticProcess, onExecuteScript, onShellCmd],
  );

  const handleEditorDidMount = (editor: editor.IStandaloneCodeEditor, monaco: Monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    if (!file) return;

    async function setupEditor(language: EditorLanguage) {
      if (!shikiHighlighter) {
        shikiHighlighter = await createHighlighter({
          themes: ['dark-plus', 'light-plus'],
          langs: [language],
        });
      } else {
        await shikiHighlighter.loadLanguage(language);
      }
      monaco.languages.register({ id: language });
      shikiToMonaco(shikiHighlighter, monaco);
      editor.updateOptions({
        fontSize: 14,
        lineHeight: 20,
        minimap: { enabled: true },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        wordWrap: 'on',
        theme: resolvedTheme === 'dark' ? 'dark-plus' : 'light-plus',
        readOnly: readOnly,
      });
    }
    void setupEditor(file.language);
  };

  // Cleanup Monaco Editor on unmount
  useEffect(() => {
    return () => {
      if (editorRef.current) {
        editorRef.current.dispose();
      }
    };
  }, []);

  // Stable onChange handler — uses a ref so MilkdownEditor's useEditor (which
  // depends on [onChange]) doesn't re-initialize and lose focus on every keystroke.
  const handleContentChangeRef = useRef<(value: string | undefined) => void>();
  handleContentChangeRef.current = (value: string | undefined) => {
    if (value === undefined || !file || !effectiveFilePath || value === fileContent) {
      return;
    }

    clearSaveTimeout();

    // Update FSStore with new content (mark as dirty for local edits)
    if (!fs) return;
    fs.setContent(effectiveFilePath, value, true);
    setIsDirty(true);

    // Auto-save after SAVE_TIMEOUT of inactivity
    saveTimeoutRef.current = setTimeout(() => {
      void handleSaveFile();
    }, SAVE_TIMEOUT);
  };
  const handleContentChange = useCallback((value: string | undefined) => {
    handleContentChangeRef.current?.(value);
  }, []);

  const handleExecuteScript = (language: string, filePath: string) => {
    if (isDirty) {
      pendingExecuteRef.current = { language, filePath };
      return;
    }
    void executeScript(language, filePath);
  };

  const handleRefreshFile = useCallback(async () => {
    if (!agenticProcess || !file || !fs || !effectiveFilePath) return;

    setIsRefreshing(true);
    try {
      // Invalidate cache to force re-fetch
      fs.invalidate(effectiveFilePath, 'content');

      // Download fresh content from server
      await fs.download(effectiveFilePath, false);
    } catch (error) {
      console.error('[EditorPane] Error refreshing file:', effectiveFilePath, error);
    } finally {
      setIsRefreshing(false);
    }
  }, [file, agenticProcess, fs, effectiveFilePath]);

  // Navigate to execute-flow page with current file
  // const handleExecuteFlow = useCallback(() => {
  //   if (!file || !effectiveTypeId || !effectiveFilePath) return;
  //
  //   // Create FSItem for the current file
  //   // Use effectiveTypeId and effectiveFilePath for cross-context file support
  //   const fsItem = new FSItem({
  //     is_dir: false,
  //     vfs_abs_path: `${effectiveTypeId.toString()}${effectiveFilePath}`,
  //     size: 0,
  //   });
  //
  //   // Navigate to execute-flow page with the FSItem
  //   navigation.openExecuteFlow({ file: fsItem });
  // }, [file, effectiveTypeId, effectiveFilePath, navigation]);

  const handleSaveFile: () => Promise<void> = useCallback(async () => {
    if (!file || !effectiveTypeId || !effectiveFilePath) {
      return;
    }

    // Read isDirty directly from Zustand store to avoid stale selector
    // Use effectiveFilePath for cache key construction
    const normalizedPath = effectiveFilePath.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    const textKey = `${effectiveTypeId.toString()}:${normalizedPath}:text`;
    const currentCached = fsStore.getState().contentCache.get(textKey);
    const currentIsDirty = currentCached?.isDirty || false;
    const currentContent = (currentCached?.content as string) || editorRef.current?.getValue() || '';

    const onFileSaved = () => {
      setIsDirty(false);

      if (!pendingExecuteRef.current) return;
      const { language, filePath } = pendingExecuteRef.current;
      pendingExecuteRef.current = null;
      void executeScript(language, filePath);
    };

    if (!currentContent) {
      console.error('[EditorPane] 💾 Editor content not available');
      return;
    }

    // Only save if dirty (check from FSStore, not closure)
    if (!currentIsDirty) {
      clearSaveTimeout();
      onFileSaved();
      return;
    }

    if (!fs) {
      console.error('[EditorPane] 💾 Cannot save - fs is null');
      return;
    }

    try {
      // Write back to server via REST API
      await fs.writeBack(effectiveFilePath);

      // Mark as saved (writeBack already calls markClean internally)
      onFileSaved();

      // Notify agent about the change (placeholder for future design)
      notifyAgentOnChange('write', effectiveFilePath, currentContent);
    } catch (error) {
      console.error('[EditorPane] 💾 Error saving file:', effectiveFilePath, error);
      // Keep asterisk on if save fails
    }
  }, [file, fs, setIsDirty, executeScript, clearSaveTimeout, effectiveTypeId, effectiveFilePath]);

  if (!file) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      </div>
    );
  }

  // Image files render inline rather than in Monaco.
  if (isImage) {
    return (
      <div className="group relative flex h-full min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/20 p-4">
        {imageUrl ? (
          <>
            <img
              src={imageUrl}
              alt={file.path.split('/').pop() || file.path}
              className="max-h-full max-w-full object-contain"
            />
            <a
              href={imageUrl}
              download={file.path.split('/').pop() || file.path}
              title={t`Download`}
              className="absolute right-5 top-2 z-10 flex h-8 w-8 items-center justify-center rounded-lg border bg-background/50 text-foreground opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
            >
              <Download className="h-4 w-4" />
            </a>
          </>
        ) : (
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
        )}
      </div>
    );
  }

  return (
    <div className="group relative flex h-full min-h-0 flex-1 flex-col">
      <div className="editor-pane-actions absolute right-5 top-2 z-10 flex flex-row-reverse rounded-lg border bg-background/50 group-hover:gap-2">
        <div>
          {/* <Button
            variant="ghost"
            size="icon"
            onClick={handleExecuteFlow}
            title="Execute in Flow"
            className="hover:bg-muted"
          >
            <PlayCircle className="h-4 w-4" />
          </Button> */}
          {isExecutableScript(file.language) && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => handleExecuteScript(file.language, file.path)}
              title={t`Run script`}
              className="hover:bg-muted"
              disabled={isExecuting}
            >
              {isExecuting ? (
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </Button>
          )}
          {isCustomViewAvailable(file.language) && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setIsCustomView((prev) => !prev)}
              title={t`Toggle view`}
              className="hover:bg-muted"
            >
              <Eye className="h-4 w-4" />
            </Button>
          )}
        </div>
        <div className="w-0 origin-right overflow-hidden transition-all group-hover:w-28">
          <div className="flex w-28">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void handleRefreshFile()}
              title={t`Refresh file from server`}
              className="hover:bg-muted"
              disabled={isRefreshing}
            >
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => void copyToClipboard(fileContent)}
              title={t`Copy`}
              className="hover:bg-muted"
            >
              <Copy className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => downloadFile({ name: file.path, content: file.blob || new Blob([fileContent]) })}
              title={t`Download`}
              className="hover:bg-muted"
            >
              <Download className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <div className="h-full" style={{ position: 'relative' }}>
        {isCustomView ? (
          CUSTOM_VIEW[file.language as keyof typeof CUSTOM_VIEW] === 'markdown' ? (
            <div className="h-full w-full overflow-auto">
              <MilkdownEditor
                content={fileContent}
                onChange={readOnly ? undefined : handleContentChange}
                editorMode={readOnly ? 'view' : 'editor'}
              />
            </div>
          ) : CUSTOM_VIEW[file.language as keyof typeof CUSTOM_VIEW] === 'html' ? (
            <iframe
              className="h-full w-full border-0"
              srcDoc={fileContent}
              sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox"
              title={t`HTML Preview`}
            />
          ) : null
        ) : (
          <Editor
            height="100%"
            language={file.language}
            value={fileContent}
            onChange={handleContentChange}
            onMount={handleEditorDidMount}
            theme={resolvedTheme === 'dark' ? 'dark-plus' : 'light-plus'}
            options={{
              readOnly: readOnly,
              fontSize: 14,
              lineHeight: 20,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              wordWrap: 'on',
              padding: { top: 16, bottom: 16 },
              lineNumbers: 'on',
              glyphMargin: true,
              folding: true,
              renderLineHighlight: 'all',
              selectOnLineNumbers: true,
            }}
          />
        )}
      </div>
    </div>
  );
};
