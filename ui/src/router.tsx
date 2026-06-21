import AgentLayout from '@src/components/agent-layout/agent-layout';
import ErrorScreen from '@src/components/agent-layout/error-screen/error-screen';
import { ApiKeysView } from '@src/components/api-keys-view/api-keys-view';
import DeveloperLayout from '@src/components/developer-layout/developer-layout';
import { FloatingChatWindow } from '@src/components/floating-chat';
import { HooksView } from '@src/components/hooks-view/hooks-view';
import { SessionsView } from '@src/components/sessions-view/sessions-view';
// `WorkflowTracePreviewPage` was a dev-only standalone preview that bypassed
// the entity layer. The workflow-runner refactor (May 2026) routes everything
// through the main /dock/assets/editor/workflow URL. Removed.
import { BASE_PATH } from '@src/constants/basePath';
import AgentRedirect from '@src/pages/agent-redirect';
import DiscoverPage from '@src/pages/discover-page/discover-page';
import FlowPage from '@src/pages/flow-page/flow-page';
import FocusLayout from '@src/pages/flow-page/FocusLayout';
import KeychainApproval from '@src/pages/keychain-approval';
import LandingPage from '@src/pages/landing-page/landing-page';
import NotFound from '@src/pages/NotFound';
import App from '@src/App';
import { createBrowserRouter, createRoutesFromElements, Navigate, Outlet, Route, useLocation, type ShouldRevalidateFunctionArgs } from 'react-router';

/**
 * Root-level `/dev/<anything-not-main-or-hooks>` URLs forward to `/dock/<same>`.
 *
 * Why: url-builder.ts and DockPointer treat `dock` and `dev` as interchangeable
 * layout keywords (see parseDockUrl), so users land here from copy/paste,
 * stale links, or hand-typed URLs. Without this redirect, the root catch-all
 * NotFound swallows them — surprising and unhelpful.
 */
function DevToDockRedirect() {
  const location = useLocation();
  const rest = location.pathname.replace(/^\/dev\/?/, '');
  const target = `/dock/${rest}${location.search}${location.hash}`;
  return <Navigate to={target} replace />;
}

/**
 * Root layout — sits inside the loader-gated subtree so `<App>` and every
 * entity-touching hook it contains (useAuth, useGlobalEvents, …) only mount
 * after `loadRoot` has resolved (i.e. SDK schemas + bootstrap are ready).
 *
 * `<FloatingChatWindow>` lives here because its descendants call
 * react-router hooks (`useNavigate()`); placing it inside `<App>` keeps it
 * below `<RouterProvider>` while still letting `FloatingChatProvider` (in
 * `<App>`) own the open/close state across route changes.
 */
function RootLayout() {
  return (
    <App>
      <Outlet />
      <FloatingChatWindow />
    </App>
  );
}

// Import loaders
import { loadHomePage } from './routes/loaders/home-loader';
import { loadAgentApp } from './routes/loaders/main-loader';
import { loadRoot } from './routes/loaders/root-loader';

function shouldRevalidateDock({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs): boolean {
  if (
    // The dock loader (`loadAgentApp` → `loadDockPointer`) is the single writer
    // of URL-derived context — project, process, conversation, asset, … — and
    // it lives on the PARENT `dock` route, which React-Router won't revalidate
    // when only the child splat changes. So any change to the dock/win URL must
    // force it to re-run, for EVERY view type (not just `shell`): otherwise a
    // client-side switch (e.g. project→project via the chip) moves the URL but
    // leaves `dataContext` pointing at the previously-loaded entity.
    // win/ mirrors dock/ (tab-management.md Part 3 §7): same loaders.
    /\/(?:dock|win)(?:\/|$)/.test(nextUrl.pathname) &&
    (currentUrl.pathname !== nextUrl.pathname || currentUrl.search !== nextUrl.search)
  ) {
    return true;
  }

  return defaultShouldRevalidate;
}

export const router = createBrowserRouter(
  createRoutesFromElements(
    <Route
      path="/"
      element={<RootLayout />}
      loader={loadRoot}
      errorElement={<ErrorScreen />}
      HydrateFallback={() => (
        <div className="flex min-h-screen items-center justify-center">
          <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-ring"></div>
        </div>
      )}
    >
      {/* Root and /main routes use DeveloperLayout */}

      <Route index element={<FlowPage />} loader={loadHomePage} />
      {/* Discover — full-page asset marketplace. Sits inside RootLayout (so
          loadRoot/auth/theme gate it) but OUTSIDE AgentLayout/FlowPage, so it
          renders full-screen with its own chrome (no sidebar/tab strip). */}
      <Route path="discover" element={<DiscoverPage />} />
      <Route path="agent" element={<AgentRedirect />} loader={loadAgentApp} />
      {/* Root dock routes - use default agent from bootstrap */}
      <Route path="dock" element={<AgentLayout />} loader={loadAgentApp} shouldRevalidate={shouldRevalidateDock} errorElement={<ErrorScreen />}>
        <Route index element={<Navigate to="/" replace />} />
        <Route path=":viewType" element={<FlowPage />} />
        <Route path=":viewType/*" element={<FlowPage />} />
      </Route>
      {/* win/ focus-window routes (tab-management.md Part 3 §7): mirror the
          dock routes — same loaders — but render the chrome-less FocusLayout
          so the routed view content is the entire window. */}
      <Route path="win" element={<AgentLayout />} loader={loadAgentApp} shouldRevalidate={shouldRevalidateDock}>
        <Route index element={<Navigate to="/" replace />} />
        <Route path=":viewType" element={<FocusLayout />} />
        <Route path=":viewType/*" element={<FocusLayout />} />
      </Route>
      <Route
        path="agent/:agentId"
        element={<AgentLayout />}
        loader={loadAgentApp}
        shouldRevalidate={shouldRevalidateDock}
      >
        {/* /agent/:agentId */}
        <Route index element={<LandingPage />} />
        {/* Dock routes WITHOUT processId - for agent-level views (skills, settings, etc.) */}
        <Route path="dock/:viewType" element={<FlowPage />} />
        <Route path="dock/:viewType/*" element={<FlowPage />} />
        {/* win/ focus-window mirrors (Part 3 §7) — same loaders, chrome-less host */}
        <Route path="win/:viewType" element={<FocusLayout />} />
        <Route path="win/:viewType/*" element={<FocusLayout />} />
        {/* ✅ Validate ONLY the /dock/:viewType route */}
        <Route path="flow/:processId/dock/:viewType" element={<FlowPage />} />
        {/* Leave pointer route untouched (no validation) - use wildcard for multi-segment paths */}
        <Route path="flow/:processId/dock/:viewType/*" element={<FlowPage />} />
        {/* Dev layout routes (parallel to dock routes) */}
        <Route path="flow/:processId/dev/:viewType" element={<FlowPage />} />
        <Route path="flow/:processId/dev/:viewType/*" element={<FlowPage />} />
        {/* win/ focus-window mirrors for the combined namespace (Part 3 §7) */}
        <Route path="flow/:processId/win/:viewType" element={<FocusLayout />} />
        <Route path="flow/:processId/win/:viewType/*" element={<FocusLayout />} />
        {/* Keep the general flow route as-is */}
        <Route path="flow/:processId" element={<FlowPage />} loader={loadAgentApp} />
      </Route>
      <Route path="dev" element={<DeveloperLayout />} loader={loadAgentApp}>
        <Route index element={<SessionsView />} />
        <Route path="main" element={<SessionsView />} />
        <Route path="main/api-keys" element={<ApiKeysView />} />
        {/* Connections route hidden until OAuth flow is fully implemented */}
        <Route path="hooks" element={<HooksView />} />
        {/* /dev/trace/:runId removed by the workflow-runner refactor.
            Use /dock/assets/editor/workflow/<asset_ref> instead. */}
        <Route path="*" element={<DevToDockRedirect />} />
      </Route>

      {/* Deep-link bridge: silently provisions keychain access (via
          secretApprovalGate.request) when the /auth/login_callback handler
          detects it isn't set up, then re-invokes the callback. */}
      <Route path="electron/keychain-approval" element={<KeychainApproval />} />

      {/* Global catch-all */}
      <Route path="*" element={<NotFound />} />
    </Route>,
  ),
  {
    basename: BASE_PATH,
  },
);
