import { normalizeRetiredDockPointer, retiredDockTarget } from '@sdk';
import { DockPointer } from './DockPointer';
import { tryParseDock } from './try-parse-dock';

/**
 * Resolve a retired dock address forward in URL form: a retired view type
 * (`environment`, `connections`, `api-keys` → `/dock[/hub]/credentials/connections`,
 * `skills`, the Events trio, …) or a retired section of a live view
 * (`/dock[/hub]/data-sources/channels` → `/dock[/hub]/inbound`).
 *
 * `RETIRED_DOCK_VIEWS` / `RETIRED_DOCK_POINTERS` (ts_sdk `retired-views.ts`) are
 * the one place a retirement is declared; saved Tab rows go through the same
 * `normalizeRetiredDockPointer` (`tab.ts`). This file is only its URL half.
 *
 * Pure, and the root loader owns the redirect, so a mounted view only ever
 * observes canonical URL state. The pointer is replaced by the target's; the
 * query string (dock options), layout and page are kept.
 */
export function canonicalRetiredViewDockPath(pathname: string, search: string): string | null {
  const dock = tryParseDock(`${pathname}${search}`);
  if (!dock || !retiredDockTarget({ viewType: dock.viewType, pointer: dock.pointer })) return null;
  const normalized = normalizeRetiredDockPointer({ viewType: dock.viewType, pointer: dock.pointer });
  return new DockPointer(normalized.viewType, normalized.pointer, dock.options, dock.layout, dock.page).toUrl(
    pathname,
  );
}
