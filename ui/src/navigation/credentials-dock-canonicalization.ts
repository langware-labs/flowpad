import { normalizeRetiredDockPointer, RETIRED_DOCK_VIEWS } from '@sdk';
import { DockPointer } from './DockPointer';
import { tryParseDock } from './try-parse-dock';

/**
 * The retired view types in URL form. A ViewType's enum value IS its URL
 * segment, so the retirement table's own keys are the segments to match — the
 * mapping is not restated here. `RETIRED_DOCK_VIEWS` (ts_sdk) is the one place
 * a retirement is declared; this file is only its URL half.
 */
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
  const dock = tryParseDock(`${pathname}${search}`);
  const target = dock?.viewType ? RETIRED_DOCK_VIEWS[dock.viewType] : undefined;
  if (!dock || !target) return null;
  // `normalizeRetiredDockPointer` is the ONE declaration of where a retired
  // view resolves to; saved Tab rows already go through it (`tab.ts`). This is
  // the URL half, now reading the same table through the same function instead
  // of re-implementing the mapping as a regex + template.
  const normalized = normalizeRetiredDockPointer({ viewType: dock.viewType, pointer: dock.pointer });
  return new DockPointer(normalized.viewType, normalized.pointer, dock.options, dock.layout, dock.page).toUrl(
    pathname,
  );
}
