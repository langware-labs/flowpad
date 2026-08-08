import { useEffect, useState } from 'react';
import { HIGHLIGHT_PARAM } from '@src/navigation/DockPointer';
import { useCurrentDock } from '@src/navigation/useDockNavigation';
import { useJourneyHighlight } from '@src/journey/journey-highlight';

export { HIGHLIGHT_PARAM };

/** Entrance animation length (ms) before the highlight settles into its linger. */
export const HIGHLIGHT_ENTER_MS = 600;
/** How long the calmer highlight lingers after the entrance, before fading. */
export const HIGHLIGHT_LINGER_MS = 5000;

export type HighlightPhase = 'idle' | 'enter' | 'linger';

/**
 * The wiki word to highlight right now, or null.
 *
 * A running journey answers first: its step already names the tag, and the step
 * is addressed by the URL, so writing `?highlight=` as well was a second copy of
 * the same fact — one that got composed onto stale locations and outlived the
 * step that set it. The param remains for standalone wiki-tips, which are a
 * shareable link with no journey behind them. See docs/wikitip.md.
 */
export function useHighlight(): string | null {
  const journeyWord = useJourneyHighlight();
  const param = useCurrentDock()?.highlight ?? null;
  return journeyWord ?? param;
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
