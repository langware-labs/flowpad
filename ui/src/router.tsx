import AgentLayout from '@src/components/agent-layout/agent-layout';
import ErrorScreen from '@src/components/agent-layout/error-screen/error-screen';
import { ApiKeysView } from '@src/components/api-keys-view/api-keys-view';
import DeveloperLayout from '@src/components/developer-layout/developer-layout';
import { HooksView } from '@src/components/hooks-view/hooks-view';
import { SessionsView } from '@src/components/sessions-view/sessions-view';
import { BASE_PATH } from '@src/constants/basePath';
import AgentRedirect from '@src/pages/agent-redirect';
import FlowPage from '@src/pages/flow-page/flow-page';
import LandingPage from '@src/pages/landing-page/landing-page';
import NotFound from '@src/pages/NotFound';
import { createBrowserRouter, createRoutesFromElements, Route, type ShouldRevalidateFunctionArgs } from 'react-router';

// Import loaders
import { loadHomePage } from './routes/loaders/home-loader';
import { loadAgentApp } from './routes/loaders/main-loader';

function shouldRevalidateDockShell({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs): boolean {
  if (
    /\/dock\/shell(?:\/|$)/.test(nextUrl.pathname) &&
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
      errorElement={<ErrorScreen />}
      HydrateFallback={() => (
        <div className="flex min-h-screen items-center justify-center">
          <div className="h-12 w-12 animate-spin rounded-full border-b-2 border-ring"></div>
        </div>
      )}
    >
      {/* Root and /main routes use DeveloperLayout */}

      <Route index element={<FlowPage />} loader={loadHomePage} />
      <Route path="agent" element={<AgentRedirect />} loader={loadAgentApp} />
      {/* Root dock routes - use default agent from bootstrap */}
      <Route path="dock" element={<AgentLayout />} loader={loadAgentApp} shouldRevalidate={shouldRevalidateDockShell}>
        <Route path=":viewType" element={<FlowPage />} />
        <Route path=":viewType/*" element={<FlowPage />} />
      </Route>
      <Route
        path="agent/:agentId"
        element={<AgentLayout />}
        loader={loadAgentApp}
        shouldRevalidate={shouldRevalidateDockShell}
      >
        {/* /agent/:agentId */}
        <Route index element={<LandingPage />} />
        {/* Dock routes WITHOUT processId - for agent-level views (skills, settings, etc.) */}
        <Route path="dock/:viewType" element={<FlowPage />} />
        <Route path="dock/:viewType/*" element={<FlowPage />} />
        {/* ✅ Validate ONLY the /dock/:viewType route */}
        <Route path="flow/:processId/dock/:viewType" element={<FlowPage />} />
        {/* Leave pointer route untouched (no validation) - use wildcard for multi-segment paths */}
        <Route path="flow/:processId/dock/:viewType/*" element={<FlowPage />} />
        {/* Dev layout routes (parallel to dock routes) */}
        <Route path="flow/:processId/dev/:viewType" element={<FlowPage />} />
        <Route path="flow/:processId/dev/:viewType/*" element={<FlowPage />} />
        {/* Keep the general flow route as-is */}
        <Route path="flow/:processId" element={<FlowPage />} loader={loadAgentApp} />
      </Route>
      <Route path="dev" element={<DeveloperLayout />} loader={loadAgentApp}>
        <Route index element={<SessionsView />} />
        <Route path="main" element={<SessionsView />} />
        <Route path="main/api-keys" element={<ApiKeysView />} />
        {/* Connections route hidden until OAuth flow is fully implemented */}
        <Route path="hooks" element={<HooksView />} />
      </Route>

      {/* Global catch-all */}
      <Route path="*" element={<NotFound />} />
    </Route>,
  ),
  {
    basename: BASE_PATH,
  },
);
