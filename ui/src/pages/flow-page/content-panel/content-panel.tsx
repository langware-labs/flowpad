import { SpecEditor } from '@src/components/spec-editor/SpecEditor';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { AIConfigView } from '@src/components/ai-config-view';
import { ApiKeysView } from '@src/components/api-keys-view/api-keys-view';
import { ArtifactsView } from '@src/components/artifacts';
import { AssistanceViewer } from '@src/components/assistance-viewer/AssistanceViewer';
import CodeEditor from '@src/components/code-editor/CodeEditor';
import DiffViewer from '@src/components/code-editor/DiffViewer';
import { DocsViewer } from '@src/components/docs-viewer/DocsViewer';
import EnvVarsManager from '@src/components/EnvVarsManager';
import { ExecuteFlowView } from '@src/components/execute-flow-view';
import { ExplorerView } from '@src/components/explorer-view';
import { HooksManager } from '@src/components/hooks-manager';
import { LensViewer } from '@src/components/lens-viewer';
import { MachineOverview } from '@src/components/machine-overview/machine-overview';
import { MarkdownViewer } from '@src/components/markdown-viewer';
import { ProcessTerminal } from '@src/components/process-terminal';
import { SettingsView } from '@src/components/settings-view/SettingsView';
import { ShowView } from '@src/components/show-view/ShowView';
import { AppHost } from '@src/components/app-host/AppHost';
import { FilterName, getAllFilterDefinitions } from '@src/components/simple-file-manager';
import { TasksViewer } from '@src/components/tasks-viewer/TasksViewer';
import { HomeLanding } from '@src/pages/home-landing';
import { LiveStatus } from '@src/pages/live-status';
import { SearchView } from '@src/pages/search-view/SearchView';

import { ConnectionStatus, dataContext, navigator, type OAuthConnection } from '@sdk';
import { useAuth, useContext } from '@sdk/react/hooks';
import { AssetsPage } from '@src/components/assets/AssetsPage';
import { ConnectionsManager } from '@src/components/connections-manager';
import { CapabilitiesView } from '@src/components/capabilities-view';
import { ConversationRoute } from '@src/components/conversation';
import { InboxView } from '@src/components/inbox-view/InboxView';
import { SurveyView } from '@src/components/survey/SurveyView';
import { TabbedTerminal } from '@src/components/terminal';
import { TriggersView } from '@src/components/triggers-view';
import { Button } from '@src/components/ui/button';
import { Tabs, TabsContent } from '@src/components/ui/tabs';
import { WebappViewer } from '@src/components/webapp-viewer';
import { WorkflowsPage } from '@src/components/workflows-view/WorkflowsPage';
import { useActiveViewer } from '@src/hooks/flow-hooks';
import { useViewerStore } from '@src/hooks/flow-hooks/useViewerStore';
import { useEnvVarsStore } from '@src/hooks/use-env-vars-store';
import { type TabRow } from '@sdk';
import { useTerminalTabRows } from '@src/tabs/useTabs';
import { DockPointer } from '@src/navigation/DockPointer';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { SpecRoute } from '@src/pages/spec/SpecRoute';
import { useSendMessageStore } from '@src/store/use-send-message-store';
import { useSurveyStore } from '@src/store/use-survey-store';
import { ViewType } from '@src/types/ViewType';
import { LogIn } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';

// Lazy-loaded: GraphView pulls in sigma.js + @sigma/node-image, which run
// WebGL init (gl.getParameter) at module load. Importing it eagerly crashes
// the entire app in any WebGL-less context (headless browsers, GPU-disabled
// CI, software-render fallbacks). Loading it only when the graph tab opens
// keeps app bootstrap independent of WebGL availability.
const GraphView = lazy(() =>
  import('@src/components/graph-view/GraphView').then((m) => ({ default: m.GraphView })),
);
const DocsGraphView = lazy(() =>
  import('@src/components/graph-view/DocsGraphView').then((m) => ({ default: m.DocsGraphView })),
);
import { UserDropdown } from './user-dropdown/user-dropdown';
import { UnifiedTabStrip } from './unified-tab-strip';

// Overview slots that render a real workspace surface (not the Home landing).
// Every other `currentOverviewTab` value — HOME, CHAT, null, … — falls through
// to <HomeLanding /> in the overview panel below, so the overview is "home"
// exactly when its slot is NOT one of these. Keep in sync with the overview
// TabsContent switch.
const OVERVIEW_NON_HOME_SLOTS = new Set<ViewType>([
  ViewType.SHELL,
  ViewType.EDITOR,
  ViewType.WEB_APP,
  ViewType.DIFF,
  ViewType.MARKDOWN,
  ViewType.SURVEY,
  ViewType.SYSTEM_PROFILE,
]);

export function ContentPanel() {
  // Get navigation instance for URL-first architecture
  const { navigation, currentDock, isDockUrl, windowMode } = useDockNavigation();

  const { user } = useAuth();

  const { flow, agent, computeNode } = useAgentContext();
  const { project: contextProject } = useContext();

  // Sync flow focus and URL dock state to viewer store
  useActiveViewer(flow);

  const terminalRows = useTerminalTabRows();

  /** Navigate to a terminal tab row by its pointer (tabHash). */
  const navigateToRow = useCallback(
    (row: TabRow) => {
      const dock = DockPointer.fromTabHash(row.pointer);
      if (dock) navigation.openDock(dock);
    },
    [navigation],
  );

  // State from viewer store (overview-axis only — the header tab membership
  // moved to the unified TabStrip, tab-management.md Part 3 U1)
  const { currentOverviewTab, currentContext } = useViewerStore();

  // Survey state (shared with chat-panel)
  const { activeSurveyData, onSurveyComplete } = useSurveyStore();
  const { addEnvVar, deleteEnvVar } = useEnvVarsStore();
  const [connections, setConnections] = useState<OAuthConnection[]>([]);

  const handleConnectionConnect = useCallback((connectionId: string) => {
    setConnections((prev) =>
      prev.map((conn) =>
        conn.id === connectionId ? { ...conn, status: ConnectionStatus.CONNECTED, connectedAt: new Date() } : conn,
      ),
    );
  }, []);

  const handleConnectionDisconnect = useCallback((connectionId: string) => {
    setConnections((prev) =>
      prev.map((conn) => (conn.id === connectionId ? { ...conn, status: ConnectionStatus.DISCONNECTED } : conn)),
    );
  }, []);

  const { setOpenEnvironmentTab } = useEnvVarsStore();

  const { sendMessage } = useSendMessageStore();

  const onWebappErrorRetry = useCallback(
    (retryMessage: string) => {
      if (sendMessage) {
        void sendMessage(retryMessage, {});
      }
    },
    [sendMessage],
  );

  const handleExplorerFileSelect = useCallback(
    (path: string) => {
      navigation.openDock(DockPointer.forFile(path));
    },
    [navigation],
  );

  const handleExplorerPathChange = useCallback(
    (path: string) => {
      navigation.openDock(DockPointer.forExplorer(path));
    },
    [navigation],
  );

  // Shell entity sync is automatic via DataOp stream — no manual sync needed.

  // React to shouldOpenEnvironmentTab flag
  useEffect(() => {
    setOpenEnvironmentTab(() => navigation.openTab(ViewType.ENVIRONMENT));
  }, [navigation, setOpenEnvironmentTab]);

  // When the URL's active terminal is closing (is_disabled), redirect to the
  // first alive tab. A pointer-less shell URL is loader-owned (the loader
  // resolves the default target), so we only act when a row matches the URL.
  useEffect(() => {
    if (currentDock?.viewType !== ViewType.SHELL || !currentDock.pointer) return;
    const active = terminalRows.find((r) => r.pointer === currentDock.tabHash);
    if (active?.is_disabled) {
      const alive = terminalRows.find((r) => r.pointer !== active.pointer && !r.is_disabled);
      if (alive) navigateToRow(alive);
    }
  }, [currentDock, navigateToRow, terminalRows]);

  const { editorActivePath, checkpointHash } = useMemo(() => {
    return {
      editorActivePath: currentContext?.codeRef?.path,
      checkpointHash: currentContext?.viewerOptions?.checkpointHash,
    };
  }, [currentContext]);

  // Get current tab from URL (URL-first architecture)
  const currentTab = isDockUrl && currentDock?.viewType ? currentDock.viewType : 'overview';

  // Chrome-less mode hides the unified tab strip header (and the logged-out
  // user header) so the routed view content is the entire window. Two cases,
  // both URL/state-derived:
  //   1. the `win/` focus-window layout (tab-management.md Part 3 §7) — the
  //      FocusLayout reuses this component instead of duplicating the panel.
  //   2. the Home landing — a full-bleed welcome surface, not a tabbed
  //      workspace, so the strip must not render over it. Home shows on the
  //      dedicated HOME dock, or as the overview's default fall-through slot.
  const isHomeView =
    currentTab === ViewType.HOME ||
    (currentTab === 'overview' && !OVERVIEW_NON_HOME_SLOTS.has(currentOverviewTab as ViewType));
  const hideChrome = windowMode || isHomeView;

  // File manager filters
  const [enabledFilters, setEnabledFilters] = useState<FilterName[]>([FilterName.HIDDEN]);

  return (
    <div data-testid="content-panel" className="flex h-full flex-col bg-background">
      <Tabs
        value={currentTab}
        onValueChange={(value) => {
          // Always navigate - URL-first architecture
          if (value === 'overview') {
            navigation.closeDock();
          } else {
            navigation.openTab(value as ViewType);
          }
        }}
        className="flex h-full w-full flex-col"
      >
        {/* Simple header - show UserDropdown only for non-logged-in users */}
        {!user && !hideChrome && (
          <div className="flex items-center justify-end border-b bg-muted/30 px-3 py-1.5">
            <UserDropdown />
          </div>
        )}

        {/* Unified tab strip (tab-management.md Part 3 §6): terminal tabs +
            entity member tabs + the transient preview slot + the global
            section, replacing the viewer tab header. The TabsContent panels
            below keep rendering keyed by the URL-derived current ViewType.
            Hidden in the win/ focus-window layout (§7): no strip, no chrome. */}
        {!hideChrome && <UnifiedTabStrip />}

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <TabsContent
            value="overview"
            className="absolute inset-0 mt-0 flex h-full flex-1 animate-fade-in flex-col shadow-lg data-[state=inactive]:hidden"
          >
            <div className="min-h-0 flex-1 overflow-auto">
              {currentOverviewTab === ViewType.SHELL ? (
                <TabbedTerminal className="h-full" />
              ) : currentOverviewTab === ViewType.EDITOR ? (
                <CodeEditor activePath={editorActivePath} />
              ) : currentOverviewTab === ViewType.WEB_APP ? (
                <WebappViewer onWebappErrorRetry={onWebappErrorRetry} />
              ) : currentOverviewTab === ViewType.DIFF ? (
                checkpointHash ? (
                  <DiffViewer checkpoint_hash={checkpointHash} />
                ) : (
                  <div className="p-4 text-gray-500">No checkpoint selected</div>
                )
              ) : currentOverviewTab === ViewType.MARKDOWN ? (
                <MarkdownViewer />
              ) : currentOverviewTab === ViewType.SURVEY ? (
                activeSurveyData && onSurveyComplete ? (
                  <SurveyView surveyData={activeSurveyData} onComplete={onSurveyComplete} />
                ) : (
                  <div className="p-6 text-muted-foreground">No active survey</div>
                )
              ) : currentOverviewTab === ViewType.HOME ? (
                <HomeLanding />
              ) : currentOverviewTab === ViewType.SYSTEM_PROFILE ? (
                <LiveStatus />
              ) : (
                <HomeLanding />
              )}
            </div>
          </TabsContent>

          <TabsContent
            value={ViewType.SHELL}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in overflow-auto shadow-lg data-[state=inactive]:hidden"
          >
            <TabbedTerminal className="h-full" />
          </TabsContent>

          <TabsContent
            value={ViewType.EDITOR}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <CodeEditor activePath={editorActivePath} />
          </TabsContent>

          <TabsContent
            value={ViewType.WEB_APP}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in overflow-auto shadow-lg data-[state=inactive]:hidden"
          >
            <WebappViewer onWebappErrorRetry={onWebappErrorRetry} />
          </TabsContent>

          <TabsContent
            value={ViewType.ENVIRONMENT}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            {user?.id && dataContext.project?.typeId ? (
              <EnvVarsManager
                entityTypeId={dataContext.project.typeId}
                onEnvVarSaved={addEnvVar}
                onEnvVarDeleted={deleteEnvVar}
                onEnvVarUpdated={() => {
                  // noteItemUpdated was a Flow entity method - no-op for now
                }}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-4 rounded-lg border border-dashed border-gray-200 p-6 text-center">
                <LogIn className="h-10 w-10 text-gray-400" />
                <div>
                  <h2 className="text-lg font-semibold">Login Required</h2>
                  <p className="mt-1 text-sm text-gray-500">Please log in to view and manage environment variables.</p>
                </div>
                <Button onClick={() => navigator.navigateToLogin()} className="px-6">
                  Login
                </Button>
              </div>
            )}
          </TabsContent>

          <TabsContent
            value={ViewType.CONNECTIONS}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <ConnectionsManager
              connections={connections}
              currentProject={contextProject?.typeId}
              onConnectionConnect={handleConnectionConnect}
              onConnectionDisconnect={handleConnectionDisconnect}
            />
          </TabsContent>

          <TabsContent
            value={ViewType.API_KEYS}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <ApiKeysView />
          </TabsContent>

          <TabsContent
            value={ViewType.AI_CONFIG}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <AIConfigView />
          </TabsContent>

          <TabsContent
            value={ViewType.HOOKS}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <HooksManager />
          </TabsContent>

          <TabsContent
            value={ViewType.ARTIFACTS}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <ArtifactsView />
          </TabsContent>

          <TabsContent
            value={ViewType.DIFF}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            {checkpointHash ? (
              <DiffViewer checkpoint_hash={checkpointHash} />
            ) : (
              <div className="p-4 text-gray-500">No checkpoint selected</div>
            )}
          </TabsContent>

          <TabsContent
            value={ViewType.DOCS}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <DocsViewer />
          </TabsContent>

          <TabsContent
            value={ViewType.PLAN}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <SpecEditor />
          </TabsContent>

          {agent?.site_config?.feature_flags?.enable_escalation && (
            <TabsContent
              value={ViewType.ASSISTANCE}
              className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
            >
              <AssistanceViewer />
            </TabsContent>
          )}

          <TabsContent
            value={ViewType.MACHINE}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <MachineOverview />
          </TabsContent>

          <TabsContent
            value={ViewType.EXPLORER}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <ExplorerView
              filterDefinitions={getAllFilterDefinitions()}
              enabledFilters={enabledFilters}
              onEnabledFiltersChange={setEnabledFilters}
              onFileSelect={handleExplorerFileSelect}
              onPathChange={handleExplorerPathChange}
            />
          </TabsContent>

          <TabsContent
            value={ViewType.TRIGGERS}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <TriggersView />
          </TabsContent>

          <TabsContent
            value={ViewType.CAPABILITIES}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <CapabilitiesView />
          </TabsContent>

          <TabsContent
            value={ViewType.CRON}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <TriggersView />
          </TabsContent>

          <TabsContent
            value={ViewType.EXECUTE_FLOW}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <ExecuteFlowView />
          </TabsContent>

          <TabsContent
            value={ViewType.SHOW}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <ShowView />
          </TabsContent>

          <TabsContent
            value={ViewType.APPS}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <AppHost />
          </TabsContent>

          <TabsContent
            value={ViewType.GRAPH}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <Suspense fallback={null}>
              <GraphView />
            </Suspense>
          </TabsContent>

          <TabsContent
            value={ViewType.K_BROWSER}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <Suspense fallback={null}>
              <DocsGraphView />
            </Suspense>
          </TabsContent>

          <TabsContent
            value={ViewType.HOME}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <HomeLanding />
          </TabsContent>

          <TabsContent
            value={ViewType.SYSTEM_PROFILE}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <LiveStatus />
          </TabsContent>

          <TabsContent
            value={ViewType.LENS}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <LensViewer />
          </TabsContent>

          <TabsContent
            value={ViewType.TASKS}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <TasksViewer />
          </TabsContent>

          <TabsContent
            value={ViewType.SETTINGS}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <SettingsView />
          </TabsContent>

          <TabsContent
            value={ViewType.SEARCH}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <SearchView />
          </TabsContent>

          <TabsContent
            value={ViewType.WORKFLOWS}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <WorkflowsPage />
          </TabsContent>

          <TabsContent
            value={ViewType.AGENTIC_PROCESS}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            {currentDock?.pointer ? (
              <ProcessTerminal key={currentDock.pointer} processId={currentDock.pointer} />
            ) : (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                No process ID specified
              </div>
            )}
          </TabsContent>

          <TabsContent
            value={ViewType.ASSETS}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <AssetsPage />
          </TabsContent>

          <TabsContent
            value={ViewType.PROJECT}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <AssetsPage />
          </TabsContent>

          <TabsContent
            value={ViewType.INBOX}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <InboxView />
          </TabsContent>

          <TabsContent
            value={ViewType.CONVERSATION}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <ConversationRoute />
          </TabsContent>

          <TabsContent
            value={ViewType.SPEC}
            className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in shadow-lg data-[state=inactive]:hidden"
          >
            <SpecRoute />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}
