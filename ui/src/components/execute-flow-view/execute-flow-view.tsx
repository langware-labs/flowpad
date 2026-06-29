import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { ClaudeTerminal } from '@src/components/claude-terminal';
import { DirectoryTree, FilterDefinition } from '@src/components/directory-tree';
import { FSItem, fsManager, InstructionFile, SKILLS_FOLDER_PATH, VFSPath } from '@sdk';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@src/components/ui/tabs';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@src/components/ui/resizable';
import { GitBranch, ScrollText } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trans } from '@lingui/react/macro';
import { FlowsPanel, FlowsPanelRef } from './flows-panel';
import { useProcessExecutor } from './hooks/use-process-executor';
import { InstructionPanel } from './instruction-panel/instruction-panel';
import { WorkerSessionsPanel } from './worker-sessions-panel';

// Feature flags for hiding panels (set to true to show, false to hide)
const SHOW_WORKER_SESSIONS_PANEL = false;
const SHOW_RIGHT_PANEL = false;

export function ExecuteFlowView() {
  const { agent, project } = useAgentContext();
  const { navigation, currentDock } = useDockNavigation();
  const flowsPanelRef = useRef<FlowsPanelRef>(null);

  const {
    context,
    loadFile,
    startExecution,
    stopExecution,
    clearContext,
    skipInstruction,
    retryInstruction,
    toggleExpand,
  } = useProcessExecutor(agent, project);

  // Get VFS absolute path from dock options and parse it using VFSPath
  // VFSPath normalizes the path (strips vfs:// protocol) for consistent path matching
  const activeVfsPath = useMemo(() => {
    return VFSPath.parse(currentDock?.options?.vfsAbsPath);
  }, [currentDock?.options?.vfsAbsPath]);

  // Create FSItem from parsed VFSPath for file operations
  const activeFile = useMemo(() => {
    if (!activeVfsPath.isAbsolute) return null;
    try {
      // Use the normalized absVfsPath (without vfs:// protocol)
      return new FSItem({ vfs_abs_path: activeVfsPath.absVfsPath });
    } catch {
      console.error('[ExecuteFlowView] Invalid vfsAbsPath:', activeVfsPath.absVfsPath);
      return null;
    }
  }, [activeVfsPath]);

  // Get current worker session ID from dock options
  // Note: workerSessionId ↔ machineSessionId mapping is not yet implemented
  // The WorkerSessionsPanel returns Claude's internal sessionId (workerSessionId)
  // but navigation currently only supports machineSessionId
  const currentWorkerSessionId = useMemo(() => {
    return currentDock?.options?.machineSessionId || undefined;
  }, [currentDock]);

  // Root folders for DirectoryTree
  const [rootFolders, setRootFolders] = useState<FSItem[]>([]);

  // Track raw file content for editing
  const [fileContent, setFileContent] = useState<string | null>(null);

  // Track file loading state
  const [isLoadingFile, setIsLoadingFile] = useState(false);

  // Reset view state (clears both file content and execution context)
  const resetView = useCallback(() => {
    setFileContent(null);
    clearContext();
  }, [clearContext]);

  // Shared helper to load an FSItem into the instruction panel
  const loadFileFromItem = useCallback(
    async (item: FSItem) => {
      const instructionFile = await InstructionFile.fromItem(item);
      setFileContent(instructionFile.content);
      loadFile(item.vfs_abs_path, instructionFile.getInstructions().getAll());
    },
    [loadFile],
  );

  // Helper to check if a file is markdown-like (.md, .mdo, .md.out)
  const isMarkdownLike = useCallback((fileName: string): boolean => {
    const lowerName = fileName.toLowerCase();
    return lowerName.endsWith('.md') || lowerName.endsWith('.mdo') || lowerName.endsWith('.md.out');
  }, []);

  // Filter definition for markdown-only files (FSItem-based)
  const markdownFilterDefinitions = useMemo<FilterDefinition[]>(
    () => [
      {
        name: 'markdown_only',
        label: 'Markdown files',
        filterFn: (item: FSItem) => {
          const name = item.relativePath?.split('/').pop() || item.name || '';
          return !name.startsWith('.') && (item.is_dir || isMarkdownLike(name));
        },
      },
    ],
    [isMarkdownLike],
  );

  // Initialize root folders with project root folder
  useEffect(() => {
    if (!project?.typeId) {
      setRootFolders([]);
      return;
    }

    // Create project root folder item for the tree
    setRootFolders([
      new FSItem({
        is_dir: true,
        vfs_abs_path: `${project.typeId.toString()}/.`,
        size: 0,
        display_name: project.displayName,
      }),
    ]);
  }, [project?.typeId, project?.displayName]);

  useEffect(() => {
    if (!activeFile) {
      resetView();
      return;
    }
    setIsLoadingFile(true);
    void loadFileFromItem(activeFile).finally(() => setIsLoadingFile(false));
  }, [activeFile, loadFileFromItem, resetView]);

  // Handle tree item selection - only select files, not folders
  const handleTreeSelect = useCallback(
    (item: FSItem | null) => {
      if (item && !item.is_dir) {
        navigation.openExecuteFlow({ file: item });
      }
    },
    [navigation],
  );

  // Track active tab for the right panel
  const [activeTab, setActiveTab] = useState('flows');

  const handleExecute = useCallback(async () => {
    if (!context) return;
    await startExecution();
    flowsPanelRef.current?.refresh();
  }, [context, startExecution]);

  const handleSaveEphemeralPrompt = useCallback(
    async (content: string) => {
      if (!project?.typeId) return;

      // Generate filename with current date and time
      const now = new Date();
      const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const fileName = `prompt-${timestamp}.md`;
      const filePath = `prompts/${fileName}`;

      try {
        // Save the file and navigate to it
        await fsManager.writeFile(project.typeId, filePath, content);
        const vfsAbsPath = `${project.typeId.toString()}/${filePath}`;
        const fsItem = new FSItem({ vfs_abs_path: vfsAbsPath });
        navigation.openExecuteFlow({ file: fsItem });
      } catch (error) {
        console.error('[ExecuteFlowView] Failed to save prompt:', error);
      }
    },
    [project?.typeId, navigation],
  );

  const handleSaveFile = useCallback(
    async (content: string) => {
      if (!activeFile || !project?.typeId) {
        throw new Error('No file to save');
      }
      await fsManager.writeFile(project.typeId, activeFile.relativePath, content);
      await loadFileFromItem(activeFile);
    },
    [activeFile, project?.typeId, loadFileFromItem],
  );

  const handleNewEphemeral = useCallback(() => {
    navigation.openExecuteFlow();
  }, [navigation]);

  const handleRetry = useCallback(
    (instructionId: string) => {
      void retryInstruction(instructionId);
    },
    [retryInstruction],
  );

  const handleWorkerSessionClick = useCallback(
    (workerSessionId: string) => {
      // TODO: Implement workerSessionId → machineSessionId mapping
      // Currently clicking a session doesn't navigate properly because
      // we only have the workerSessionId from Claude's .jsonl files
      // but navigation requires machineSessionId (PTY session ID)
      void workerSessionId; // Parameter unused until mapping is implemented
      navigation.openExecuteFlow();
    },
    [navigation],
  );

  // Handle navigate home - go to execute-flow root (same pattern as SkillsViewer)
  const handleNavigateHome = useCallback(() => {
    navigation.openExecuteFlow();
  }, [navigation]);

  // Handle open external - open project folder in system explorer
  const handleOpenExternal = useCallback(async () => {
    const fsTypeId = project?.typeId;
    if (!fsTypeId || rootFolders.length === 0) {
      console.warn('[ExecuteFlowView] Cannot open in explorer: no project or root folder available');
      return;
    }
    try {
      const projectFolder = rootFolders[0];
      await fsManager.open(fsTypeId, projectFolder.relativePath);
    } catch (error) {
      console.error('[ExecuteFlowView] Failed to open in system explorer:', error);
    }
  }, [project?.typeId, rootFolders]);

  // Calculate panel sizes based on which panels are visible
  const centerPanelSize = SHOW_RIGHT_PANEL ? 40 : 75;

  // Shared DirectoryTree props to avoid duplication
  const directoryTreeProps = useMemo(
    () => ({
      rootFolders,
      selectedPath: activeFile?.vfs_abs_path ?? null,
      homePath: SKILLS_FOLDER_PATH,
      filterDefinitions: markdownFilterDefinitions,
      enabledFilters: ['markdown_only'],
      disableAutoSelect: true,
      events: {
        onSelect: handleTreeSelect,
        onNavigateHome: handleNavigateHome,
        onOpenExternal: () => {
          void handleOpenExternal();
        },
      },
      className: 'h-full',
    }),
    [
      rootFolders,
      activeFile?.vfs_abs_path,
      markdownFilterDefinitions,
      handleTreeSelect,
      handleNavigateHome,
      handleOpenExternal,
    ],
  );

  return (
    <div className="execute-flow-view flex h-full w-full flex-col">
      <div className="min-h-0 flex-1">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          {/* Left panel - Split vertically for tree view and sessions */}
          <ResizablePanel defaultSize={25} minSize={15} maxSize={40}>
            {SHOW_WORKER_SESSIONS_PANEL ? (
              <ResizablePanelGroup direction="vertical" className="h-full">
                {/* Tree view (upper panel) */}
                <ResizablePanel defaultSize={60} minSize={30} maxSize={80}>
                  <DirectoryTree {...directoryTreeProps} />
                </ResizablePanel>
                <ResizableHandle withHandle />
                {/* Sessions panel (lower panel) */}
                <ResizablePanel defaultSize={40} minSize={20} maxSize={70}>
                  <WorkerSessionsPanel
                    currentSessionId={currentWorkerSessionId}
                    onSessionClick={handleWorkerSessionClick}
                  />
                </ResizablePanel>
              </ResizablePanelGroup>
            ) : (
              <DirectoryTree {...directoryTreeProps} />
            )}
          </ResizablePanel>
          <ResizableHandle withHandle />
          {/* Center panel - Instructions */}
          <ResizablePanel defaultSize={centerPanelSize} minSize={30} maxSize={SHOW_RIGHT_PANEL ? 60 : undefined}>
            <InstructionPanel
              context={context}
              fileContent={fileContent}
              isLoading={isLoadingFile}
              onExecute={() => void handleExecute()}
              onExecuteEphemeralPrompt={(content) => void handleSaveEphemeralPrompt(content)}
              onNewEphemeral={handleNewEphemeral}
              onSaveFile={handleSaveFile}
              onStop={stopExecution}
              onRetry={handleRetry}
              onSkip={skipInstruction}
              onToggleExpand={toggleExpand}
            />
          </ResizablePanel>
          {/* Right panel - Tabbed view for Flows and Execution Log */}
          {SHOW_RIGHT_PANEL && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={35} minSize={25} maxSize={50}>
                <Tabs value={activeTab} onValueChange={setActiveTab} className="flex h-full flex-col">
                  <div className="border-b px-2">
                    <TabsList className="h-9 w-full justify-start bg-transparent p-0">
                      <TabsTrigger
                        value="flows"
                        className="flex items-center gap-1.5 rounded-none border-b-2 border-transparent px-3 py-1.5 text-xs data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                      >
                        <GitBranch className="h-3.5 w-3.5" />
                        <Trans>Flows</Trans>
                      </TabsTrigger>
                      <TabsTrigger
                        value="log"
                        className="flex items-center gap-1.5 rounded-none border-b-2 border-transparent px-3 py-1.5 text-xs data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                      >
                        <ScrollText className="h-3.5 w-3.5" />
                        <Trans>Execution Log</Trans>
                      </TabsTrigger>
                    </TabsList>
                  </div>
                  <TabsContent value="flows" className="mt-0 flex-1 overflow-hidden">
                    <FlowsPanel ref={flowsPanelRef} sourceFile={activeFile} />
                  </TabsContent>
                  <TabsContent value="log" className="mt-0 flex-1 overflow-hidden">
                    <div className="p-4 text-muted-foreground"><Trans>No execution log available</Trans></div>
                  </TabsContent>
                </Tabs>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
      {/* Claude Terminal - Shows current running terminal */}
      <ClaudeTerminal />
    </div>
  );
}
