/**
 * THE left rail spec — what appears on the desk rail and in what order.
 *
 * Scope, so this is not read as total: the account cluster at the foot of the
 * sidebar (dev-mode toggle, JourneyBadge, Org & teams, assistant, theme,
 * user menu) is a deliberately separate region rendered directly by
 * collapsed-sidebar.tsx. Those buttons carry `data-testid` rather than
 * `data-rail-item` — do not "fix" one into RAIL_ITEMS.
 *
 * The rail is the same in every mode. To change it: edit {@link RAIL_ITEMS}.
 * Nothing else orders or filters it.
 */

/** Every icon slot on the DESK rail — the ids RAIL_ITEMS may place. */
export type RailItemId =
  | 'stream_inbox'
  /** OAuth connections, API-key credentials and the FlowPad login — one screen. */
  | 'credentials';

/**
 * Hub-page rail ids (page=hub). A SEPARATE union, not more members of
 * {@link RailItemId}: the hub rail is its own fixed list, and keeping the two
 * apart is what stops a hub id being written into RAIL_ITEMS. `stream_inbox`
 * exists on both surfaces and means a different thing on each — another reason
 * not to share one union. `tasks` is likewise hub-only: the desk rail dropped it
 * (task assets are reached through the project), and the hub's `tasks` is a
 * different thing entirely — HUB_RECORDS with a `task` pointer. A shared union
 * would have made that removal look like a hub change.
 */
export type HubRailItemId =
  | 'world'
  | 'organization'
  | 'stream_inbox'
  | 'tasks'
  | 'docs'
  | 'token-plan'
  | 'llm-endpoints'
  | 'credentials';

/**
 * The rail, top to bottom.
 *
 * Only the two screens used constantly ride the rail. Every other screen —
 * data sources, search indexes, automations, runs, hooks, LLM sources and the
 * developer ones — is opened by asking for it in the top bar (the smart
 * navigator), which reaches each of them by name. `home`, `files`, `bookmarks`
 * and the project live on the top navigation bar.
 *
 * Both are ungated: a signed-out stream inbox is where "Login required" brings
 * the user back in, and Connections is where the FIRST connection is made — a
 * gate on "one exists" would hide each in the one state where it matters most.
 */
export const RAIL_ITEMS: readonly RailItemId[] = ['stream_inbox', 'credentials'];
