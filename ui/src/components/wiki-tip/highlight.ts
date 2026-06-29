import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { HIGHLIGHT_PARAM } from '@src/navigation/DockPointer';

export { HIGHLIGHT_PARAM };

/** Entrance animation length (ms) before the highlight settles into its linger. */
export const HIGHLIGHT_ENTER_MS = 600;
/** How long the calmer highlight lingers after the entrance, before fading. */
export const HIGHLIGHT_LINGER_MS = 5000;

export type HighlightPhase = 'idle' | 'enter' | 'linger';

/**
 * The wiki word the current URL asks to highlight, or null when none is set.
 *
 * Reads the `highlight` search param directly (not via `currentDock`) so it
 * works on the home root `/` — which is NOT a dock URL, so `currentDock` is
 * null there. On dock surfaces the same param is also reachable via
 * `currentDock.highlight`. See docs/wikitip.md.
 */
export function useHighlight(): string | null {
  const [searchParams] = useSearchParams();
  return searchParams.get(HIGHLIGHT_PARAM);
}

/**
 * Drives the onboarding-style highlight lifecycle for a given wiki word:
 *
 *   idle → enter (brief attention animation, ~600ms) → linger (calmer steady
 *   highlight, ~5s) → idle (fade out)
 *
 * This matches product-onboarding best practice: a short attention-grabbing
 * entrance, then a calmer state that lingers so the user can act, focused on
 * one element at a time. See docs/wikitip.md.
 */
export function useLingeringHighlight(
  wikiword: string,
  lingerMs = HIGHLIGHT_LINGER_MS,
): { active: boolean; phase: HighlightPhase } {
  const target = useHighlight();
  const matched = !!wikiword && target === wikiword;
  const [phase, setPhase] = useState<HighlightPhase>('idle');

  useEffect(() => {
    if (!matched) {
      setPhase('idle');
      return;
    }
    setPhase('enter');
    const toLinger = window.setTimeout(() => setPhase('linger'), HIGHLIGHT_ENTER_MS);
    const toIdle = window.setTimeout(() => setPhase('idle'), HIGHLIGHT_ENTER_MS + lingerMs);
    return () => {
      window.clearTimeout(toLinger);
      window.clearTimeout(toIdle);
    };
    // Re-run when the matched word changes (a fresh ?highlight= replays the cycle).
  }, [matched, target, lingerMs]);

  return { active: phase !== 'idle', phase };
}
