import type { ReactNode } from 'react';

/**
 * The interactive tab header — the ProcessToolbar row above the Claude pane.
 * Pure arrangement: the stateful ProcessToolbar builds each control once and
 * hands the nodes here. One layout for every surface; what differs per surface
 * (the debug menu is terminal-only) is decided by which slots are filled.
 */

// bg-background (not bg-muted) so this header reads as one surface with the
// active tab above it — the selected tab flows straight into the terminal body.
// Shared with PaneBar so both terminal header rows stay in lockstep.
export const ROW = 'flex items-center gap-0.5 border-b bg-background px-2 py-1';

interface HeaderSlots {
  /** Left debug menu — terminal surface only, empty elsewhere. */
  debug: ReactNode;
  /** Entity title — absolutely centered in the row so it stays put across surfaces. */
  title: ReactNode;
  /** Right cluster: Fork, the session actions menu, and Close when embedded. */
  right: ReactNode;
  /** The session's surface selector (Terminal / Chat / Vibe), shown left of the
   *  right cluster behind a divider. Omitted when embedded. */
  modes?: ReactNode;
}

/** [debug] — (centered title) — [modes] | [right]. Share + Bookmark are
 *  deliberately absent — the top navigation bar already carries them for
 *  whatever it is addressing, and a second copy on the same screen is pure
 *  duplication. */
export function InteractiveTabHeader({ debug, title, right, modes }: HeaderSlots) {
  return (
    <div data-testid="process-toolbar" className={`${ROW} relative`}>
      {debug}
      {/* Centered overlay, so the title stays put whichever slots are filled.
          pointer-events-none keeps it from eating clicks on whatever sits
          beneath it; the title carries a native tooltip only. */}
      <div className="pointer-events-none absolute inset-x-0 flex justify-center">{title}</div>
      <div className="flex-1" />
      {/* The surface selector, divided from the action icons to its right. */}
      {modes && <div className="me-1.5 flex items-center border-e border-border pe-1.5">{modes}</div>}
      {right}
    </div>
  );
}
