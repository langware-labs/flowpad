import type { ReactNode } from 'react';

/**
 * Two presentational layouts for the interactive tab header (the ProcessToolbar
 * row above the Claude pane). Both consume the SAME slot nodes — the stateful
 * ProcessToolbar builds each button once and hands them here. A view mode only
 * selects the arrangement; it never changes data, hooks, or behavior. See
 * docs/viewmodes.md (skin-layer rule + slot pattern).
 */

// bg-background (not bg-muted) so this header reads as one surface with the
// active tab above it — the selected tab flows straight into the terminal body.
// Shared with PaneBar so both terminal header rows stay in lockstep.
export const ROW = 'flex items-center gap-0.5 border-b bg-background px-2 py-1';

export interface HeaderSlots {
  /** Left debug/trace controls (CLI Options + Columns & Trace dropdowns). */
  debug: ReactNode;
  /** Restart control. */
  restart: ReactNode;
  /** Entity title — absolutely centered in the row so it stays put across modes. */
  title: ReactNode;
  /** Share + Bookmark (favorite) CTAs — right-aligned. */
  actions: ReactNode;
  /** Export/download action. */
  download: ReactNode;
  /** Right toolbar (asset manager, commit/merge, terminal, fork, worktree,
   * session info, transcript, close). */
  right: ReactNode;
}

/** Centered title overlay — same placement in both layouts so switching view
 * modes never shifts the title. pointer-events-none keeps it from eating clicks
 * on whatever sits beneath it; the title carries a native tooltip only. */
function CenteredTitle({ title }: Pick<HeaderSlots, 'title'>) {
  return (
    <div className="pointer-events-none absolute inset-x-0 flex justify-center">
      {title}
    </div>
  );
}

/** Full toolbar: [debug][restart] — (centered title) — [download][right][actions]. */
export function AdvancedInteractiveTabHeader({ debug, restart, title, actions, download, right }: HeaderSlots) {
  return (
    <div data-testid="process-toolbar" className={`${ROW} relative`}>
      {debug}
      {restart}
      <CenteredTitle title={title} />
      <div className="flex-1" />
      {download}
      {right}
      {actions}
    </div>
  );
}

/** Minimal toolbar: centered title with Share + Bookmark aligned right. */
export function StandardInteractiveTabHeader({ title, actions }: Pick<HeaderSlots, 'title' | 'actions'>) {
  return (
    <div data-testid="process-toolbar" className={`${ROW} relative`}>
      <CenteredTitle title={title} />
      <div className="flex-1" />
      {actions}
    </div>
  );
}
