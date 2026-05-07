import type { Editor as MilkdownEditorInstance } from '@milkdown/core';
import { EditorWithSidePanel, type ExtraSideTab } from '@src/components/milkdown-editor/EditorWithSidePanel';
import { MilkdownEditor } from '@src/components/milkdown-editor/MilkdownEditor';
import { Button } from '@src/components/ui/button';
import { WikiToolbar } from '@src/components/wiki-toolbar';
import { useMarkdownContent } from '@src/hooks/use-markdown-content';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { FSRef } from '@sdk';
import { downloadFile } from '@sdk/utils/utils';
import Editor, { type OnMount } from '@monaco-editor/react';
import { ChevronDown, ChevronRight, Download, Eye, ExternalLink, FileCode, MessageSquareDiff, Pencil, RefreshCw } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useRef, useState } from 'react';

const EDITOR_MODES = ['view', 'review', 'editor', 'markdown'] as const;
type ViewMode = (typeof EDITOR_MODES)[number];

const MODE_STORAGE_KEY = 'markdownEditor.mode';
const DEFAULT_MODE: ViewMode = 'view';

function readStoredMode(): ViewMode {
  if (typeof window === 'undefined') return DEFAULT_MODE;
  try {
    const raw = window.localStorage.getItem(MODE_STORAGE_KEY);
    return (EDITOR_MODES as readonly string[]).includes(raw ?? '') ? (raw as ViewMode) : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

const MODE_ICONS: Record<ViewMode, React.ComponentType<{ className?: string }>> = {
  view: Eye,
  review: MessageSquareDiff,
  editor: Pencil,
  markdown: FileCode,
};

interface MarkdownEditorProps {
  /** FSRef to the .md file — carries path + typeId + read/write. */
  fsRef: FSRef;
  /**
   * Serialized TypeId of the entity this markdown belongs to (e.g. `"plan-<id>"`).
   * Keys Editor + Backlinks tabs. Null disables editor persistence on this file.
   */
  chatTarget: string | null;
  /** Optional asset-specific toolbar actions rendered in the header */
  toolbar?: React.ReactNode;
  /** Appended to the side drawer after Editor + Backlinks. */
  extraSideTabs?: ExtraSideTab[];
  /** Controlled active side-drawer tab id. */
  activeSideTab?: string;
  /** Fires when the active side-drawer tab changes (including internal clicks). */
  onActiveSideTabChange?: (id: string) => void;
  /** Forwarded to the Editor tab — runs once after its backing process is created. */
  onChatProcessCreated?: (process: import('@sdk').AgenticProcess) => Promise<void> | void;
}

/**
 * Generic markdown editor.
 *
 * - Header shows filename (with * when dirty), full path, and external-open button.
 * - Shows a Properties block only when the file has YAML frontmatter.
 * - Fields are rendered dynamically from whatever keys exist in the frontmatter.
 * - Body is rendered by Milkdown (view/review/editor) or Monaco (markdown).
 * - The chosen mode is persisted across docs via localStorage.
 */
export function MarkdownEditor({
  fsRef,
  chatTarget,
  toolbar,
  extraSideTabs,
  activeSideTab,
  onActiveSideTabChange,
  onChatProcessCreated,
}: MarkdownEditorProps) {
  return (
    <MarkdownEditorContent
      fsRef={fsRef}
      sourcePath={fsRef.path}
      chatTarget={chatTarget}
      toolbar={toolbar}
      extraSideTabs={extraSideTabs}
      activeSideTab={activeSideTab}
      onActiveSideTabChange={onActiveSideTabChange}
      onChatProcessCreated={onChatProcessCreated}
    />
  );
}

// ── Editor content ────────────────────────────────────────────────────────────

function MarkdownEditorContent({
  fsRef,
  sourcePath,
  chatTarget,
  toolbar,
  extraSideTabs,
  activeSideTab,
  onActiveSideTabChange,
  onChatProcessCreated,
}: {
  fsRef: FSRef;
  sourcePath: string;
  chatTarget: string | null;
  toolbar?: React.ReactNode;
  extraSideTabs?: ExtraSideTab[];
  activeSideTab?: string;
  onActiveSideTabChange?: (id: string) => void;
  onChatProcessCreated?: MarkdownEditorProps['onChatProcessCreated'];
}) {
  const { navigation, currentDock } = useDockNavigation();
  const [viewMode, setViewMode] = useState<ViewMode>(readStoredMode);
  // Imperative handle to the underlying Milkdown editor — driven by the
  // wiki toolbar to insert wikilinks at the cursor.
  const milkdownRef = useRef<MilkdownEditorInstance | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(MODE_STORAGE_KEY, viewMode); } catch { /* storage may be disabled */ }
  }, [viewMode]);

  const {
    fields,
    hasFields,
    body,
    bodyStartLine,
    setField,
    setBody,
    dirty,
    isLoading,
    loadError,
    reload,
  } = useMarkdownContent(fsRef, { autoSave: true, autoSaveMs: 2000 });

  const [propsExpanded, setPropsExpanded] = useState(false);

  // On-disk caret line shared across all editor backends. Null means "user has
  // not clicked yet" — chat header badge is hidden in that case. Persists across
  // mode switches so caret restores to the same logical position.
  const [cursorLine, setCursorLine] = useState<number | null>(null);
  const bodyStartLineRef = useRef(bodyStartLine);
  bodyStartLineRef.current = bodyStartLine;
  const handleEditorLineChange = useCallback((bodyLine: number) => {
    setCursorLine(bodyStartLineRef.current + bodyLine - 1);
  }, []);
  const initialBodyLine = cursorLine != null ? cursorLine - bodyStartLine + 1 : null;

  const setBodyRef = useRef(setBody);
  setBodyRef.current = setBody;
  const handleBodyChange = useCallback((newBody: string) => {
    setBodyRef.current(newBody);
  }, []);

  // Derive display name from path
  const fileName = sourcePath.split('/').pop() ?? sourcePath;
  const dirPath = sourcePath.slice(0, sourcePath.lastIndexOf('/'));

  const handleOpenExternal = useCallback(() => {
    void fsRef.open({ select: true });
  }, [fsRef]);

  const handleDownload = useCallback(() => {
    void (async () => {
      const content = await fsRef.read();
      downloadFile({ name: fileName, content: new Blob([content], { type: 'text/markdown' }) });
    })();
  }, [fsRef, fileName]);

  const handleLinkClick = useCallback((href: string) => {
    // /dock/assets/wiki/<name> → keep the URL at the wiki form; the
    // wiki route view (WikiResolveView) does the name resolution.
    const wikiMatch = href.match(/\/dock\/assets\/wiki\/([^?#]+)/);
    if (wikiMatch) {
      const name = decodeURIComponent(wikiMatch[1]).replace(/\.md$/i, '');
      navigation.openDock(DockPointer.forWiki(name));
      return;
    }

    const dir = sourcePath.slice(0, sourcePath.lastIndexOf('/'));
    const resolvedPath = href.startsWith('/') ? href : `${dir}/${href}`;
    const assetType = currentDock?.pointer?.split('/')?.[1] ?? 'claude_memory';
    navigation.openDock(DockPointer.forAssetEditor(assetType, resolvedPath));
  }, [sourcePath, currentDock, navigation]);

  // ── Loading ────────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <EditorHeader
          fileName={fileName}
          dirPath={dirPath}
          dirty={false}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          onOpenExternal={handleOpenExternal}
          onDownload={handleDownload}
          actions={toolbar}
        />
        <div className="flex flex-1 items-center justify-center">
          <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  // ── Error ──────────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <EditorHeader
          fileName={fileName}
          dirPath={dirPath}
          dirty={false}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          onOpenExternal={handleOpenExternal}
          onDownload={handleDownload}
          actions={toolbar}
        />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="text-sm text-muted-foreground">{loadError.message}</p>
          <Button variant="outline" size="sm" onClick={reload}>
            <RefreshCw className="mr-1 h-4 w-4" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  // ── Editor ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <EditorHeader
        fileName={fileName}
        dirPath={dirPath}
        dirty={dirty}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onOpenExternal={handleOpenExternal}
        onDownload={handleDownload}
        actions={toolbar}
      />

      {hasFields && (
        <div className="flex-shrink-0 border-b">
          <button
            className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground"
            onClick={() => setPropsExpanded((e) => !e)}
          >
            {propsExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Properties
          </button>

          {propsExpanded && (
            <div className="flex flex-col gap-2 px-3 pb-3">
              {Object.entries(fields).map(([key, value]) => (
                <div key={key} className="flex flex-col gap-1">
                  <label className="text-xs capitalize text-muted-foreground">{key}</label>
                  <input
                    className="rounded-md border bg-background px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-ring"
                    value={value}
                    onChange={(e) => setField(key, e.target.value)}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden">
        <EditorWithSidePanel
          chatTarget={chatTarget}
          extraTabs={extraSideTabs}
          activeTab={activeSideTab}
          onActiveTabChange={onActiveSideTabChange}
          onChatProcessCreated={onChatProcessCreated}
          cursorLine={cursorLine}
        >
          {viewMode === 'markdown' ? (
            <MonacoMarkdownEditor
              value={body}
              onChange={handleBodyChange}
              onCursorLineChange={handleEditorLineChange}
              initialLine={initialBodyLine}
            />
          ) : (
            <MilkdownEditor
              content={body}
              onChange={handleBodyChange}
              onLinkClick={handleLinkClick}
              editorMode={viewMode}
              editorRef={milkdownRef}
              onCursorLineChange={handleEditorLineChange}
              initialLine={initialBodyLine}
              toolbarRight={
                viewMode === 'editor' ? (
                  <WikiToolbar editorRef={milkdownRef} sourceTypeId={chatTarget} />
                ) : undefined
              }
            />
          )}
        </EditorWithSidePanel>
      </div>
    </div>
  );
}

// ── Monaco markdown editor ────────────────────────────────────────────────────

function MonacoMarkdownEditor({
  value,
  onChange,
  onCursorLineChange,
  initialLine,
}: {
  value: string;
  onChange: (v: string) => void;
  onCursorLineChange?: (bodyLine: number) => void;
  initialLine?: number | null;
}) {
  const { resolvedTheme } = useTheme();
  // Capture initialLine at mount via a ref so handleMount can read the latest
  // value supplied at first render without re-mounting on prop changes.
  const initialLineRef = useRef(initialLine ?? null);
  const onCursorLineChangeRef = useRef(onCursorLineChange);
  onCursorLineChangeRef.current = onCursorLineChange;

  const handleMount = useCallback<OnMount>((editor) => {
    // Mark "user has interacted" only when restoring from a known line OR when
    // the user actually clicks/types. Initial-mount cursor at line 1 with no
    // restoration must not emit (matches Q3: no badge until first interaction).
    let userInteracted = false;
    const target = initialLineRef.current;
    if (target != null && target > 0) {
      editor.setPosition({ lineNumber: target, column: 1 });
      editor.revealLineInCenter(target);
      userInteracted = true;
    }
    const dom = editor.getDomNode();
    if (dom) {
      const onUser = () => { userInteracted = true; };
      dom.addEventListener('mousedown', onUser);
      dom.addEventListener('keydown', onUser);
    }
    editor.onDidChangeCursorPosition((e) => {
      if (!userInteracted) return;
      onCursorLineChangeRef.current?.(e.position.lineNumber);
    });
  }, []);

  return (
    <Editor
      height="100%"
      language="markdown"
      value={value}
      onChange={(v) => onChange(v ?? '')}
      onMount={handleMount}
      theme={resolvedTheme === 'dark' ? 'vs-dark' : 'vs'}
      options={{
        minimap: { enabled: false },
        wordWrap: 'on',
        lineNumbers: 'on',
        folding: false,
        fontSize: 13,
        scrollBeyondLastLine: false,
        padding: { top: 12, bottom: 12 },
      }}
    />
  );
}

// ── Header ─────────────────────────────────────────────────────────────────────

interface EditorHeaderProps {
  fileName: string;
  dirPath: string;
  dirty: boolean;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onOpenExternal: () => void;
  onDownload?: () => void;
  actions?: React.ReactNode;
}

function EditorHeader({ fileName, dirPath, dirty, viewMode, onViewModeChange, onOpenExternal, onDownload, actions }: EditorHeaderProps) {
  return (
    <div className="flex h-[52px] flex-shrink-0 items-center gap-2 border-b px-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-0.5 truncate">
          <span className="text-sm font-medium">{fileName}</span>
          {dirty && <span className="text-sm text-amber-500">*</span>}
        </div>
        <div className="flex min-w-0 items-center gap-1">
          {dirPath && (
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">{dirPath}</span>
          )}
          <button
            title="Reveal in Finder"
            onClick={onOpenExternal}
            data-testid="markdown-editor-open-external"
            className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" />
          </button>
          {onDownload && (
            <button
              title="Download file"
              onClick={onDownload}
              data-testid="markdown-editor-download"
              className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <Download className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-shrink-0 items-center rounded-md border bg-muted/40 p-0.5">
        {EDITOR_MODES.map((mode) => {
          const Icon = MODE_ICONS[mode];
          const active = viewMode === mode;
          return (
            <button
              key={mode}
              onClick={() => onViewModeChange(mode)}
              title={mode.charAt(0).toUpperCase() + mode.slice(1)}
              className={`flex items-center gap-1 rounded px-2 py-1 text-xs font-medium capitalize transition-colors ${
                active
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="h-3 w-3" />
              {mode}
            </button>
          );
        })}
      </div>

      {actions && <div className="flex flex-shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}
