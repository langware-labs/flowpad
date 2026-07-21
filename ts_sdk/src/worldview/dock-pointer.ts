import type { IDockPointer } from '../models/DockPointer';
import { PageId, ViewType } from '../utils/ui/view-types';
import { isWorldViewProjection, WorldViewProjection } from './projection';

function canonicalWorldViewOptions(
  options: Record<string, string> | undefined,
  focus?: string,
  allowSignal = true,
): Record<string, string> | undefined {
  const next = { ...(options ?? {}) };
  if (next.color && !next.signal) next.signal = next.color;
  delete next.color;
  if (!allowSignal) delete next.signal;
  if (focus) next.focus = focus;

  const hidden = next.hide
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (hidden?.length) next.hide = [...new Set(hidden)].sort().join(',');
  else delete next.hide;

  return Object.keys(next).length ? next : undefined;
}

/**
 * Canonicalize persisted WorldView dock identities at the SDK boundary.
 *
 * Both the UI decoder and the persisted Tab entity use this function, so the
 * retired Hub Atlas and entity-rooted deployment URLs collapse to the same
 * projection-first tab identity before navigation or tab-key comparison.
 */
export function normalizeWorldViewDockPointer(pointer: IDockPointer): IDockPointer {
  if (pointer.viewType === ViewType.ATLAS) {
    const projection =
      pointer.pointer === WorldViewProjection.ORGANIZATION
        ? WorldViewProjection.ORGANIZATION
        : WorldViewProjection.WORLD;
    return {
      ...pointer,
      viewType: ViewType.WORLDVIEW,
      pointer: projection,
      options: canonicalWorldViewOptions(pointer.options, undefined, false),
      page: PageId.HUB,
      tabHash: `hub|${ViewType.WORLDVIEW}|${projection}`,
    };
  }

  if (pointer.viewType !== ViewType.WORLDVIEW) return pointer;

  if (isWorldViewProjection(pointer.pointer)) {
    const page = pointer.pointer === WorldViewProjection.DEPLOYMENT ? PageId.DESK : PageId.HUB;
    const pagePrefix = page === PageId.HUB ? 'hub|' : '';
    return {
      ...pointer,
      options: canonicalWorldViewOptions(
        pointer.options,
        undefined,
        pointer.pointer === WorldViewProjection.DEPLOYMENT,
      ),
      page,
      tabHash: `${pagePrefix}${ViewType.WORLDVIEW}|${pointer.pointer}`,
    };
  }

  const parts = pointer.pointer?.split('/') ?? [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) return pointer;
  const focus = `${parts[0]}-${parts[1]}`;
  return {
    ...pointer,
    pointer: WorldViewProjection.DEPLOYMENT,
    options: canonicalWorldViewOptions(pointer.options, focus),
    page: PageId.DESK,
    tabHash: `${ViewType.WORLDVIEW}|${WorldViewProjection.DEPLOYMENT}`,
  };
}
