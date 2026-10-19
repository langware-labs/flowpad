import { DockPointer } from './DockPointer';
import { tryParseDock } from './try-parse-dock';
import { normalizeWorldViewDockPointer, ViewType } from '@sdk';

/**
 * Collapse the retired Atlas and entity-rooted WorldView URL families into the
 * one projection-first WorldView grammar. Pure: the root loader owns the
 * redirect, so mounted views only ever observe canonical URL state.
 */
export function canonicalWorldViewDockPath(pathname: string, search: string): string | null {
  // `normalizeWorldViewDockPointer` (ts_sdk) already collapses all three retired
  // WorldView families — the Hub `atlas` alias, a bare/duplicated projection,
  // and the entity-rooted `/worldview/<type>/<uuid>` form whose identity becomes
  // shareable `focus` state. Persisted Tab rows go through it (`tab.ts`); this
  // is the URL half, which used to re-implement the same three rules as regexes
  // and template strings. One table, two callers.
  const dock = tryParseDock(`${pathname}${search}`);
  if (dock?.viewType !== ViewType.ATLAS && dock?.viewType !== ViewType.WORLDVIEW) return null;

  const normalized = normalizeWorldViewDockPointer({
    viewType: dock.viewType,
    pointer: dock.pointer,
    options: dock.options,
    page: dock.page,
  });
  const target = new DockPointer(
    normalized.viewType,
    normalized.pointer,
    normalized.options,
    dock.layout,
    normalized.page,
  ).toUrl(pathname);
  return target === `${pathname}${search}` ? null : target;
}
