import AgentLayout from '@src/components/agent-layout/agent-layout';
import ErrorScreen from '@src/components/agent-layout/error-screen/error-screen';
import { ApiKeysView } from '@src/components/api-keys-view/api-keys-view';
import DeveloperLayout from '@src/components/developer-layout/developer-layout';
import { FloatingChatWindow } from '@src/components/floating-chat';
import { WizardHost } from '@src/components/wizard/WizardHost';
import { HooksView } from '@src/components/hooks-view/hooks-view';
import { SessionsView } from '@src/components/sessions-view/sessions-view';
// `WorkflowTracePreviewPage` was a dev-only standalone preview that bypassed
// the entity layer. Removed.
import { BASE_PATH } from '@src/constants/basePath';
import DiscoverPage from '@src/pages/discover-page/discover-page';
import FlowPage from '@src/pages/flow-page/flow-page';
import FocusLayout from '@src/pages/flow-page/FocusLayout';
import KeychainApproval from '@src/pages/keychain-approval';
import InvitePage from '@src/pages/entry/InvitePage';
import WrongAccountPage from '@src/pages/entry/WrongAccountPage';
import MessageLanding from '@src/pages/entry/MessageLanding';
import NotFound from '@src/pages/NotFound';
import App from '@src/App';
import {
  createBrowserRouter,
  createRoutesFromElements,
  Navigate,
  Outlet,
  Route,
  useLocation,
  type ShouldRevalidateFunctionArgs,
} from 'react-router';

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
      <WizardHost />
      <FloatingChatWindow />
    </App>
  );
}

// Import loaders
import { loadHomePage } from './routes/loaders/home-loader';
import { loadAgentApp } from './routes/loaders/main-loader';
import { loadRoot } from './routes/loaders/root-loader';

function shouldRevalidateDock({ currentUrl, nextUrl, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs): boolean {
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
      {/* Legacy hub-console deep links → the hub page's dock URLs, so old
          bookmarks/links keep working after the console is retired. (On a
          desk-only server these targets get bounced back to /dock/home by the
          main-loader supported_pages guard, so they're harmless there.) */}
      <Route path="organization" element={<Navigate to="/dock/hub/worldview/organization" replace />} />
      <Route path="org-graph" element={<Navigate to="/dock/hub/worldview/world" replace />} />
      {/* Discover — full-page asset marketplace. Sits inside RootLayout (so
          loadRoot/auth/theme gate it) but OUTSIDE AgentLayout/FlowPage, so it
          renders full-screen with its own chrome (no sidebar/tab strip). */}
      <Route path="discover" element={<DiscoverPage />} />
      {/* Entry journeys — full-screen pages the hub BACKEND sends users to
          (invite emails, accept-flow redirects, post-accept landings). Inside
          RootLayout so initSdk/bootstrap has run, outside the dock subtrees so
          loadAgentApp's supported_pages redirect never touches them. */}
      <Route path="invite/:token" element={<InvitePage />} />
      <Route path="wrong_account" element={<WrongAccountPage />} />
      <Route path="flow_message/:messageId" element={<MessageLanding />} />
      {/* Root dock routes - use default agent from bootstrap */}
      <Route
        path="dock"
        element={<AgentLayout />}
        loader={loadAgentApp}
        shouldRevalidate={shouldRevalidateDock}
        errorElement={<ErrorScreen />}
      >
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
      <Route path="dev" element={<DeveloperLayout />} loader={loadAgentApp}>
        <Route index element={<SessionsView />} />
        <Route path="main" element={<SessionsView />} />
        <Route path="main/api-keys" element={<ApiKeysView />} />
        {/* Connections route hidden until OAuth flow is fully implemented */}
        <Route path="hooks" element={<HooksView />} />
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
