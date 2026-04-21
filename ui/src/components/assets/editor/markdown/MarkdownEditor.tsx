import { MilkdownEditorWithSidePanel } from '@src/components/milkdown-editor/MilkdownEditorWithSidePanel';
import { Button } from '@src/components/ui/button';
import { useMarkdownContent } from '@src/hooks/use-markdown-content';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ViewType } from '@src/types/ViewType';
import { FSRef } from '@sdk';
import Editor from '@monaco-editor/react';
import { ArrowLeft, ChevronDown, ChevronRight, Eye, ExternalLink, FileCode, MessageSquareDiff, Pencil, RefreshCw } from 'lucide-react';
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
  /** Optional asset-specific toolbar actions rendered in the header */
  toolbar?: React.ReactNode;
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
export function MarkdownEditor({ fsRef, toolbar }: MarkdownEditorProps) {
  return <MarkdownEditorContent fsRef={fsRef} sourcePath={fsRef.path} toolbar={toolbar} />;
}

// ── Editor content ────────────────────────────────────────────────────────────

function MarkdownEditorContent({ fsRef, sourcePath, toolbar }: { fsRef: FSRef; sourcePath: string; toolbar?: React.ReactNode }) {
  const { navigation, currentDock } = useDockNavigation();
  const [viewMode, setViewMode] = useState<ViewMode>(readStoredMode);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem(MODE_STORAGE_KEY, viewMode); } catch { /* storage may be disabled */ }
  }, [viewMode]);

  const {
    fields,
    hasFields,
    body,
    setField,
    setBody,
    dirty,
    isLoading,
    loadError,
    reload,
  } = useMarkdownContent(fsRef, { autoSave: true, autoSaveMs: 2000 });

  const [propsExpanded, setPropsExpanded] = useState(false);

  const setBodyRef = useRef(setBody);
  setBodyRef.current = setBody;
  const handleBodyChange = useCallback((newBody: string) => {
    setBodyRef.current(newBody);
  }, []);

  // Derive display name from path
  const fileName = sourcePath.split('/').pop() ?? sourcePath;
  const dirPath = sourcePath.slice(0, sourcePath.lastIndexOf('/'));

  const handleOpenExternal = useCallback(() => {
    navigator.clipboard.writeText(sourcePath).catch(() => {});
  }, [sourcePath]);

  const handleLinkClick = useCallback((href: string) => {
    const dir = sourcePath.slice(0, sourcePath.lastIndexOf('/'));
    const resolvedPath = href.startsWith('/') ? href : `${dir}/${href}`;
    // Preserve the current asset type (e.g. "claude_memory") for sibling files
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
          onBack={() => navigation.openTab(ViewType.ASSETS)}
          onOpenExternal={handleOpenExternal}
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
          onBack={() => navigation.openTab(ViewType.ASSETS)}
          onOpenExternal={handleOpenExternal}
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
        onBack={() => navigation.openTab(ViewType.ASSETS)}
        onOpenExternal={handleOpenExternal}
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

      {viewMode === 'markdown' ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <MonacoMarkdownEditor value={body} onChange={handleBodyChange} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">
          <MilkdownEditorWithSidePanel
            content={body}
            onChange={handleBodyChange}
            onLinkClick={handleLinkClick}
            editorMode={viewMode}
            sourcePath={sourcePath}
          />
        </div>
      )}
    </div>
  );
}

// ── Monaco markdown editor ────────────────────────────────────────────────────

function MonacoMarkdownEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { resolvedTheme } = useTheme();
  return (
    <Editor
      height="100%"
      language="markdown"
      value={value}
      onChange={(v) => onChange(v ?? '')}
      theme={resolvedTheme === 'dark' ? 'vs-dark' : 'vs'}
      options={{
        minimap: { enabled: false },
        wordWrap: 'on',
        lineNumbers: 'off',
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
  onBack: () => void;
  onOpenExternal: () => void;
  actions?: React.ReactNode;
}

function EditorHeader({ fileName, dirPath, dirty, viewMode, onViewModeChange, onBack, onOpenExternal, actions }: EditorHeaderProps) {
  return (
    <div className="flex h-[52px] flex-shrink-0 items-center gap-2 border-b px-3">
      <Button variant="ghost" size="sm" onClick={onBack} className="-ml-1 flex-shrink-0">
        <ArrowLeft className="mr-1 h-4 w-4" />
        Wiki
      </Button>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-0.5 truncate">
          <span className="text-sm font-medium">{fileName}</span>
          {dirty && <span className="text-sm text-amber-500">*</span>}
        </div>
        {dirPath && (
          <div className="truncate text-[11px] text-muted-foreground">{dirPath}</div>
        )}
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

      <button
        title="Copy path to clipboard"
        onClick={onOpenExternal}
        className="flex-shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <ExternalLink className="h-4 w-4" />
      </button>
    </div>
  );
}
