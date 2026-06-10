import type { ReactNode } from 'react';

/**
 * Two presentational layouts for the interactive tab header (the ProcessToolbar
 * row above the Claude pane). Both consume the SAME slot nodes — the stateful
 * ProcessToolbar builds each button once and hands them here. A view mode only
 * selects the arrangement; it never changes data, hooks, or behavior. See
 * docs/viewmodes.md (skin-layer rule + slot pattern).
 */

const ROW = 'flex items-center gap-0.5 border-b bg-muted/30 px-2 py-1';

export interface HeaderSlots {
  /** Left debug/trace controls (CLI Options + Columns & Trace dropdowns). */
  debug: ReactNode;
  /** Restart control. */
  restart: ReactNode;
  /** Center CTA group — Share + Bookmark (favorite). */
  center: ReactNode;
  /** Export/download action. */
  download: ReactNode;
  /** Right toolbar (asset manager, commit/merge, terminal, fork, worktree,
   * session info, transcript, close). */
  right: ReactNode;
}

/** Full toolbar: [debug][restart] — center — [download][right]. */
export function AdvancedInteractiveTabHeader({ debug, restart, center, download, right }: HeaderSlots) {
  return (
    <div data-testid="process-toolbar" className={ROW}>
      {debug}
      {restart}
      <div className="flex-1" />
      {center}
      <div className="flex-1" />
      {download}
      {right}
    </div>
  );
}

/** Minimal toolbar: only Share + Bookmark, aligned right. */
export function StandardInteractiveTabHeader({ center }: Pick<HeaderSlots, 'center'>) {
  return (
    <div data-testid="process-toolbar" className={`${ROW} justify-end`}>
      {center}
    </div>
  );
}
