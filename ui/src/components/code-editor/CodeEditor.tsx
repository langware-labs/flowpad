import {
  dataContext,
  detectLanguage,
  EditorLanguage,
  isImagePath,
  Shell,
  TypeId,
  VFSPath,
} from '@sdk';
import { TabbedTerminal } from '@src/components/terminal';
import { Button } from '@src/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@src/components/ui/resizable';
import { ScrollArea, ScrollBar } from '@src/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { useFS } from '@src/hooks/useFS';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { TabInfo, useEditorStore } from '@src/store/use-editor-store';
import { ChevronDown, ChevronUp, Pin, TerminalIcon, X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import DiffViewer from './DiffViewer';
import { EditorPane } from './EditorPane';
import { AssetEditorHeader } from '@src/components/assets/editor/AssetEditorHeader';

interface EditorFile {
  path: string;
  content?: string;
  blob?: Blob;
  language: EditorLanguage;
  type: 'file' | 'folder';
}

interface CodeEditorProps {
  readOnly?: boolean;
  activePath?: string | null;
}

const CodeEditor: React.FC<CodeEditorProps> = ({ readOnly, activePath }) => {
  const { t } = useLingui();
  const project = dataContext.project;
  const projectTypeId = useMemo(() => {
    return project?.typeId;
  }, [project?.typeId]);

  // Parse activePath to extract typeId (if present) for cross-context file loading
  const parsedPath = useMemo(() => VFSPath.parse(activePath), [activePath]);
  // Use typeId from path if available, otherwise fall back to project's typeId
  const effectiveTypeId = useMemo(() => parsedPath.typeId ?? projectTypeId, [parsedPath.typeId, projectTypeId]);
  // The actual file path within the entity (without typeId prefix)
  // Ensure path has leading slash for FS operations
  const effectiveFilePath = useMemo(() => {
    if (!parsedPath.typeId) return activePath;
    const subPath = parsedPath.entitySubPath;
    return subPath.startsWith('/') ? subPath : `/${subPath}`;
  }, [parsedPath.typeId, parsedPath.entitySubPath, activePath]);

  const fs = useFS(effectiveTypeId);

  const { navigation, currentDock } = useDockNavigation();

  // `?line=` on the dock (written by `DockPointer.forFile`) is a deep link into
  // the active file — e.g. an interface block's "Open in editor". Only the
  // active tab honours it; the others are just open, not targeted.
  const deepLink = useMemo(() => {
    const raw = currentDock?.options?.line;
    const line = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(line) && line > 0 ? line : null;
  }, [currentDock]);

  // Dialog state for file/folder creation






  // Track open files for tab management (content loaded on demand)
  const [openFiles, setOpenFiles] = useState<EditorFile[]>([]);

  const createTabInfo = useCallback(
    (filePath: string): TabInfo => ({
      path: filePath,
      onDirtyChange: (isDirty: boolean) => {
        setOpenTabs((prevTabs) => prevTabs.map((tab) => (tab.path === filePath ? { ...tab, isDirty } : tab)));
      },
    }),
    [],
  );

  const { isTerminalExpanded, setIsTerminalExpanded, editorTabs, setEditorTabs, editorActiveTab, setEditorActiveTab } =
    useEditorStore();

  // State for failed file tracking - must be declared BEFORE useMemo that might reference it
  const [failedFiles] = useState<Set<string>>(new Set());

  const [openTabs, setOpenTabs] = useState<TabInfo[]>(editorTabs?.length > 0 ? [...editorTabs] : []);
  const [activeTab, setActiveTab] = useState<string>(editorActiveTab || '');
  const [pendingOpenFile, setPendingOpenFile] = useState<string | null>(null);
  const [diffTab, setDiffTab] = useState<{ checkpoint_hash: string } | null>(null);


  useEffect(() => {
    setEditorTabs([...openTabs]);
  }, [openTabs, setEditorTabs]);

  useEffect(() => {
    setEditorActiveTab(activeTab);
  }, [activeTab, setEditorActiveTab]);

  // Get reactive content from FSStore (automatically re-renders when content changes)
  // Use effectiveFilePath (path without typeId prefix) for FS operations
  const contentCache = effectiveFilePath ? fs?.content(effectiveFilePath) : null;

  // Fetch file metadata when activePath changes
  useEffect(() => {
    if (!fs || !effectiveFilePath) return;
    fs.fetch(effectiveFilePath).catch((error) => {
      console.error('[CodeEditor] Failed to fetch file metadata:', effectiveFilePath, error);
    });
  }, [effectiveFilePath, fs]);

  // Add streaming content from FSStore to open files list (reacts to content changes)
  // Images never have text content cached — EditorPane renders them straight from
  // the download URL — so they get an open-file entry on activePath alone.
  useEffect(() => {
    if (!activePath) return;
    if (!contentCache && !isImagePath(activePath)) return;

    setOpenFiles((prevFiles) => {
      // Check if file already exists in open files
      const existingIndex = prevFiles.findIndex((f) => f.path === activePath);

      const fileItem: EditorFile = {
        path: activePath,
        content: typeof contentCache?.content === 'string' ? contentCache.content : undefined,
        language: detectLanguage(activePath),
        type: 'file',
      };

      if (existingIndex >= 0) {
        // Update existing file with streaming content
        const updated = [...prevFiles];
        updated[existingIndex] = fileItem;
        return updated;
      } else {
        // Add new file to open files
        return [...prevFiles, fileItem];
      }
    });

    // Auto-open the streaming file
    setOpenTabs((prev) => {
      // If tab already exists, just return as-is
      if (prev.some((tab) => tab.path === activePath)) {
        return prev;
      }

      // Close unpinned tabs before opening new one
      const filteredTabs = prev.filter((tab) => tab.isPinned);
      return [...filteredTabs, createTabInfo(activePath)];
    });
    setActiveTab(() => activePath);
  }, [activePath, contentCache, createTabInfo]);

  const downloadFileContent = useCallback(
    async (filePath: string) => {
      if (!effectiveTypeId) {
        console.error('[CodeEditor] Cannot download file: no typeId available');
        return;
      }

      if (!fs) return;
      try {
        // Parse the path to extract just the entity subpath (without typeId prefix)
        // This handles cross-context file loading where filePath may include typeId
        const parsed = VFSPath.parse(filePath);
        const downloadPath = parsed.typeId
          ? parsed.entitySubPath.startsWith('/')
            ? parsed.entitySubPath
            : `/${parsed.entitySubPath}`
          : filePath;

        // Download file content into FSStore cache
        await fs.download(downloadPath, false); // asBlob=false for text content
      } catch (error) {
        console.error('[CodeEditor] Error downloading file:', filePath, error);
      }
    },
    [fs, effectiveTypeId],
  );


  // Sync with activePath prop (unified: handles both state-driven from URL and streaming content)
  useEffect(() => {
    if (!activePath) {
      // No active file but we have an active tab - clear it
      setActiveTab('');
      return;
    }
    if (failedFiles.has(activePath)) {
      return;
    }
    // File should be active - ensure it's set as the active tab
    if (activePath !== activeTab && activePath !== pendingOpenFile && !failedFiles.has(activePath)) {
      setPendingOpenFile(activePath);
      return;
    }
  }, [activePath, activeTab, pendingOpenFile, failedFiles]);

  useEffect(() => {
    if (!pendingOpenFile) return;

    // Check if file already exists in open files
    const existingFile = openFiles.find((file) => file.path === pendingOpenFile);

    // Clear pending state
    setPendingOpenFile(null);

    // Auto-close unpinned tabs when dock changes to a different file
    setOpenTabs((prev) => {
      // If tab already exists, just return as-is
      if (prev.some((tab) => tab.path === pendingOpenFile)) {
        return prev;
      }

      // Close unpinned tabs before opening new one
      const filteredTabs = prev.filter((tab) => tab.isPinned);
      return [...filteredTabs, createTabInfo(pendingOpenFile)];
    });

    setActiveTab(pendingOpenFile);

    // Download content if not already cached — but never pull image bytes as
    // text; EditorPane streams those from the download URL into an <img>.
    if (!existingFile?.content && !isImagePath(pendingOpenFile)) {
      void downloadFileContent(pendingOpenFile);
    }
  }, [pendingOpenFile, openFiles, createTabInfo, downloadFileContent]);

  const togglePinTab = useCallback((filePath: string) => {
    setOpenTabs((prev) => prev.map((tab) => (tab.path === filePath ? { ...tab, isPinned: !tab.isPinned } : tab)));
  }, []);

  const closeFile = useCallback(
    (fileId: string) => {
      const newTabs = openTabs.filter((tab) => tab.path !== fileId);
      setOpenTabs(newTabs);
      if (activeTab === fileId) navigation.openEditor(newTabs.at(-1)?.path);
    },
    [openTabs, activeTab, navigation],
  );

  const expandTerminal = useCallback(() => {
    setIsTerminalExpanded(true);
  }, [setIsTerminalExpanded]);

  const toggleTerminal = useCallback(() => {
    setIsTerminalExpanded(!isTerminalExpanded);
  }, [setIsTerminalExpanded, isTerminalExpanded]);

  // Handle shell command from EditorPane (when run button is clicked)
  const handleShellCommand = useCallback(
    async (command: string) => {
      // Expand terminal and switch to run tab
      setIsTerminalExpanded(true);

      // Find or create the 'run' shell on demand
      const cn = dataContext.computeNode;
      if (!cn) {
        console.error('[CodeEditor] No compute node');
        return;
      }

      let runShell: Shell | null = null;
      const shells = await Shell.list(cn.id);
      runShell = shells.find((s) => s.name === 'Run') ?? null;

      if (!runShell) {
        runShell = Shell.create(cn, { name: 'Run', workdir: dataContext.project?.fs_storage_mount_path || undefined });
        await runShell.save(cn.typeId);
      }

      dataContext.setActiveShellId(runShell.id);
      dataContext.setActiveTerminalTargetTypeId(new TypeId(Shell.type, runShell.id));

      if (!runShell.pty?.isLive) {
        await runShell.start({
          cols: 80,
          rows: 24,
          workdir: runShell.workdir ?? dataContext.project?.fs_storage_mount_path ?? undefined,
        });
      }
      await runShell.resize(80, 24);
      await runShell.sendInput(command.trim() + '\r');
    },
    [setIsTerminalExpanded],
  );


  const renderEditorContent = () => (
    <div className="flex h-full flex-col">
      {openTabs.length > 0 || diffTab ? (
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex h-full flex-col">
          {activeTab !== 'diff' && activeTab && (
            <AssetEditorHeader
              fileName={activeTab.split('/').pop() || activeTab}
              dirPath={activeTab.includes('/') ? activeTab.slice(0, activeTab.lastIndexOf('/')) : ''}
              sourcePath={activeTab}
              dirty={openTabs.find((tab) => tab.path === activeTab)?.isDirty}
            />
          )}
          <div className="flex items-center border-b bg-muted/20">
            <ScrollArea className="w-full flex-1 whitespace-nowrap">
              <TabsList className="h-auto w-max justify-start rounded-none bg-transparent p-0">
                {openTabs.map((tab) => {
                  const file = openFiles.find((f) => f.path === tab.path);
                  return file ? (
                    <TabsTrigger
                      key={tab.path}
                      value={tab.path}
                      className="group relative flex items-center gap-1 rounded-none border-e px-4 py-2 data-[state=active]:bg-background data-[state=active]:shadow-none"
                    >
                      <span className="max-w-[120px] truncate text-sm">
                        {file.path?.split('/')?.pop()}
                        {tab.isDirty && '*'}
                      </span>
                      {tab.isPinned ? (
                        <div
                          className="ms-1 flex h-4 w-4 cursor-pointer items-center justify-center rounded p-0 opacity-50 hover:opacity-100"
                          onClick={(e) => {
                            e.stopPropagation();
                            togglePinTab(tab.path);
                          }}
                        >
                          <Pin className="h-3 w-3" />
                        </div>
                      ) : (
                        <>
                          <div
                            className="ms-1 flex h-4 w-4 cursor-pointer items-center justify-center rounded p-0 opacity-0 transition-opacity hover:opacity-100 group-hover:opacity-50"
                            onClick={(e) => {
                              e.stopPropagation();
                              togglePinTab(tab.path);
                            }}
                          >
                            <Pin className="h-3 w-3 rotate-45" />
                          </div>
                          <div
                            className="ms-1 flex h-4 w-4 cursor-pointer items-center justify-center rounded p-0 opacity-50 hover:opacity-100"
                            onClick={(e) => {
                              e.stopPropagation();
                              closeFile(tab.path);
                            }}
                          >
                            <X className="h-3 w-3" />
                          </div>
                        </>
                      )}
                    </TabsTrigger>
                  ) : null;
                })}
                {diffTab && (
                  <TabsTrigger
                    value="diff"
                    className="group relative flex items-center gap-1 rounded-none border-e px-4 py-2 data-[state=active]:bg-background data-[state=active]:shadow-none"
                  >
                    <span className="text-sm">
                      <Trans>Diff</Trans>
                    </span>
                    <div
                      className="flex h-4 w-4 cursor-pointer items-center justify-center rounded-sm p-0 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDiffTab(null);
                        if (openTabs.length > 0) {
                          setActiveTab(openTabs[openTabs.length - 1].path);
                        }
                      }}
                    >
                      <X className="h-3 w-3" />
                    </div>
                  </TabsTrigger>
                )}
              </TabsList>
              <ScrollBar orientation="horizontal" />
            </ScrollArea>
          </div>

          {openTabs.map((tab) => {
            const file = openFiles.find((f) => f.path === tab.path);
            return (
              <TabsContent key={tab.path} value={tab.path} className="m-0 h-full p-0">
                <EditorPane
                  readOnly={readOnly}
                  file={file}
                  revealLine={tab.path === activeTab ? deepLink : null}
                  onExecuteScript={expandTerminal}
                  onShellCmd={(command) => {
                    handleShellCommand(command).catch((error) => {
                      console.error('Error executing shell command:', error);
                    });
                  }}
                  onDirtyChange={tab.onDirtyChange}
                />
              </TabsContent>
            );
          })}
          {diffTab && (
            <TabsContent value="diff" className="m-0 h-full p-0">
              <DiffViewer checkpoint_hash={diffTab.checkpoint_hash} />
            </TabsContent>
          )}
        </Tabs>
      ) : (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <div className="text-center">
            <p className="text-lg">
              <Trans>No files open</Trans>
            </p>
          </div>
        </div>
      )}
    </div>
  );

  const renderTerminalPanel = () => (
    <div data-testid="terminal-panel" className="flex h-full flex-col border-t bg-muted/20">
      <div className="flex items-center justify-between border-b bg-muted/50 p-2">
        <h3 className="flex text-sm font-medium text-foreground">
          <TerminalIcon className="me-2 h-4 w-4" />
          <Trans>Shell</Trans>
        </h3>

        <Button variant="ghost" size="icon" onClick={toggleTerminal} className="h-6 w-6" title={t`Toggle terminal`}>
          {isTerminalExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
        </Button>
      </div>
      <div className="flex-1 overflow-hidden">
        <TabbedTerminal className="h-full" />
      </div>
    </div>
  );

  if (!projectTypeId) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center text-muted-foreground">
        <p className="text-sm">
          <Trans>No project context available</Trans>
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="flex h-full w-full flex-col bg-background">
        {renderEditorContent()}
        {/* eslint-disable-next-line no-constant-binary-expression */}
        {false && renderTerminalPanel()}
        {/* eslint-disable-next-line no-constant-binary-expression */}
        {false && (
          <ResizablePanelGroup direction="horizontal">
            <ResizablePanel />
            <ResizableHandle />
            <ResizablePanel />
          </ResizablePanelGroup>
        )}
      </div>

      {/* File creation dialog */}

      {/* Folder creation dialog */}
    </>
  );
};

export default CodeEditor;
