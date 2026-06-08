import { initSentry } from '@sdk';
import { sdkConfig } from '@sdk/config/index';
import { initDesktopBackend } from '@sdk/config/desktop';
import '@src/styles/index.css';
import { ThemeProvider } from 'next-themes';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router';
import '@src/contexts/dev-mode-context';
import { router } from './router';
import './styles/highlightjs.css';

initSentry();

function defineGlobals() {
  import('@sdk').then(sdk => {
    (window as any).AgenticProcess = sdk.AgenticProcess;
    (window as any).Shell = sdk.Shell;
  });
}

// Mouse back/forward buttons (X1/X2) → history navigation. Real browsers map
// these natively in their own UI layer (not the web platform), so Electron
// windows never get it — wire it up ourselves, Electron only, to avoid
// double-navigation in the browser.
function bindMouseNavButtons() {
  if (!(window as any).electronAPI) return;
  window.addEventListener('mouseup', e => {
    if (e.button === 3) {
      e.preventDefault();
      window.history.back();
    } else if (e.button === 4) {
      e.preventDefault();
      window.history.forward();
    }
  });
}

// Resolve backend URL from Electron IPC before rendering (no-op in browser).
// `<App>` is intentionally NOT wrapped here — it lives inside the router's
// loader-gated subtree (see `RootLayout` in `router.tsx`) so its hooks only
// mount after `loadRoot` has finished `initSdk()`.
async function init() {
  defineGlobals();
  bindMouseNavButtons();
  await initDesktopBackend(sdkConfig);

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ThemeProvider attribute="class" defaultTheme="dark" enableSystem disableTransitionOnChange>
        <RouterProvider
          router={router}
          unstable_onError={(error) => {
            console.error('Error loading session:', error);
          }}
        />
      </ThemeProvider>
    </React.StrictMode>,
  );
}

init();
