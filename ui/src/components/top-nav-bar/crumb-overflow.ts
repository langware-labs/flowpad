import type { Crumb } from './use-entity-breadcrumbs';

/**
 * Which crumbs fit, and which fold into the "…".
 *
 * Pure on purpose: the component measures, this decides. That keeps the rule
 * testable without a layout engine — jsdom reports every width as 0, so a
 * measurement-coupled implementation could only be tested in a real browser.
 *
 * The rule: the FIRST crumb (the project — which project you're in) and the LAST
 * (what you're looking at) are the two facts a person actually needs, so they
 * are never hidden. Middle crumbs drop from the middle outward, because the hops
 * adjacent to each end carry more meaning than the ones in the deep middle.
 */

export interface CrumbLayout {
  visible: Crumb[];
  hidden: Crumb[];
}

/** With no usable measurements (jsdom, or a field that hasn't laid out yet) fall
 *  back to a count rule, so behaviour is still deterministic and assertable. */
export const UNMEASURED_CRUMB_LIMIT = 4;

/** Width the "…" trigger occupies once anything collapses. */
const ELLIPSIS_WIDTH = 28;

export function selectVisibleCrumbs(crumbs: Crumb[], widths: number[], available: number): CrumbLayout {
  const none: CrumbLayout = { visible: crumbs, hidden: [] };
  if (crumbs.length <= 2) return none;

  const measured = widths.length === crumbs.length && widths.some((w) => w > 0) && available > 0;

  if (!measured) {
    if (crumbs.length <= UNMEASURED_CRUMB_LIMIT) return none;
    return { visible: [crumbs[0], crumbs[crumbs.length - 1]], hidden: crumbs.slice(1, crumbs.length - 1) };
  }

  const total = widths.reduce((sum, w) => sum + w, 0);
  if (total <= available) return none;

  // Keep dropping the middle-most survivor until it fits. `keep` holds indices.
  const keep = crumbs.map((_, i) => i);
  const width = () => keep.reduce((sum, i) => sum + widths[i], 0) + ELLIPSIS_WIDTH;

  while (keep.length > 2 && width() > available) {
    // Middle of the interior range [1, keep.length - 2].
    const interior = keep.length - 2;
    keep.splice(1 + Math.floor((interior - 1) / 2), 1);
  }

  const keepSet = new Set(keep);
  return {
    visible: keep.map((i) => crumbs[i]),
    hidden: crumbs.filter((_, i) => !keepSet.has(i)),
  };
}
