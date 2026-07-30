import { RETIRED_DOCK_VIEWS, type ViewType } from '@sdk';

/**
 * The retired view types in URL form. A ViewType's enum value IS its URL
 * segment, so the retirement table's own keys are the segments to match — the
 * mapping is not restated here. `RETIRED_DOCK_VIEWS` (ts_sdk) is the one place
 * a retirement is declared; this file is only its URL half.
 */
const RETIRED_SEGMENTS = Object.keys(RETIRED_DOCK_VIEWS);

const RETIRED_PATH = new RegExp(`^(.*/(?:dock|dev|win))(/hub)?/(${RETIRED_SEGMENTS.join('|')})(?:/.*)?/?$`);

/**
 * Collapse the retired credential view types into the one Credentials
 * grammar: `/dock[/hub]/credentials/<subview>`.
 *
 * `environment`, `connections`, and `api-keys` used to be sibling view types
 * rendering the same three components as this view's tabs — four doors onto one
 * room, each with its own active-state and framing rules. They survive only as
 * decodable URLs so old links, bookmarks, and saved tabs keep working, the same
 * way `atlas` survives for WorldView.
 *
 * Pure, and the root loader owns the redirect, so a mounted view only ever
 * observes canonical URL state. Any trailing segment is dropped: none of the
 * three ever carried a pointer, so there is nothing to preserve — but the query
 * string is, since it may hold unrelated dock options.
 */
export function canonicalCredentialsDockPath(pathname: string, search: string): string | null {
  const match = pathname.match(RETIRED_PATH);
  if (!match) return null;

  const [, prefix, hub = '', retired] = match;
  const target = RETIRED_DOCK_VIEWS[retired as ViewType];
  if (!target) return null;

  return `${prefix}${hub}/${target.viewType}/${target.pointer}${search}`;
}
