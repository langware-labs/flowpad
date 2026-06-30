import type { ReactNode } from 'react';
import { useIsVibe } from '@src/contexts/view-mode-context';

/**
 * Layout mix-and-match primitive for the simplest "Vibe" skin. Renders the
 * `vibe` arrangement only in Vibe mode, otherwise the `fallback` (the existing
 * Standard/Advanced/Dev arrangement).
 *
 *   <VibeSwap
 *     vibe={<VibeHome {...slots} />}
 *     fallback={<HomeLandingFull {...slots} />}
 *   />
 *
 * Skin-layer rule (docs/viewmodes.md): build the shared slot nodes ONCE in the
 * stateful container so every hook/handler runs unconditionally and identically,
 * then hand the same nodes to both branches. Vibe only selects the arrangement —
 * it never changes data, hooks, or behavior.
 */
export function VibeSwap({ vibe, fallback }: { vibe: ReactNode; fallback: ReactNode }) {
  const isVibe = useIsVibe();
  return <>{isVibe ? vibe : fallback}</>;
}
