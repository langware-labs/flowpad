import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useTheme } from 'next-themes';
import { Trans } from '@lingui/react/macro';
// Without this CSS the canvas inflates to ~2^25 px (unconstrained resize observer).
import '@excalidraw/excalidraw/index.css';
import { Button } from '@src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@src/components/ui/dialog';
import { downloadFile, FSRef, type Whiteboard } from '@sdk';
import { AssetEditorHeader } from '@src/components/assets/editor/AssetEditorHeader';
import { excalidrawToMermaid } from './excalidrawToMermaid';

type LoadedExcalidrawLib = {
  Excalidraw: React.ComponentType<ExcalidrawComponentProps>;
  MainMenu: React.ComponentType<{ children?: React.ReactNode }> & {
    DefaultItems: {
      LoadScene: React.ComponentType<unknown>;
      SaveAsImage: React.ComponentType<unknown>;
      ClearCanvas: React.ComponentType<unknown>;
      ToggleTheme?: React.ComponentType<unknown>;
    };
  };
};

let cachedLib: LoadedExcalidrawLib | null = null;
const loadExcalidrawLib = (): Promise<LoadedExcalidrawLib> => {
  if (cachedLib) return Promise.resolve(cachedLib);
  return import('@excalidraw/excalidraw').then((m) => {
    cachedLib = m as unknown as LoadedExcalidrawLib;
    return cachedLib;
  });
};

const ExcalidrawWithCustomMenu = lazy(() =>
  loadExcalidrawLib().then((lib) => ({
    default: (props: ExcalidrawComponentProps) => (
      <lib.Excalidraw {...props}>
        <lib.MainMenu>
          <lib.MainMenu.DefaultItems.LoadScene />
          <lib.MainMenu.DefaultItems.ClearCanvas />
        </lib.MainMenu>
      </lib.Excalidraw>
    ),
  })),
);

const DEBOUNCE_MS = 750;
const BEGIN_MARKER = '<!-- BEGIN whiteboard:auto -->';
const END_MARKER = '<!-- END whiteboard:auto -->';

interface ExcalidrawComponentProps {
  initialData?: unknown;
  onChange?: (elements: unknown, appState: unknown, files: unknown) => void;
  excalidrawAPI?: (api: ExcalidrawAPI) => void;
  theme?: 'light' | 'dark';
  UIOptions?: {
    welcomeScreen?: boolean;
    canvasActions?: Record<string, boolean>;
  };
  children?: React.ReactNode;
}

interface ExcalidrawAPI {
  updateScene: (scene: { elements: unknown[] }) => void;
  getSceneElements: () => unknown[];
  getAppState: () => unknown;
  getFiles: () => unknown;
}

interface WrappedBoard {
  kind: 'excalidraw';
  version: number;
  data: { elements?: unknown[]; appState?: unknown; files?: unknown };
}

interface WhiteboardAssetEditorProps {
  /** FSRef to the whiteboard folder. */
  fsRef: FSRef;
  /** Pre-resolved whiteboard entity (passed by EntityResolutionGate). */
  whiteboard?: Whiteboard;
}

function ConnectingFallback() {
  return (
    <div
      data-testid="whiteboard-loading"
      className="flex h-full items-center justify-center text-sm text-muted-foreground"
    >
      <RefreshCw className="me-2 h-4 w-4 animate-spin" />
      <Trans>Loading whiteboard…</Trans>
    </div>
  );
}

// `collaborators` is a Map at runtime — JSON-round-tripping turns it into `{}`,
// then crashes Excalidraw's InteractiveCanvas on next mount. Strip on both load and save.
function stripEphemeralAppState(appState: unknown): Record<string, unknown> {
  const src = (appState ?? {}) as Record<string, unknown>;
  const { collaborators: _drop, ...rest } = src as Record<string, unknown> & { collaborators?: unknown };
  return rest;
}

/** Only durable canvas content counts as an edit; viewport/app-state changes do not. */
function semanticBoardFingerprint(elements: unknown, files: unknown): string {
  return JSON.stringify({
    elements: Array.isArray(elements) ? elements : [],
    files: files ?? {},
  });
}

function spliceMermaidBlock(currentDoc: string, mermaid: string): string {
  const block = '```mermaid\n' + mermaid + '```\n';
  const wrapped = `${BEGIN_MARKER}\n${block}\n_Auto-generated from board.json — edits inside this block are overwritten on next save._\n${END_MARKER}`;
  const re = /(<!-- BEGIN whiteboard:auto -->)[\s\S]*?(<!-- END whiteboard:auto -->)/;
  if (re.test(currentDoc)) {
    return currentDoc.replace(re, wrapped);
  }
  const trimmed = currentDoc.endsWith('\n') ? currentDoc : currentDoc + '\n';
  return `${trimmed}\n${wrapped}\n`;
}

export function WhiteboardAssetEditor({ fsRef, whiteboard }: WhiteboardAssetEditorProps) {
  const boardRef = useMemo(() => fsRef.child('board.json'), [fsRef]);
  const docRef = useMemo(() => fsRef.child('WHITE_BOARD.md'), [fsRef]);
  const thumbRef = useMemo(() => fsRef.child('thumbnail.svg'), [fsRef]);

  const { folderName, dirPath } = useMemo(() => {
    const parts = (fsRef.path || '').split('/').filter(Boolean);
    const tail = parts.pop() || 'whiteboard';
    return {
      folderName: tail,
      dirPath: parts.length ? '/' + parts.join('/') : '',
    };
  }, [fsRef]);

  const handleOpenExternal = useCallback(() => {
    void fsRef.open();
  }, [fsRef]);
  const handleRevealInFinder = useCallback(() => {
    void fsRef.open({ select: true });
  }, [fsRef]);

  const { resolvedTheme } = useTheme();
  const excalidrawTheme: 'light' | 'dark' = resolvedTheme === 'dark' ? 'dark' : 'light';

  const uiOptions = useMemo(
    () => ({
      welcomeScreen: false,
      canvasActions: {
        toggleTheme: false,
        saveAsImage: true,
        export: { saveFileToDisk: true },
      },
    }),
    [],
  );

  const [initialData, setInitialData] = useState<unknown | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const apiRef = useRef<ExcalidrawAPI | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The serialized board.json bytes we last wrote. Excalidraw emits spurious
  // onChange callbacks after mount (font-load / internal re-renders) that carry
  // an identical scene; without this guard each one re-arms the debounce and
  // re-writes byte-identical board.json, churning the file (and its mtime) with
  // no real change. Skip the write when the payload matches the last one.
  const lastWrittenRef = useRef<string | null>(null);
  const lastSemanticRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const raw = await boardRef.read();
        if (cancelled) return;
        const parsed: WrappedBoard = JSON.parse(raw);
        // Accept BOTH shapes: the editor's `{kind, version, data}` envelope and
        // a plain Excalidraw scene `{elements, appState}` (what agents and
        // exported .excalidraw files write). Without the fallback a plain scene
        // loaded as `{}` and the first autosave clobbered it with an empty board.
        const data = (parsed?.data ??
          (Array.isArray((parsed as unknown as { elements?: unknown[] })?.elements) ? parsed : {})) as {
          elements?: unknown[];
          appState?: unknown;
          files?: unknown;
        };
        if (data.appState && typeof data.appState === 'object') {
          data.appState = stripEphemeralAppState(data.appState);
        }
        lastSemanticRef.current = semanticBoardFingerprint(data.elements, data.files);
        setInitialData(data);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        lastSemanticRef.current = semanticBoardFingerprint([], {});
        setInitialData({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [boardRef]);

  const persist = useCallback(
    async (elements: unknown[], appState: unknown, files: unknown) => {
      const cleanAppState = stripEphemeralAppState(appState);
      const data = { elements, appState: cleanAppState, files };
      const wrapped: WrappedBoard = { kind: 'excalidraw', version: 1, data };
      const serialized = JSON.stringify(wrapped, null, 2);
      if (serialized === lastWrittenRef.current) return;
      lastWrittenRef.current = serialized;
      await boardRef.write(serialized);

      const mermaid = excalidrawToMermaid(data);
      let currentDoc = '';
      try {
        currentDoc = await docRef.read();
      } catch {
        currentDoc = '';
      }
      const nextDoc = spliceMermaidBlock(currentDoc, mermaid);
      await docRef.write(nextDoc);

      try {
        const lib = await loadExcalidrawLib();
        const exportToSvg = (
          lib as unknown as {
            exportToSvg: (opts: { elements: unknown; appState: unknown; files: unknown }) => Promise<SVGElement>;
          }
        ).exportToSvg;
        const svg = await exportToSvg({
          elements,
          appState: { ...cleanAppState, exportBackground: true },
          files,
        });
        await thumbRef.write(new XMLSerializer().serializeToString(svg));
      } catch {
        // Thumbnail is best-effort.
      }
    },
    [boardRef, docRef, thumbRef],
  );

  const onChange = useCallback(
    (elements: unknown, appState: unknown, files: unknown) => {
      const els = Array.isArray(elements) ? (elements as unknown[]) : [];
      const semanticFingerprint = semanticBoardFingerprint(els, files);
      if (semanticFingerprint !== lastSemanticRef.current) {
        lastSemanticRef.current = semanticFingerprint;
        whiteboard?.markEdit();
      }
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void persist(els, appState, files);
      }, DEBOUNCE_MS);
    },
    [persist, whiteboard],
  );

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const handleApi = useCallback(
    (api: ExcalidrawAPI) => {
      apiRef.current = api;
      if (import.meta.env.DEV) {
        const w = window as unknown as Record<string, unknown>;
        w.__whiteboardApi = api;
        w.__whiteboardOnChange = onChange;
        void loadExcalidrawLib().then((lib) => {
          w.__excalidrawLib = lib;
        });
      }
    },
    [onChange],
  );

  const downloadBlob = useCallback(async (blob: Blob, filename: string) => {
    // Data URL (not blob:) — Chrome drops the download attr on blob: URLs
    // created after an await (gesture context is stale). Exports are small (~10KB).
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
      reader.readAsDataURL(blob);
    });
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    void downloadFile;
  }, []);

  const baseFilename = useMemo(() => {
    const name = (fsRef.path || 'whiteboard').split('/').filter(Boolean).pop() || 'whiteboard';
    return name.replace(/\.\w+$/, '');
  }, [fsRef]);

  const exportAs = useCallback(
    async (fmt: 'png' | 'svg') => {
      if (!apiRef.current) return;
      try {
        const lib = await loadExcalidrawLib();
        const elements = apiRef.current.getSceneElements();
        const appState = { ...stripEphemeralAppState(apiRef.current.getAppState()), exportBackground: true };
        const files = apiRef.current.getFiles();
        let blob: Blob;
        if (fmt === 'png') {
          const exportToBlob = (
            lib as unknown as {
              exportToBlob: (opts: {
                elements: unknown;
                appState: unknown;
                files: unknown;
                mimeType: string;
              }) => Promise<Blob>;
            }
          ).exportToBlob;
          blob = await exportToBlob({ elements, appState, files, mimeType: 'image/png' });
        } else {
          const exportToSvg = (
            lib as unknown as {
              exportToSvg: (opts: { elements: unknown; appState: unknown; files: unknown }) => Promise<SVGElement>;
            }
          ).exportToSvg;
          const svg = await exportToSvg({ elements, appState, files });
          blob = new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
        }
        await downloadBlob(blob, `${baseFilename}.${fmt}`);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    },
    [baseFilename, downloadBlob],
  );

  const handleImport = useCallback(async () => {
    if (!importText.trim() || !apiRef.current) {
      setImportOpen(false);
      return;
    }
    setImportBusy(true);
    try {
      // parseMermaidToExcalidraw returns ElementSkeleton[] — must run through
      // convertToExcalidrawElements to materialize bindings + text children,
      // else rectangles render as "Untitled" and arrows lose endpoint bindings.
      const mermaidMod = await import('@excalidraw/mermaid-to-excalidraw');
      const parseMermaidToExcalidraw = (
        mermaidMod as unknown as {
          parseMermaidToExcalidraw: (text: string) => Promise<{ elements: unknown[]; files?: Record<string, unknown> }>;
        }
      ).parseMermaidToExcalidraw;
      const result = await parseMermaidToExcalidraw(importText);

      const excalMod = await loadExcalidrawLib();
      const convertToExcalidrawElements = (
        excalMod as unknown as {
          convertToExcalidrawElements: (skel: unknown[]) => unknown[];
        }
      ).convertToExcalidrawElements;
      const elements = convertToExcalidrawElements(result.elements);

      apiRef.current.updateScene({ elements });
      if (result.files && Object.keys(result.files).length > 0) {
        const addFiles = (apiRef.current as unknown as { addFiles?: (files: unknown[]) => void }).addFiles;
        if (typeof addFiles === 'function') {
          addFiles(Object.values(result.files));
        }
      }
      setImportOpen(false);
      setImportText('');
      const els = apiRef.current.getSceneElements();
      const appState = apiRef.current.getAppState();
      const files = apiRef.current.getFiles();
      onChange(els, appState, files);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setImportBusy(false);
    }
  }, [importText, onChange]);

  if (initialData === null) {
    return <ConnectingFallback />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="whiteboard-editor">
      <AssetEditorHeader
        fileName={folderName}
        dirPath={dirPath}
        onOpenExternal={handleOpenExternal}
        onRevealInFinder={handleRevealInFinder}
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => setImportOpen(true)} data-testid="open-import-mermaid">
              <Trans>Import mermaid → board</Trans>
            </Button>
            <Button size="sm" variant="outline" onClick={() => void exportAs('png')} data-testid="export-png">
              <Trans>Export PNG</Trans>
            </Button>
            <Button size="sm" variant="outline" onClick={() => void exportAs('svg')} data-testid="export-svg">
              <Trans>Export SVG</Trans>
            </Button>
            {loadError && (
              <span className="text-xs text-destructive" data-testid="whiteboard-error">
                {loadError}
              </span>
            )}
          </>
        }
      />
      <div className="relative min-h-0 flex-1">
        <Suspense fallback={<ConnectingFallback />}>
          <div className="absolute inset-0">
            <ExcalidrawWithCustomMenu
              initialData={initialData}
              onChange={onChange}
              excalidrawAPI={handleApi}
              theme={excalidrawTheme}
              UIOptions={uiOptions}
            />
          </div>
        </Suspense>
      </div>
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Trans>Import mermaid → board</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>Paste Mermaid syntax to replace the current board.</Trans>
            </DialogDescription>
          </DialogHeader>
          <textarea
            data-testid="mermaid-import-textarea"
            className="min-h-[160px] w-full rounded border bg-background p-2 font-mono text-sm"
            placeholder="flowchart TD&#10;  A[Foo] --> B[Bar]"
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setImportOpen(false)} disabled={importBusy}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              onClick={handleImport}
              disabled={importBusy || !importText.trim()}
              data-testid="confirm-import-mermaid"
            >
              <Trans>Import</Trans>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default WhiteboardAssetEditor;
