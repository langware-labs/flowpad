import type { ReactNode } from 'react';
import { useIsVibe } from '@src/contexts/view-mode-context';

/**
 * Layout mix-and-match primitive for the simplest "Vibe" skin. Shows the
 * `vibe` arrangement in Vibe mode and the `fallback` in Standard/Advanced/Dev.
 *
 *   <VibeSwap
 *     vibe={<VibeHome {...slots} />}
 *     fallback={<HomeLandingFull {...slots} />}
 *   />
 *
 * Skin-layer rule (docs/viewmodes.md): both branches stay mounted so every
 * hook/handler runs unconditionally and identically. Vibe only selects the
 * visible arrangement; it never changes data, hooks, or behavior.
 */
export function VibeSwap({ vibe, fallback }: { vibe: ReactNode; fallback: ReactNode }) {
  const isVibe = useIsVibe();
  const branchClassName = 'flex min-h-0 flex-1 flex-col';

  return (
    <>
      <div
        className={branchClassName}
        style={{ display: isVibe ? undefined : 'none' }}
        aria-hidden={!isVibe}
      >
        {vibe}
      </div>
      <div
        className={branchClassName}
        style={{ display: isVibe ? 'none' : undefined }}
        aria-hidden={isVibe}
      >
        {fallback}
      </div>
    </>
  );
}
