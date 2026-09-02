import '@src/i18n-init';
import { toplog } from '@sdk';
import { sdkConfig } from '@sdk/config/index';
import { initDesktopBackend } from '@sdk/config/desktop';
import '@src/styles/index.css';
import { ThemeProvider } from 'next-themes';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router';
import '@src/contexts/view-mode-context';
import { initLocale } from '@src/contexts/locale-context';
import { LocaleProviders } from '@src/contexts/LocaleProviders';
import { DiagnoseErrorModal } from '@src/notifications';
import '@src/tabs/agentic-process-tab-adapter';
import { router } from './router';
import './styles/highlightjs.css';

function defineGlobals() {
  void import('@sdk').then((sdk) => {
    (window as any).AgenticProcess = sdk.AgenticProcess;
    (window as any).Shell = sdk.Shell;
  });
}

// NOTE: the renderer deliberately does NOT bind the X1/X2 mouse buttons.
// The Electron main process is the single navigator for them
// (`electron/main.js`: macOS `input-event` + `swipe`, Windows/Linux
// `app-command`). A renderer-side `mouseup` button 3/4 handler used to exist
// here on the assumption that macOS never delivers the raw button to the web
// layer — false on hardware that sends a real X1: BOTH fired and one press
// stepped history twice. One gesture, one navigator.

// Ground-truth trace of every history transition the renderer sees — fires for
// real back/forward (browser, Electron gesture, mouse buttons) AND for the
// synthetic popstate that NavigationActions.commitBrowserNavigation dispatches
// after a pushState. A single "back" gesture that produces two of these (or a
// did-navigate pair in the Electron `[nav]` log) is the double-navigation bug.
function bindNavigationTrace() {
  window.addEventListener('popstate', (e) => {
    toplog.log('navigation', 'popstate', {
      url: location.pathname + location.search,
      state: e.state,
      historyLen: window.history.length,
    });
  });
}

// Resolve backend URL from Electron IPC before rendering (no-op in browser).
// `<App>` is intentionally NOT wrapped here — it lives inside the router's
// loader-gated subtree (see `RootLayout` in `router.tsx`) so its hooks only
// mount after `loadRoot` has finished `initSdk()`.
async function init() {
  defineGlobals();
  bindNavigationTrace();
  await initDesktopBackend(sdkConfig);
  // Seed toplog state + subscribe to live tag toggles. Without this the
  // frontend `toplog.log(...)` calls (incl. the `navigation` tag) are no-ops
  // because the in-memory state never mirrors the backend. Idempotent; the GET
  // runs after the backend URL is resolved by initDesktopBackend above.
  void toplog.bootstrap();
  // Resolve + activate the locale and set `<html lang/dir>` BEFORE first paint
  // so there's no flash of wrong-language / wrong-direction content.
  await initLocale();

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
        <LocaleProviders>
          <RouterProvider
            router={router}
            onError={(error) => {
              console.error('Error loading session:', error);
            }}
          />
          {/* Outside the router on purpose: the root `errorElement`
              (`<ErrorScreen/>`) REPLACES `<RootLayout>`, so anything mounted
              inside `<App>` is gone exactly when a route blows up — which is
              when the error screen's stethoscope needs this host. One instance
              here serves both the app and every error boundary. */}
          <DiagnoseErrorModal />
        </LocaleProviders>
      </ThemeProvider>
    </React.StrictMode>,
  );
}

void init();
