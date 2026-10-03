import { isHubOnly, Layout, tabManager } from '@sdk';
import { replace } from 'react-router';

import { getViewMode, rememberedDockViewMode } from '@src/contexts/view-mode-context';
import { DockPointer } from '@src/navigation/DockPointer';
import { registerLoadRedirect } from '@src/routes/loaders/load-redirects';

/**
 * Restore the last view on launch, the way an IDE reopens where you left off.
 *
 * The app launches at a BARE `/` — Electron loads the backend root, a browser
 * opens the address — while every in-app navigation to Home states its mode
 * (`?viewMode=…`). So a bare `/` on the first home load of this document is a
 * launch, and only a launch restores; a reload stays where it is, and Home
 * stays Home.
 *
 * What is restored is the last PLACE, not the newest `last_active_at`: landing
 * on a tab remembers it, landing on Home forgets it. A user who left a tab for
 * Home comes back to Home, not to the tab they had already left. A remembered
 * tab that has since been closed restores nothing.
 *
 * Per instance by construction: each instance serves its UI from its own port,
 * so `localStorage` is a separate origin for each.
 */
const STORAGE_KEY = 'flowpad.lastTab';

/** Whether this document's first home load was a launch. Decided once; consumed by the redirect. */
let launch: 'undecided' | 'pending' | 'done' = 'undecided';

/** Record the home loader's URL. Only the first call of a document decides whether it was a launch. */
export function noteHomeLoad(url: URL): void {
  if (launch !== 'undecided') return;
  launch = url.pathname === '/' && url.search === '' ? 'pending' : 'done';
}

/** The launch's one resolver pass is over, whichever redirect (if any) took it. */
export function endLaunch(): void {
  launch = 'done';
}

/** The main window landed on `tabId`. Pop-out windows (`/win`) never speak for the main window. */
export function rememberLastTab(dock: DockPointer, tabId: string): void {
  if (dock.layout !== Layout.DOCK) return;
  try {
    localStorage.setItem(STORAGE_KEY, tabId);
  } catch {
    // Storage unavailable: the next launch opens Home, as it did before.
  }
}

/** The main window landed on Home — the view with no tab. */
export function forgetLastTab(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing remembered to clear.
  }
}

function rememberedTabId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * On a launch, the remembered tab's dock — in the mode it was last shown in —
 * or null to stay on Home. `replace`: the bare launch URL must not stay behind
 * the tab as a Back step that bounces forward again.
 */
export async function lastTabRestoreRedirect(): Promise<Response | null> {
  if (launch !== 'pending') return null;
  launch = 'done';
  if (isHubOnly()) return null;
  const tabId = rememberedTabId();
  if (!tabId) return null;

  const tab = (await tabManager.snapshotOrRefresh()).find((t) => t.id === tabId);
  const stored = tab && !tab.is_disabled ? tab.dockPointer : null;
  if (!stored) return null;
  const dock = new DockPointer(stored);
  const mode = dock.viewMode ?? rememberedDockViewMode(dock) ?? getViewMode();
  return replace(dock.withViewMode(mode).toUrl());
}

export function resetLastTabRestoreForTests(): void {
  launch = 'undecided';
}

// Registered after every other load redirect (journeys, agent auto-launch, the
// project home page): first redirect wins, and each of those is a destination
// the user or the app asked for on this load.
registerLoadRedirect(lastTabRestoreRedirect);
