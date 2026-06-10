import { initSentry } from '@sdk';
import { sdkConfig } from '@sdk/config/index';
import { initDesktopBackend } from '@sdk/config/desktop';
import '@src/styles/index.css';
import { ThemeProvider } from 'next-themes';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { RouterProvider } from 'react-router';
import '@src/contexts/dev-mode-context';
import '@src/contexts/view-mode-context';
import { router } from './router';
import './styles/highlightjs.css';

initSentry();

function defineGlobals() {
  import('@sdk').then(sdk => {
    (window as any).AgenticProcess = sdk.AgenticProcess;
    (window as any).Shell = sdk.Shell;
  });
}

// Mouse back/forward buttons (X1/X2). The actual history navigation is done by
// the Electron MAIN process (electron/main.js → input-event on macOS /
// app-command on Windows/Linux), because Chromium does NOT reliably deliver
// these buttons to the renderer as a DOM `mouseup` on macOS hardware. Here we
// ONLY `preventDefault()` so Chromium's own native back/forward doesn't ALSO
// fire — we must NOT call window.history.back/forward() here, or the press
// navigates twice (the "sometimes double back" bug). One owner: the main process.
function bindMouseNavButtons() {
  const isElectron = !!(window as any).electronAPI;
  // Catch-all: every back/forward — no matter the source (Electron main
  // webContents.goBack, react-router navigate(-1), keyboard) — surfaces here as a
  // popstate. Logged with [nav-debug] so the Electron main process forwards it
  // into the desktop log file.
  window.addEventListener('popstate', e => {
    console.log(
      `[nav-debug] renderer.popstate href=${window.location.href} state=${JSON.stringify(e.state)} electron=${isElectron}`,
    );
  });
  if (!isElectron) return;
  window.addEventListener('mouseup', e => {
    // preventDefault ONLY (suppress Chromium's native nav). Main process navigates.
    if (e.button === 3 || e.button === 4) {
      console.log(`[nav-debug] renderer.mouseup button=${e.button} (preventDefault only; main owns nav)`);
      e.preventDefault();
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
