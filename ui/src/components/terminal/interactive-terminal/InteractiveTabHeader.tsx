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
  /** Export/download action. */
  download: ReactNode;
  /** Right toolbar (asset manager, commit/merge, terminal, fork, worktree,
   * session info, transcript, close). */
  right: ReactNode;
  /** The session's surface selector (Terminal | Chat | Vibe) — its own group,
   *  set apart from the actions by a divider. */
  modes?: ReactNode;
}

/** The surface selector, divided from the action icons to its right. */
function ModesGroup({ modes }: Pick<HeaderSlots, 'modes'>) {
  if (!modes) return null;
  return <div className="me-1.5 flex items-center border-e border-border pe-1.5">{modes}</div>;
}

/** Centered title overlay — same placement in both layouts so switching view
 * modes never shifts the title. pointer-events-none keeps it from eating clicks
 * on whatever sits beneath it; the title carries a native tooltip only. */
function CenteredTitle({ title }: Pick<HeaderSlots, 'title'>) {
  return <div className="pointer-events-none absolute inset-x-0 flex justify-center">{title}</div>;
}

/** Full toolbar: [debug][restart] — (centered title) — [download][right]. */
export function AdvancedInteractiveTabHeader({ debug, restart, title, download, right, modes }: HeaderSlots) {
  return (
    <div data-testid="process-toolbar" className={`${ROW} relative`}>
      {debug}
      {restart}
      <CenteredTitle title={title} />
      <div className="flex-1" />
      <ModesGroup modes={modes} />
      {download}
      {right}
    </div>
  );
}

/** Minimal toolbar: the centered title plus the few session actions a chat
 *  needs (Fork). Share + Bookmark are deliberately absent — the top navigation
 *  bar already carries them for whatever it is addressing, and a second copy on
 *  the same screen is pure duplication. */
export function StandardInteractiveTabHeader({ title, right, modes }: Pick<HeaderSlots, 'title' | 'right' | 'modes'>) {
  return (
    <div data-testid="process-toolbar" className={`${ROW} relative`}>
      <CenteredTitle title={title} />
      <div className="flex-1" />
      <ModesGroup modes={modes} />
      {right}
    </div>
  );
}
