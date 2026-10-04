import { Layout } from '@sdk';
import { replace } from 'react-router';

import type { DockPointer } from '@src/navigation/DockPointer';

/**
 * Restore the last view on launch, the way an IDE reopens where you left off.
 *
 * The app launches at a BARE `/` — Electron loads the backend root, a browser
 * opens the address — while every in-app navigation to Home states its mode
 * (`?viewMode=…`). So a document that opened at a bare `/` was launched, and
 * only its first home load restores; a reload stays where it is, and Home
 * stays Home.
 *
 * What is restored is the last PLACE: every dock load in the main window
 * records its URL (canonical — scope and view mode included, so the restore
 * lands in one hop), and Home, the view with no tab, forgets it. A user who left
 * a tab for Home comes back to Home. Closing the shown tab moves the window
 * elsewhere, which records that place instead.
 *
 * Per instance by construction: each instance serves its UI from its own port,
 * so `localStorage` is a separate origin for each.
 */
const STORAGE_KEY = 'flowpad.lastDockUrl';

/** Decided once, from the document's own URL; ended after the launch's one resolver pass. */
let launchPending = isBareRoot(window.location);

function isBareRoot(url: Pick<URL, 'pathname' | 'search'>): boolean {
  return url.pathname === '/' && url.search === '';
}

/** Storage can be unavailable (private mode, blocked site data): the launch then opens Home, as before. */
function storage<T>(fn: (s: Storage) => T): T | null {
  try {
    return fn(localStorage);
  } catch {
    return null;
  }
}

/** The main window finished loading `dock` at `url`. Pop-out windows (`/win`) never speak for it. */
export function rememberLastPlace(dock: DockPointer, url: string): void {
  if (dock.layout === Layout.DOCK) storage((s) => s.setItem(STORAGE_KEY, url));
}

/** The main window landed on Home — the view with no tab. */
export function forgetLastPlace(): void {
  storage((s) => s.removeItem(STORAGE_KEY));
}

/** The launch's one resolver pass is over, whichever redirect (if any) took it. */
export function endLaunch(): void {
  launchPending = false;
}

/**
 * On a launch, the last place, or null to stay on Home. `replace`: the bare
 * launch URL must not stay behind the tab as a Back step that bounces forward.
 */
export function lastPlaceRestoreRedirect(request: Request): Promise<Response | null> {
  if (!launchPending || new URL(request.url).pathname !== '/') return Promise.resolve(null);
  const url = storage((s) => s.getItem(STORAGE_KEY));
  return Promise.resolve(url ? replace(url) : null);
}

export function resetLastPlaceRestoreForTests(documentUrl: string): void {
  launchPending = isBareRoot(new URL(documentUrl));
}
