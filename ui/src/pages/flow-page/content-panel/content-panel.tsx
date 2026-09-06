import { PrimaryContentRegion, PrimaryContentFallback } from '@sdk/react/primary-content';
import { SpecEditor } from '@src/components/spec-editor/SpecEditor';
import { useAgentContext } from '@src/components/agent-layout/agent-layout';
import { AIConfigView } from '@src/components/ai-config-view';
import { ArtifactsView } from '@src/components/artifacts';
import { AssistanceViewer } from '@src/components/assistance-viewer/AssistanceViewer';
import CodeEditor from '@src/components/code-editor/CodeEditor';
import { AssetCompareView } from '@src/components/code-editor/AssetCompareView';
import DiffViewer from '@src/components/code-editor/DiffViewer';
import { DocsViewer } from '@src/components/docs-viewer/DocsViewer';
import { ExplorerView } from '@src/components/explorer-view';
import { HooksManager } from '@src/components/hooks-manager';
import { LensViewer } from '@src/components/lens-viewer';
import { MachineOverview } from '@src/components/machine-overview/machine-overview';
import { MarkdownViewer } from '@src/components/markdown-viewer';
import { SettingsView } from '@src/components/settings-view/SettingsView';
import { PreferencesView } from '@src/components/preferences-view/PreferencesView';
import { DesktopPage } from '@src/pages/desktop/DesktopPage';
import { FilterName, getAllFilterDefinitions } from '@src/components/simple-file-manager';
import { TasksRedirect } from '@src/components/tasks-viewer/TasksRedirect';
import { HomeLanding } from '@src/pages/home-landing';
import { HubHome } from '@src/pages/hub-home/HubHome';
import { HubRecordsView } from '@src/pages/hub-browse/HubRecordsView';
import { HubEntityView } from '@src/pages/hub-browse/HubEntityView';
import { HubProjectPage } from '@src/pages/hub-project/HubProjectPage';
import { LiveStatus } from '@src/pages/live-status';
import { SearchView } from '@src/pages/search-view/SearchView';

import { PageId } from '@sdk';
import { useAuth } from '@sdk/react/hooks';
import { AssetsPage } from '@src/components/assets/AssetsPage';
import { HubAssetsPage } from '@src/components/assets/HubAssetsPage';
import { CollaborationPage, LiveSessionView } from '@src/components/collaboration';
import { CredentialsView } from '@src/components/credentials-view/CredentialsView';
import { CapabilitiesView } from '@src/components/capabilities-view';
import { ConversationRoute } from '@src/components/conversation';
import { InboxView } from '@src/components/inbox-view/InboxView';
import { AgentInboxView } from '@src/components/inbox-view/AgentInboxView';
import { TabbedTerminal } from '@src/components/terminal';
import { AppDisplayViewer } from '../app-display-viewer';
import { WebappViewer } from '@src/components/webapp-viewer';
import { useActiveViewer } from '@src/hooks/flow-hooks';
import { useViewerStore } from '@src/hooks/flow-hooks/useViewerStore';
import { Tab, tabForDockKey } from '@sdk';
import { useTerminalTabs, useTabLifecycle } from '@src/tabs/use-tab-manager';
import { DockPointer } from '@src/navigation/DockPointer';
import { appDockAddress } from '@src/navigation/app-dock';
import { NavigatorSlot } from '@src/navigation/NavigatorSlot';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { SpecRoute } from '@src/pages/spec/SpecRoute';
import { GraphContextViewer } from '@src/components/graph-context/GraphContextViewer';
import { DiagnosisViewer } from '@src/components/diagnosis-viewer/DiagnosisViewer';
import { useSurveyStore } from '@src/store/use-survey-store';
import { TabLifecycleState } from '@sdk';
import { DockLoadErrorView } from '@src/components/agent-layout/DockLoadErrorView';
import { useDockLoadError } from '@src/routes/loaders/dock-load-error-store';
import { ViewType, VIEWER_REGISTRY } from '@src/types/ViewType';
import { OrganizationPage } from '@src/components/organization/organization-page';
import { useIsVibe } from '@src/components/view-mode';
import { AlertTriangle } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { lazyWebglView } from '@src/components/graph-view/webglSupport';

// Lazy-loaded: GraphView pulls in sigma.js + @sigma/node-image, which run
// WebGL init (gl.getParameter) at module load. Importing it eagerly crashes
// the entire app in any WebGL-less context (headless browsers, GPU-disabled
// CI, software-render fallbacks). Loading it only when the graph tab opens
// keeps app bootstrap independent of WebGL availability, and the
// Every sigma-bearing view goes through `lazyWebglView`, which keeps the sigma
// chunk from ever being evaluated when WebGL is missing — the tab shows
// WebglUnavailableView instead of crashing. Use it for any new graph view:
// repeating the check by hand is what let TagGraphView and GenericSubgraphView
// ship unguarded.
const GraphView = lazyWebglView(() =>
  import('@src/components/graph-view/GraphView').then((m) => ({ default: m.GraphView })),
);
// Lazy like its neighbours: the portal drags react-markdown + the article
// renderer, which no user who never opens a help desk should pay for.
const HelpdeskPortalPage = lazy(() =>
  import('@src/components/helpdesk/HelpdeskPortalPage').then((m) => ({ default: m.HelpdeskPortalPage })),
);
// Lazy like its neighbours: both hub token screens pull recharts, which no
// user who never opens them should pay for in this chunk.
const LlmSourcesView = lazy(() =>
  import('@src/components/llm-sources/LlmSourcesView').then((m) => ({ default: m.LlmSourcesView })),
);
const LlmEndpointsView = lazy(() =>
  import('@src/components/llm-endpoints/LlmEndpointsView').then((m) => ({ default: m.LlmEndpointsView })),
);
const TokenPlanView = lazy(() =>
  import('@src/components/token-plan/TokenPlanView').then((m) => ({ default: m.TokenPlanView })),
);
const WorldView = lazyWebglView(() =>
  import('@src/components/graph-view/GraphView').then((m) => ({ default: m.WorldView })),
);
const TagGraphView = lazyWebglView(() =>
  import('@src/components/graph-view/TagGraphView').then((m) => ({ default: m.TagGraphView })),
);
const GenericSubgraphView = lazyWebglView(() =>
  import('@src/components/graph-view/SubgraphView').then((m) => ({ default: m.GenericSubgraphView })),
);
// Lazy like GRAPH — keeps @xyflow/react out of app bootstrap.
const GraphWorkflowsView = lazy(() =>
  import('@src/components/graph-workflows/GraphWorkflowsView').then((m) => ({ default: m.GraphWorkflowsView })),
);
const EventsView = lazy(() => import('@src/components/events/EventsView').then((m) => ({ default: m.EventsView })));
const DataSourcesView = lazy(() =>
  import('@src/components/data-sources/DataSourcesView').then((m) => ({ default: m.DataSourcesView })),
);
const RagView = lazy(() => import('@src/components/rag/RagView').then((m) => ({ default: m.RagView })));
const RunsView = lazy(() => import('@src/components/runs/RunsView').then((m) => ({ default: m.RunsView })));
const SurveyView = lazy(() => import('@src/components/survey/SurveyView').then((m) => ({ default: m.SurveyView })));
const ShowView = lazy(() => import('@src/components/show-view/ShowView').then((m) => ({ default: m.ShowView })));
const AppHost = lazy(() => import('@src/components/app-host/AppHost').then((m) => ({ default: m.AppHost })));
const DocsGraphView = lazy(() =>
  import('@src/components/graph-view/DocsGraphView').then((m) => ({ default: m.DocsGraphView })),
);
import { UserDropdown } from './user-dropdown/user-dropdown';
import { UnifiedTabStrip } from './unified-tab-strip';
import { Trans } from '@lingui/react/macro';

// The curated set of "creator" surfaces that get the chrome-less Lovable-style
// Vibe treatment (chat + live preview + code/docs). Anything not here keeps the
// normal Standard chrome even in Vibe so its tabs/navigator remain usable.
const VIBE_CREATOR_SURFACES: ReadonlySet<ViewType> = new Set([
  ViewType.HOME,
  ViewType.CONVERSATION,
  ViewType.SHELL,
  ViewType.AGENTIC_PROCESS,
  ViewType.WEB_APP,
  ViewType.APP,
  ViewType.EDITOR,
  ViewType.DIFF,
  ViewType.MARKDOWN,
  ViewType.DOCS,
  ViewType.PLAN,
  ViewType.SPEC,
]);

/** ``minimalChrome`` forces the chrome-less arrangement (no tab strip / navigator
 *  / border framing) regardless of view mode — used when ContentPanel is embedded
 *  inside a host layout that owns its own chrome (the vibe workspace mounts it as
 *  the display for a child tab). Generalizes the vibe-creator-surface suppression
 *  to any embedded host (future: the win/ layout). */
export function ContentPanel(props: { minimalChrome?: boolean; contentEpoch?: number } = {}) {
  return <PrimaryContentRegion><ContentPanelBody {...props} /></PrimaryContentRegion>;
}

function ContentPanelBody({
  minimalChrome = false,
  contentEpoch,
}: { minimalChrome?: boolean; contentEpoch?: number } = {}) {
  // Get navigation instance for URL-first architecture
  const { navigation, currentDock, isDockUrl, windowMode } = useDockNavigation();
  const activeLifecycle = useTabLifecycle(currentDock?.tabHash);
  const dockLoadError = useDockLoadError(currentDock);

  const { user } = useAuth();

  const { agent } = useAgentContext();

  // Sync flow focus and URL dock state to viewer store
  useActiveViewer();

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

  const handleExplorerFileSelect = useCallback(
    (path: string) => {
      // Extension dispatch (md → assets document viewer, else code editor)
      // lives in openFile — the explorer must not hard-code a viewer.
      navigation.openFile(path);
    },
    [navigation],
  );

  // Shell entity sync is automatic via DataOp stream — no manual sync needed.

  // When the URL's active terminal is closing (is_disabled), redirect to the
  // first alive tab. A pointer-less shell URL is loader-owned (the loader
  // resolves the default target), so we only act when a tab matches the URL.
  useEffect(() => {
    if (currentDock?.viewType !== ViewType.SHELL || !currentDock.pointer) return;
    const active = tabForDockKey(terminalTabs, currentDock.tabHash);
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

  // Vibe mode = the simplest creator skin. On the curated creator surfaces (chat,
  // live preview, code/diff, docs), Vibe strips the tab strip + navigator for a
  // Lovable-style chrome-less canvas. Every OTHER surface (assets, graph,
  // triggers, settings…) falls back to the normal Standard chrome so navigation
  // still works. Skin-layer rule: arrangement/visibility only — never data.
  // Chrome-less either because the host asked (embedded, e.g. the vibe display
  // pane) or a Vibe creator surface. No longer vibe-only — hence `suppressChrome`.
  const isVibe = useIsVibe();
  const suppressChrome = minimalChrome || (isVibe && VIBE_CREATOR_SURFACES.has(bodyViewType));

  // Chrome-less when the surface is full-bleed (Home — a welcome landing, not a
  // tabbed workspace), in the win/ focus layout, or a Vibe creator surface.
  // `chrome` (the registry "takeover" bit) is separate from
  // `DockPointer.tabHash` (chip-or-not).
  // The tab strip is persistent fixture chrome: it stays mounted on fullbleed
  // surfaces (Home) so open tabs never vanish; only win/ mode and Vibe creator
  // surfaces hide it. `hideChrome` (strip conditions + fullbleed) governs the
  // navigator/border framing — derived from `showTabStrip` so the shared
  // conditions exist exactly once.
  const showTabStrip = !windowMode && !suppressChrome;
  const hideChrome = !showTabStrip || VIEWER_REGISTRY[bodyViewType]?.chrome === 'fullbleed';

  // File manager filters
  const [enabledFilters, setEnabledFilters] = useState<FilterName[]>([FilterName.HIDDEN]);

  // The single body switch (one place, was duplicated between the overview slot
  // and a per-viewType TabsContent ladder). Renders the surface for `vt`; only
  // the active body is mounted (matches the old radix Tabs, which did not
  // forceMount). `null`/unknown → the Home landing.
  // Hub page (page=hub) renders its OWN small set of views, not the desk switch.
  // Kept as a separate dispatch (not extra cases in the desk switch) so the two
  // SPA-surfaces stay cleanly independent — see PAGES_DOCKPOINTER_SPEC.
  const renderHubBody = (vt: ViewType | null) => {
    switch (vt) {
      case ViewType.WORLDVIEW:
        return (
          <Suspense fallback={<PrimaryContentFallback />}>
            <WorldView />
          </Suspense>
        );
      case ViewType.ORGANIZATION:
        return <OrganizationPage />;
      case ViewType.HUB_RECORDS:
        return <HubRecordsView type={currentDock?.pointer} />;
      case ViewType.HUB_ENTITY:
        return <HubEntityView pointer={currentDock?.pointer} />;
      case ViewType.CONVERSATION:
        // Reuse the OSS conversation viewer (pure-graph, hub-safe) under page=hub.
        return <ConversationRoute />;
      case ViewType.ASSETS:
        return <HubAssetsPage />;
      case ViewType.PROJECT:
        return <HubProjectPage />;
      case ViewType.CREDENTIALS:
        return <CredentialsView />;
      case ViewType.LLM_ENDPOINTS:
        return (
          <Suspense fallback={<PrimaryContentFallback />}>
            <LlmEndpointsView pointer={currentDock?.pointer} />
          </Suspense>
        );
      case ViewType.TOKEN_PLAN:
        return (
          <Suspense fallback={<PrimaryContentFallback />}>
            <TokenPlanView pointer={currentDock?.pointer} />
          </Suspense>
        );
      case ViewType.HOME:
      default:
        return <HubHome />;
    }
  };

  const renderBody = (vt: ViewType | null) => {
    if (dockLoadError) {
      return <DockLoadErrorView error={dockLoadError} />;
    }

    // page=hub → the hub surface. Placed after the load-error guard (which is
    // page-agnostic) but before the desk tab/OpenFailed handling, which doesn't
    // apply to the hub (its views don't materialize `tab` entities).
    if (currentDock?.page === PageId.HUB) {
      return renderHubBody(vt);
    }

    if (activeOpenFailed) {
      return (
        <div
          className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground"
          data-testid="tab-open-failed-placeholder"
        >
          <AlertTriangle className="h-9 w-9 text-destructive" />
          <div>
            <h2 className="text-base font-semibold text-foreground">
              <Trans>Tab failed to open</Trans>
            </h2>
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
        return <WebappViewer />;
      case ViewType.APP: {
        // An artifact-addressed app. Distinct from WEB_APP (a bare port): the
        // artifact is stable identity and its runtime is derived, which is what
        // makes a shown app bookmarkable and restorable at all.
        const app = appDockAddress(currentDock);
        return app ? <AppDisplayViewer {...app} /> : null;
      }
      case ViewType.DIFF:
        if (currentDock?.pointer?.startsWith('asset-compare/')) {
          return <AssetCompareView pointer={currentDock.pointer} />;
        }
        return checkpointHash ? (
          <DiffViewer checkpoint_hash={checkpointHash} />
        ) : (
          <div className="p-4 text-gray-500">
            <Trans>No checkpoint selected</Trans>
          </div>
        );
      case ViewType.MARKDOWN:
        return <MarkdownViewer />;
      case ViewType.SURVEY:
        return activeSurveyData && onSurveyComplete ? (
          <Suspense fallback={<PrimaryContentFallback />}>
            <SurveyView surveyData={activeSurveyData} onComplete={onSurveyComplete} />
          </Suspense>
        ) : (
          <div className="p-6 text-muted-foreground">
            <Trans>No active survey</Trans>
          </div>
        );
      case ViewType.SYSTEM_PROFILE:
        return <LiveStatus />;
      case ViewType.CREDENTIALS:
        return <CredentialsView />;
      // DESK only: every fact it renders is a box fact, and its box action 404s on the hub.
      case ViewType.LLM_SOURCES:
        return (
          <Suspense fallback={<PrimaryContentFallback />}>
            <LlmSourcesView pointer={currentDock?.pointer} />
          </Suspense>
        );
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
      // The merged Events screen. TRIGGERS / SIGNALS / CRON are aliases, not
      // redirects — every bookmarked URL keeps resolving to the same screen.
      case ViewType.EVENTS:
      case ViewType.TRIGGERS:
      case ViewType.SIGNALS:
      case ViewType.CRON:
        return (
          <Suspense fallback={<PrimaryContentFallback />}>
            <EventsView />
          </Suspense>
        );
      case ViewType.CAPABILITIES:
        return <CapabilitiesView />;
      case ViewType.SHOW:
        return (
          <Suspense fallback={<PrimaryContentFallback />}>
            <ShowView />
          </Suspense>
        );
      case ViewType.APPS:
        return (
          <Suspense fallback={<PrimaryContentFallback />}>
            <AppHost />
          </Suspense>
        );
      case ViewType.GRAPH:
        return (
          <Suspense fallback={<PrimaryContentFallback />}>
            <GraphView />
          </Suspense>
        );
      case ViewType.WORLDVIEW:
        return (
          <Suspense fallback={<PrimaryContentFallback />}>
            <WorldView />
          </Suspense>
        );
      case ViewType.TAG:
        return (
          <Suspense fallback={<PrimaryContentFallback />}>
            <TagGraphView />
          </Suspense>
        );
      case ViewType.SUBGRAPH:
        return (
          <Suspense fallback={<PrimaryContentFallback />}>
            <GenericSubgraphView />
          </Suspense>
        );
      case ViewType.GRAPH_WORKFLOWS:
        return (
          <Suspense fallback={<PrimaryContentFallback />}>
            <GraphWorkflowsView />
          </Suspense>
        );
      case ViewType.DATA_SOURCES:
        return (
          <Suspense fallback={<PrimaryContentFallback />}>
            <DataSourcesView />
          </Suspense>
        );
      case ViewType.RAG:
        return (
          <Suspense fallback={<PrimaryContentFallback />}>
            <RagView />
          </Suspense>
        );
      case ViewType.PROCESS_RUNS:
        return (
          <Suspense fallback={<PrimaryContentFallback />}>
            <RunsView />
          </Suspense>
        );
      case ViewType.K_BROWSER:
        return (
          <Suspense fallback={<PrimaryContentFallback />}>
            <DocsGraphView />
          </Suspense>
        );
      case ViewType.LENS:
        return <LensViewer />;
      case ViewType.TASKS:
        // Retired: task opens through the generic asset editor. Redirect any
        // lingering /dock/tasks/<id> deep link to editor/task/typeid/…
        return <TasksRedirect />;
      case ViewType.SETTINGS:
        return <SettingsView />;
      case ViewType.PREFERENCES:
        return <PreferencesView />;
      case ViewType.DESKTOP:
        return <DesktopPage />;
      case ViewType.SEARCH:
        return <SearchView />;
      case ViewType.AGENTIC_PROCESS:
        return currentDock?.pointer ? (
          <TabbedTerminal className="h-full" key={currentDock.pointer} processId={currentDock.pointer} />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Trans>No process ID specified</Trans>
          </div>
        );
      case ViewType.LIVE_SESSION:
        return currentDock?.pointer ? (
          <LiveSessionView key={currentDock.pointer} sessionId={currentDock.pointer} />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Trans>No live session specified</Trans>
          </div>
        );
      case ViewType.ASSETS:
        return <AssetsPage />;
      case ViewType.HELPDESK:
        return <HelpdeskPortalPage />;
      case ViewType.PROJECT: {
        // A project dock scoped to a collaboration_room (…/collaboration_room/<id>)
        // renders the collaboration room; a bare project dock is the assets
        // workspace. roomId comes from the URL, so the room view is URL-first.
        const { roomId } = DockPointer.parseProjectPointer(currentDock?.pointer);
        return roomId ? <CollaborationPage /> : <AssetsPage />;
      }
      case ViewType.INBOX:
        return <InboxView />;
      case ViewType.AGENT:
        return <AgentInboxView />;
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

      {/* Unified tab strip — persistent fixture chrome: visible on every
          surface (including Home/fullbleed, where no chip is active but the
          open tabs + openers stay reachable). Only the win/ focus layout and
          Vibe creator surfaces are deliberately chrome-less. */}
      {showTabStrip && <UnifiedTabStrip />}

      {/* Zone B — shared left-menu slot, now nested UNDER the tab strip so the
          active view's navigator (assets tree / workflows / docs / triggers /
          chats) is scoped to the current tab's content row rather than spanning
          the full app height beside the tabs. The `border-t` draws the tab
          body's top edge; the active chip's `-mb-px border-b-transparent`
          opens its bottom over this line, so the menu + body read as one panel
          hanging from the current tab (the folder-tab continuum). */}
      <div className={`flex min-h-0 flex-1 overflow-hidden ${showTabStrip ? 'border-t border-border' : ''}`}>
        {!suppressChrome && <NavigatorSlot />}

        <div className="relative min-h-0 flex-1 overflow-hidden">
          {/* Matches the proven per-viewType slot layout (plain h-full, no flex-col)
              so xterm fits on first paint — a flex-col parent broke its initial sizing.
              No entrance animation: a tab switch must be visually instant (a fade
              reads as page navigation, not a tab switch). */}
          {/* `contentEpoch` re-keys the body to force a remount. It exists because
              the vibe display is now an ADDRESS, and two of its refresh signals are
              not addresses: a re-`flow show` of the same target (same URL — a no-op
              navigation, yet the file behind it may have been rebuilt) and the
              agent's turn-end (the CLI stream carries no per-file write items, so
              the turn edge is the only "something changed" signal there is).
              Undefined for every other host, which keeps the default a plain
              uncontrolled body. */}
          <div key={contentEpoch} className="absolute inset-0 mt-0 h-full flex-1 overflow-auto">
            {renderBody(bodyViewType)}
          </div>
        </div>
      </div>
    </div>
  );
}
