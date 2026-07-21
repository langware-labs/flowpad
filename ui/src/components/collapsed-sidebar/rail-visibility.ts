import { ViewMode } from '@src/contexts/view-mode-context';

/**
 * Per-mode DELTA model for the left rail's mode-driven icons.
 *
 * A mode's rail = the previous mode's rail (hierarchy order
 * vibe → standard → advanced → dev) + this mode's additions − its `noShow`.
 * Every entry is a plain icon-id list, so updating the rail later is a
 * one-line edit in {@link RAIL_DELTAS}:
 *   - introduce an icon at mode M       → add its id to M's `visible`/`collapsed`
 *   - retire an icon from mode M upward → add its id to M's `noShow`
 *   - promote/demote at a higher mode   → re-list the id there with the new status
 *     (a later entry for an id overrides the inherited one)
 *
 * Only VISIBILITY is decided here. Rendering (and display order) stays with the
 * caller: collapsed-sidebar.tsx orders by its canonical item declaration list,
 * and bespoke items (bookmarks, discover) keep their own renderers/JSX slots.
 */

/** Every icon slot in the rail's mode-driven region. */
export type RailItemId =
  | 'home'
  | 'chats'
  | 'inbox'
  | 'tasks'
  | 'bookmarks'
  | 'assets'
  | 'discover'
  | 'triggers'
  | 'hooks'
  | 'files'
  | 'capabilities'
  | 'agentic-flows'
  // Hub-page rail items (page=hub). Not placed by RAIL_DELTAS — the hub rail is
  // fixed (Home + browse entries) and bypasses the desk mode matrix.
  | 'world'
  | 'organization'
  | 'conversations'
  | 'docs'
  | 'flows';

export type RailStatus =
  /** shown at the top of the rail */
  | 'visible'
  /** behind the chevron expander (revealed on hover, or when active) */
  | 'collapsed';

export type RailDelta = {
  /** ids ADDED as top-rail icons at this mode (or promoted from collapsed). */
  visible?: readonly RailItemId[];
  /** ids ADDED behind the chevron expander at this mode (or demoted). */
  collapsed?: readonly RailItemId[];
  /** ids REMOVED at this mode. Default: none — omission inherits. */
  noShow?: readonly RailItemId[];
};

/** The mode hierarchy, simplest → fullest. Deltas accumulate along this chain. */
export const MODE_CHAIN = [
  ViewMode.Vibe,
  ViewMode.Standard,
  ViewMode.Advanced,
  ViewMode.Dev,
] as const;

/**
 * The rail spec. `Record<ViewMode, …>` forces a row per mode, so adding a
 * future mode is this table plus its slot in {@link MODE_CHAIN}.
 */
export const RAIL_DELTAS: Record<ViewMode, RailDelta> = {
  // 'tasks' rides every mode (the release side shipped it ALL_VISIBLE).
  [ViewMode.Vibe]: { visible: ['home', 'inbox', 'tasks', 'bookmarks'], collapsed: ['files'] },
  [ViewMode.Standard]: { visible: ['chats'], noShow: ['bookmarks'] },
  [ViewMode.Advanced]: { visible: ['assets'], collapsed: ['triggers', 'hooks'] },
  [ViewMode.Dev]: { visible: ['discover', 'agentic-flows'], collapsed: ['capabilities'] },
};

/**
 * Cumulative resolution of {@link RAIL_DELTAS} up to (and including) `mode`.
 * An id absent from the map is not shown. Display order is NOT taken from the
 * map — callers order by their canonical item declaration list.
 */
export function resolveRail(
  mode: ViewMode,
  deltas: Record<ViewMode, RailDelta> = RAIL_DELTAS,
): ReadonlyMap<RailItemId, RailStatus> {
  const out = new Map<RailItemId, RailStatus>();
  for (const m of MODE_CHAIN) {
    const d = deltas[m];
    d.noShow?.forEach((id) => out.delete(id));
    d.visible?.forEach((id) => out.set(id, 'visible'));
    d.collapsed?.forEach((id) => out.set(id, 'collapsed'));
    if (m === mode) break;
  }
  return out;
}
