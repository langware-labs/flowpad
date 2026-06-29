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
import { WebappViewer } from '@src/components/webapp-viewer';
import { WorkflowsPage } from '@src/components/workflows-view/WorkflowsPage';
import { useActiveViewer } from '@src/hooks/flow-hooks';
import { useViewerStore } from '@src/hooks/flow-hooks/useViewerStore';
import { useEnvVarsStore } from '@src/hooks/use-env-vars-store';
import { Tab } from '@sdk';
import { useTerminalTabs } from '@src/tabs/useTabs';
import { DockPointer } from '@src/navigation/DockPointer';
import { NavigatorSlot } from '@src/navigation/NavigatorSlot';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { SpecRoute } from '@src/pages/spec/SpecRoute';
import { GraphContextViewer } from '@src/components/graph-context/GraphContextViewer';
import { DiagnosisViewer } from '@src/components/diagnosis-viewer/DiagnosisViewer';
import { useSendMessageStore } from '@src/store/use-send-message-store';
import { useSurveyStore } from '@src/store/use-survey-store';
import { TabLifecycleState, useTabLifecycle } from '@src/tabs/tab-lifecycle';
import { DockLoadErrorView } from '@src/components/agent-layout/DockLoadErrorView';
import { useDockLoadError } from '@src/routes/loaders/dock-load-error-store';
import { ViewType, VIEWER_REGISTRY } from '@src/types/ViewType';
import { AlertTriangle, LogIn } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';

// Lazy-loaded: GraphView pulls in sigma.js + @sigma/node-image, which run
// WebGL init (gl.getParameter) at module load. Importing it eagerly crashes
// the entire app in any WebGL-less context (headless browsers, GPU-disabled
// CI, software-render fallbacks). Loading it only when the graph tab opens
// keeps app bootstrap independent of WebGL availability.
const GraphView = lazy(() => import('@src/components/graph-view/GraphView').then((m) => ({ default: m.GraphView })));
const DocsGraphView = lazy(() =>
  import('@src/components/graph-view/DocsGraphView').then((m) => ({ default: m.DocsGraphView })),
);
import { UserDropdown } from './user-dropdown/user-dropdown';
import { UnifiedTabStrip } from './unified-tab-strip';
import { Trans } from '@lingui/react/macro';

export function ContentPanel() {
  // Get navigation instance for URL-first architecture
  const { navigation, currentDock, isDockUrl, windowMode } = useDockNavigation();
  const activeLifecycle = useTabLifecycle(currentDock?.tabHash);
  const dockLoadError = useDockLoadError(currentDock);

  const { user } = useAuth();

  const { flow, agent } = useAgentContext();
  const { project: contextProject } = useContext();

  // Sync flow focus and URL dock state to viewer store
  useActiveViewer(flow);

  const terminalTabs = useTerminalTabs();

  /** Navigate to a terminal tab by its dockPointer. */
  const navigateToTab = useCallback(
    (tab: Tab) => {
      if (tab.dockPointer) navigation.openDock(tab.dockPointer);
    },
    [navigation],
  );

  // State from viewer store (overview-axis only — the header tab membership
  // moved to the unified TabStrip, tab-management.md Part 3 U1)
  const { currentContext } = useViewerStore();

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


  // Shell entity sync is automatic via DataOp stream — no manual sync needed.

  // React to shouldOpenEnvironmentTab flag
  useEffect(() => {
    setOpenEnvironmentTab(() => navigation.openTab(ViewType.ENVIRONMENT));
  }, [navigation, setOpenEnvironmentTab]);

  // When the URL's active terminal is closing (is_disabled), redirect to the
  // first alive tab. A pointer-less shell URL is loader-owned (the loader
  // resolves the default target), so we only act when a tab matches the URL.
  useEffect(() => {
    if (currentDock?.viewType !== ViewType.SHELL || !currentDock.pointer) return;
    const active = terminalTabs.find((t) => t.dockPointer?.tabHash === currentDock.tabHash);
    if (active?.is_disabled) {
      const alive = terminalTabs.find((t) => t.id !== active.id && !t.is_disabled);
      if (alive) navigateToTab(alive);
    }
  }, [currentDock, navigateToTab, terminalTabs]);

  const { editorActivePath, checkpointHash } = useMemo(() => {
    return {
      editorActivePath: currentContext?.codeRef?.path,
      checkpointHash: currentContext?.viewerOptions?.checkpointHash,
    };
  }, [currentContext]);

  // The body's viewType is the URL's dock viewType; no dock URL → Home (the
  // landing). URL-first: the URL is the single source of "what's shown".
  const bodyViewType = isDockUrl && currentDock?.viewType ? currentDock.viewType : ViewType.HOME;
  const activeOpenFailed = activeLifecycle?.state === TabLifecycleState.OpenFailed;

  // Chrome-less when the surface is full-bleed (Home — a welcome landing, not a
  // tabbed workspace) or in the win/ focus layout. `chrome` (the registry
  // "takeover" bit) is separate from `DockPointer.tabHash` (chip-or-not).
  const hideChrome = windowMode || VIEWER_REGISTRY[bodyViewType]?.chrome === 'fullbleed';

  // File manager filters
  const [enabledFilters, setEnabledFilters] = useState<FilterName[]>([FilterName.HIDDEN]);

  // The single body switch (one place, was duplicated between the overview slot
  // and a per-viewType TabsContent ladder). Renders the surface for `vt`; only
  // the active body is mounted (matches the old radix Tabs, which did not
  // forceMount). `null`/unknown → the Home landing.
  const renderBody = (vt: ViewType | null) => {
    if (dockLoadError) {
      return <DockLoadErrorView error={dockLoadError} />;
    }

    if (activeOpenFailed) {
      return (
        <div
          className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground"
          data-testid="tab-open-failed-placeholder"
        >
          <AlertTriangle className="h-9 w-9 text-destructive" />
          <div>
            <h2 className="text-base font-semibold text-foreground"><Trans>Tab failed to open</Trans></h2>
            <p className="mt-1 max-w-md text-sm">
              {activeLifecycle?.error || <Trans>The tab content could not be prepared.</Trans>}
            </p>
          </div>
        </div>
      );
    }

    switch (vt) {
      case ViewType.SHELL:
        return <TabbedTerminal className="h-full" />;
      case ViewType.EDITOR:
        return <CodeEditor activePath={editorActivePath} />;
      case ViewType.WEB_APP:
        return <WebappViewer onWebappErrorRetry={onWebappErrorRetry} />;
      case ViewType.DIFF:
        return checkpointHash ? (
          <DiffViewer checkpoint_hash={checkpointHash} />
        ) : (
          <div className="p-4 text-gray-500"><Trans>No checkpoint selected</Trans></div>
        );
      case ViewType.MARKDOWN:
        return <MarkdownViewer />;
      case ViewType.SURVEY:
        return activeSurveyData && onSurveyComplete ? (
          <SurveyView surveyData={activeSurveyData} onComplete={onSurveyComplete} />
        ) : (
          <div className="p-6 text-muted-foreground"><Trans>No active survey</Trans></div>
        );
      case ViewType.SYSTEM_PROFILE:
        return <LiveStatus />;
      case ViewType.ENVIRONMENT:
        return user?.id && dataContext.project?.typeId ? (
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
              <h2 className="text-lg font-semibold"><Trans>Login Required</Trans></h2>
              <p className="mt-1 text-sm text-gray-500"><Trans>Please log in to view and manage environment variables.</Trans></p>
            </div>
            <Button onClick={() => void navigator.navigateToLogin()} className="px-6">
              <Trans>Login</Trans>
            </Button>
          </div>
        );
      case ViewType.CONNECTIONS:
        return (
          <ConnectionsManager
            connections={connections}
            currentProject={contextProject?.typeId}
            onConnectionConnect={handleConnectionConnect}
            onConnectionDisconnect={handleConnectionDisconnect}
          />
        );
      case ViewType.API_KEYS:
        return <ApiKeysView />;
      case ViewType.AI_CONFIG:
        return <AIConfigView />;
      case ViewType.HOOKS:
        return <HooksManager />;
      case ViewType.ARTIFACTS:
        return <ArtifactsView />;
      case ViewType.DOCS:
        return <DocsViewer />;
      case ViewType.PLAN:
        return <SpecEditor />;
      case ViewType.ASSISTANCE:
        return agent?.site_config?.feature_flags?.enable_escalation ? <AssistanceViewer /> : null;
      case ViewType.MACHINE:
        return <MachineOverview />;
      case ViewType.EXPLORER:
        return (
          <ExplorerView
            filterDefinitions={getAllFilterDefinitions()}
            enabledFilters={enabledFilters}
            onEnabledFiltersChange={setEnabledFilters}
            onFileSelect={handleExplorerFileSelect}
          />
        );
      case ViewType.TRIGGERS:
      case ViewType.CRON:
        return <TriggersView />;
      case ViewType.CAPABILITIES:
        return <CapabilitiesView />;
      case ViewType.EXECUTE_FLOW:
        return <ExecuteFlowView />;
      case ViewType.SHOW:
        return <ShowView />;
      case ViewType.APPS:
        return <AppHost />;
      case ViewType.GRAPH:
        return (
          <Suspense fallback={null}>
            <GraphView />
          </Suspense>
        );
      case ViewType.K_BROWSER:
        return (
          <Suspense fallback={null}>
            <DocsGraphView />
          </Suspense>
        );
      case ViewType.LENS:
        return <LensViewer />;
      case ViewType.TASKS:
        return <TasksViewer />;
      case ViewType.SETTINGS:
        return <SettingsView />;
      case ViewType.SEARCH:
        return <SearchView />;
      case ViewType.WORKFLOWS:
        return <WorkflowsPage />;
      case ViewType.AGENTIC_PROCESS:
        return currentDock?.pointer ? (
          <ProcessTerminal key={currentDock.pointer} processId={currentDock.pointer} />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground"><Trans>No process ID specified</Trans></div>
        );
      case ViewType.ASSETS:
      case ViewType.PROJECT:
        return <AssetsPage />;
      case ViewType.INBOX:
        return <InboxView />;
      case ViewType.CONVERSATION:
        return <ConversationRoute />;
      case ViewType.SPEC:
        return <SpecRoute />;
      case ViewType.GRAPH_CONTEXT:
        return <GraphContextViewer pointer={currentDock?.pointer} />;
      case ViewType.DIAGNOSIS:
        return <DiagnosisViewer pointer={currentDock?.pointer} />;
      case ViewType.HOME:
      default:
        return <HomeLanding />;
    }
  };

  return (
    <div data-testid="content-panel" className="flex h-full w-full flex-col bg-background">
      {/* Simple header - show UserDropdown only for non-logged-in users */}
      {!user && !hideChrome && (
        <div className="flex items-center justify-end border-b bg-muted/30 px-3 py-1.5">
          <UserDropdown />
        </div>
      )}

      {/* Unified tab strip — hidden in the win/ focus layout and on the Home
          landing (full-bleed). The body below renders the URL-derived view. */}
      {!hideChrome && <UnifiedTabStrip />}

      {/* Zone B — shared left-menu slot, now nested UNDER the tab strip so the
          active view's navigator (assets tree / workflows / docs / triggers /
          chats) is scoped to the current tab's content row rather than spanning
          the full app height beside the tabs. The `border-t` draws the tab
          body's top edge; the active chip's `-mb-px border-b-transparent`
          opens its bottom over this line, so the menu + body read as one panel
          hanging from the current tab (the folder-tab continuum). */}
      <div className={`flex min-h-0 flex-1 overflow-hidden ${!hideChrome ? 'border-t border-border' : ''}`}>
        <NavigatorSlot />

        <div className="relative min-h-0 flex-1 overflow-hidden">
          {/* Matches the proven per-viewType slot layout (plain h-full, no flex-col)
              so xterm fits on first paint — a flex-col parent broke its initial sizing. */}
          <div className="absolute inset-0 mt-0 h-full flex-1 animate-fade-in overflow-auto shadow-lg">
            {renderBody(bodyViewType)}
          </div>
        </div>
      </div>
    </div>
  );
}
