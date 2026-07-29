import { ViewMode } from '@src/contexts/view-mode-context';

/**
 * THE left rail spec — one ordered list that owns BOTH what appears and in what
 * order, for every mode and every entry.
 *
 * Two rules, and they are the whole model:
 *
 *  1. **Modes are strictly additive.** An item declares the earliest mode it
 *     appears in (`from`) and is inherited by every fuller mode along
 *     {@link MODE_CHAIN} (vibe ⊂ standard ⊂ advanced ⊂ dev). There is no removal
 *     escape hatch — the previous delta model had one (`noShow`), and its only
 *     use made Bookmarks *vanish* when the user stepped up from Vibe to
 *     Standard. Adding one back re-opens that class of bug.
 *
 *  2. **Array order is render order, in every mode.** A mode's rail is a
 *     subsequence of {@link RAIL_ITEMS} — so icons can never reshuffle when the
 *     mode changes. This is why the bespoke entries (project / bookmarks /
 *     discover) are listed here too: they used to be JSX slots pinned after the
 *     render loop, which made their position unexpressible and mode-dependent.
 *     They keep their custom renderers in collapsed-sidebar.tsx; only their
 *     PLACEMENT lives here.
 *
 * To change the rail: edit {@link RAIL_ITEMS}. Nothing else orders or filters it.
 */

/** Every icon slot on the DESK rail — the ids RAIL_ITEMS may place. */
export type RailItemId =
  | 'home'
  /** The active project — bespoke renderer, present only while one is selected. */
  | 'project'
  | 'chats'
  | 'inbox'
  | 'tasks'
  | 'bookmarks'
  | 'discover'
  | 'triggers'
  | 'hooks'
  | 'files'
  | 'capabilities'
  | 'agentic-flows';

/**
 * Hub-page rail ids (page=hub). A SEPARATE union, not more members of
 * {@link RailItemId}: the hub rail is a fixed list that bypasses the mode matrix
 * and the gates entirely, so keeping the two apart is what stops a hub id being
 * written into RAIL_ITEMS (where it would resolve to a silent `null` at render).
 * `home` and `tasks` exist on both surfaces and mean different things on each —
 * another reason not to share one union.
 */
export type HubRailItemId =
  | 'home'
  | 'world'
  | 'organization'
  | 'conversations'
  | 'tasks'
  | 'docs'
  | 'flows'
  | 'credentials';

export type RailPlacement =
  /** Rides the top rail. */
  | 'top'
  /** Behind the chevron expander (revealed on hover, or when active). */
  | 'overflow';

/**
 * A content gate: the item is only worth a rail slot once the thing it opens
 * actually exists. Answered by the component (which owns the live queries) and
 * passed into {@link resolveRail}, so this module stays pure and testable.
 */
export type RailGate =
  /** A project is currently selected. */
  | 'project'
  /** At least one Conversation exists. */
  | 'conversations'
  /** At least one Task exists. */
  | 'tasks';

export type RailSpec = {
  id: RailItemId;
  /** Earliest mode this item appears in; inherited by every fuller mode. */
  from: ViewMode;
  placement: RailPlacement;
  /** When set, the item also requires this gate to be satisfied. */
  gate?: RailGate;
};

/** The mode hierarchy, simplest → fullest. Membership accumulates along it. */
export const MODE_CHAIN = [
  ViewMode.Vibe,
  ViewMode.Standard,
  ViewMode.Advanced,
  ViewMode.Dev,
] as const;

/**
 * The rail, top to bottom.
 *
 * NOTE on the absence of an `assets` entry: it is deliberate and load-bearing.
 * The project item already opens the project's assets (`navigation.openAssets()`),
 * so a separate Assets icon was a second door onto the same room — and it made
 * one click light two rail buttons, which is why `onTasks`/`onAssets` have to
 * subtract each other in the first place.
 *
 * Standard adds no icon of its own: it differs from Vibe only in what `chats`
 * targets (the chats list vs. resuming the last UI chat). That is the intended
 * reading of "Standard = Vibe + …", not an omission.
 */
export const RAIL_ITEMS: readonly RailSpec[] = [
  { id: 'home', from: ViewMode.Vibe, placement: 'top' },
  { id: 'project', from: ViewMode.Vibe, placement: 'top', gate: 'project' },
  { id: 'chats', from: ViewMode.Vibe, placement: 'top' },
  { id: 'bookmarks', from: ViewMode.Vibe, placement: 'top' },
  { id: 'inbox', from: ViewMode.Vibe, placement: 'top', gate: 'conversations' },
  { id: 'tasks', from: ViewMode.Vibe, placement: 'top', gate: 'tasks' },
  { id: 'discover', from: ViewMode.Dev, placement: 'top' },
  { id: 'agentic-flows', from: ViewMode.Dev, placement: 'top' },
  { id: 'files', from: ViewMode.Vibe, placement: 'overflow' },
  { id: 'triggers', from: ViewMode.Advanced, placement: 'overflow' },
  { id: 'hooks', from: ViewMode.Advanced, placement: 'overflow' },
  { id: 'capabilities', from: ViewMode.Dev, placement: 'overflow' },
];

/** All gates false — the shape callers build on. */
export const NO_GATES: Record<RailGate, boolean> = {
  project: false,
  conversations: false,
  tasks: false,
};

/**
 * The rail for `mode`, in {@link RAIL_ITEMS} order, with unsatisfied gates
 * dropped. Callers partition the result by `placement`; they must NOT re-sort it.
 */
export function resolveRail(mode: ViewMode, gates: Record<RailGate, boolean>): readonly RailSpec[] {
  const reach = MODE_CHAIN.indexOf(mode);
  return RAIL_ITEMS.filter(
    (item) => MODE_CHAIN.indexOf(item.from) <= reach && (!item.gate || gates[item.gate]),
  );
}
