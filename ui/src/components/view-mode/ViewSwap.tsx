import type { ReactNode } from 'react';
import { useIsAdvanced } from '@src/contexts/view-mode-context';

/**
 * Layout mix-and-match primitive. Renders exactly one of two presentational
 * arrangements based on the global View mode.
 *
 *   <ViewSwap
 *     advanced={<AdvancedToolbar {...slots} />}
 *     standard={<StandardToolbar {...slots} />}
 *   />
 *
 * Skin-layer rule: build the shared button/slot nodes ONCE in the stateful
 * container (so all hooks/handlers run unconditionally and identically), then
 * hand the same nodes to both branches. A view mode only selects the
 * arrangement — it never changes data, hooks, or behavior. See docs/viewmodes.md.
 */
export function ViewSwap({ advanced, standard }: { advanced: ReactNode; standard: ReactNode }) {
  const isAdvanced = useIsAdvanced();
  return <>{isAdvanced ? advanced : standard}</>;
}
