/**
 * The OS window title, mirroring the address bar: `Flowpad: <project> / <asset>`.
 *
 * Electron mirrors `document.title` into the BrowserWindow title, so setting it
 * in the renderer covers the desktop app, the web, and popped-out `win/`
 * windows alike. Ancestors are dropped to keep it short enough for a taskbar
 * tile.
 */
import { useEffect } from 'react';
import type { Crumb } from '@src/components/top-nav-bar/use-entity-breadcrumbs';
import { useEntityBreadcrumbs } from '@src/components/top-nav-bar/use-entity-breadcrumbs';
import { APP_NAME } from '@src/constants/app';
import type { DockPointer } from './DockPointer';

export function windowTitleFor(crumbs: Pick<Crumb, 'kind' | 'label'>[]): string {
  const project = crumbs.find((c) => c.kind === 'project')?.label.trim();
  const leaf = crumbs.find((c) => c.kind === 'current')?.label.trim();
  const parts = [project, leaf].filter(Boolean);
  return parts.length ? `${APP_NAME}: ${parts.join(' / ')}` : APP_NAME;
}

/** Own `document.title` while mounted; hand it back to the bare app name after. */
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
    return () => {
      document.title = APP_NAME;
    };
  }, [title]);
}

/**
 * Leaf that resolves a dock's address and sets the window title from it, for
 * hosts with no nav bar (the `win/` layout). Renders nothing, so the resolve's
 * state churn re-renders only this leaf, not the host's content tree.
 */
export function WindowTitle({ dock }: { dock: DockPointer | null }) {
  const { crumbs } = useEntityBreadcrumbs(dock);
  useDocumentTitle(windowTitleFor(crumbs));
  return null;
}
