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
 *     mode changes. This is why `discover` is listed here too: it used to be a
 *     JSX slot pinned after the render loop, which made its position
 *     unexpressible and mode-dependent. Its custom click target still lives in
 *     collapsed-sidebar.tsx; only its PLACEMENT lives here.
 *
 * To change the rail: edit {@link RAIL_ITEMS}. Nothing else orders or filters it.
 */

/** Every icon slot on the DESK rail — the ids RAIL_ITEMS may place. */
export type RailItemId =
  | 'chats'
  | 'inbox'
  | 'discover'
  /** Rules and the events they fire on — replaced `triggers` + `signals`. */
  | 'events'
  | 'hooks'
  | 'llm-sources'
  | 'capabilities'
  | 'graph-workflows'
  | 'data-sources'
  | 'rag'
  | 'process-runs';

/**
 * Hub-page rail ids (page=hub). A SEPARATE union, not more members of
 * {@link RailItemId}: the hub rail is a fixed list that bypasses the mode matrix
 * entirely, so keeping the two apart is what stops a hub id being written into
 * RAIL_ITEMS (where it would resolve to a silent `null` at render). `inbox`
 * exists on both surfaces and means a different thing on each — another reason
 * not to share one union. `tasks` is likewise hub-only: the desk rail dropped it
 * (task assets are reached through the project), and the hub's `tasks` is a
 * different thing entirely — HUB_RECORDS with a `task` pointer. A shared union
 * would have made that removal look like a hub change.
 */
export type HubRailItemId =
  | 'world'
  | 'organization'
  | 'inbox'
  | 'tasks'
  | 'docs'
  | 'token-plan'
  | 'llm-endpoints'
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
  /** At least one Conversation exists. */
  'conversations';

export type RailSpec = {
  id: RailItemId;
  /** Earliest mode this item appears in; inherited by every fuller mode. */
  from: ViewMode;
  placement: RailPlacement;
  /** When set, the item also requires this gate to be satisfied. */
  gate?: RailGate;
};

/** The mode hierarchy, simplest → fullest. Membership accumulates along it. */
export const MODE_CHAIN = [ViewMode.Vibe, ViewMode.Standard, ViewMode.Advanced, ViewMode.Dev] as const;

/**
 * The rail, top to bottom.
 *
 * NOTE on what is deliberately ABSENT. `home`, `files` and `bookmarks` moved to
 * the top navigation bar — Home and Files as nav buttons, bookmarks onto the
 * star that also toggles the current favorite. `project` is the bar's leading
 * breadcrumb, and `assets` is reached through it. Each would otherwise be a
 * second door onto the same room, lighting two buttons for one destination.
 *
 * Standard adds no icon of its own: it differs from Vibe only in what `chats`
 * targets (the chats list vs. resuming the last UI chat). That is the intended
 * reading of "Standard = Vibe + …", not an omission.
 */
export const RAIL_ITEMS: readonly RailSpec[] = [
  { id: 'chats', from: ViewMode.Vibe, placement: 'top' },
  { id: 'inbox', from: ViewMode.Vibe, placement: 'top', gate: 'conversations' },
  // Took the Tasks slot. Ungated on purpose: this screen is where the FIRST
  // source is created, so gating it on "a source exists" would make it
  // unreachable from empty — the one state where it matters most.
  { id: 'data-sources', from: ViewMode.Advanced, placement: 'top' },
  // Ungated for the same reason as data sources: this screen is where the first index is
  // created, so a gate on "an index exists" would make it unreachable from empty.
  { id: 'rag', from: ViewMode.Advanced, placement: 'top' },
  { id: 'discover', from: ViewMode.Dev, placement: 'top' },
  { id: 'graph-workflows', from: ViewMode.Dev, placement: 'top' },
  // Rules and the events they fire on, merged. Took BOTH the old `signals`
  // (Dev/top) and `triggers` (Advanced/overflow) slots: Advanced because
  // dropping to Dev would have removed rules from a mode that already had
  // them, top because a screen you operate does not belong behind a chevron.
  { id: 'events', from: ViewMode.Advanced, placement: 'top' },
  // Advanced, not Dev: 'what did my agent produce' is an ordinary question,
  // and the answer was previously unreachable for any run without a
  // spawning entity to browse to.
  { id: 'process-runs', from: ViewMode.Advanced, placement: 'top' },
  { id: 'hooks', from: ViewMode.Advanced, placement: 'overflow' },
  // Advanced, beside `hooks`: Standard is Vibe plus nothing (an invariant with a test), and
  // this is a settings destination. A Vibe or Standard user still reaches it from the
  // harness-status button in the version popover, which does not depend on the rail.
  { id: 'llm-sources', from: ViewMode.Advanced, placement: 'overflow' },
  { id: 'capabilities', from: ViewMode.Dev, placement: 'overflow' },
];

/** All gates false — the shape callers build on. */
export const NO_GATES: Record<RailGate, boolean> = {
  conversations: false,
};

/**
 * The rail for `mode`, in {@link RAIL_ITEMS} order, with unsatisfied gates
 * dropped. Callers partition the result by `placement`; they must NOT re-sort it.
 */
export function resolveRail(mode: ViewMode, gates: Record<RailGate, boolean>): readonly RailSpec[] {
  const reach = MODE_CHAIN.indexOf(mode);
  return RAIL_ITEMS.filter((item) => MODE_CHAIN.indexOf(item.from) <= reach && (!item.gate || gates[item.gate]));
}
