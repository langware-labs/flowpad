import '@src/i18n-init';
import { isElectronShell, toplog } from '@sdk';
import { sdkConfig } from '@sdk/config/index';
import { initDesktopBackend } from '@sdk/config/desktop';
import '@src/styles/index.css';
import { ThemeProvider } from 'next-themes';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router';
import '@src/contexts/view-mode-context';
import { initLocale } from '@src/contexts/locale-context';
import { getHistoryPosition } from '@src/navigation/history-position-store';
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

// Mouse back/forward buttons (X1/X2) → history navigation. Real browsers map
// these natively in their own UI layer (not the web platform), so Electron
// windows never get it — wire it up ourselves, Electron only, to avoid
// double-navigation in the browser.
function bindMouseNavButtons() {
  // Runs before bootstrap, so it asks the shell directly rather than reading
  // `runtimeKind` — this is the same probe the SDK sends to the server.
  if (!isElectronShell()) return;
  // These stay on `window.history` rather than routing through
  // NavigationActions: this binds before React mounts, and the browser's own
  // popstate already reaches react-router — which is what keeps the nav bar's
  // buttons in sync with a mouse click. The position store is consulted only to
  // guard the edges and to say WHY nothing happened in the trace.
  window.addEventListener('mouseup', (e) => {
    if (e.button === 3) {
      e.preventDefault();
      const { canGoBack, idx } = getHistoryPosition();
      toplog.log('navigation', 'mouse X1 (back)', {
        canGoBack,
        idx,
        url: location.pathname + location.search,
      });
      if (canGoBack) window.history.back();
    } else if (e.button === 4) {
      e.preventDefault();
      const { canGoForward, idx } = getHistoryPosition();
      toplog.log('navigation', 'mouse X2 (forward)', {
        canGoForward,
        idx,
        url: location.pathname + location.search,
      });
      if (canGoForward) window.history.forward();
    }
  });
}

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
  bindMouseNavButtons();
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
