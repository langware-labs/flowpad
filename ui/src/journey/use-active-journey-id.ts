import { useSearchParams } from 'react-router';
import { JOURNEY_PARAM } from '@src/navigation/DockPointer';

/**
 * The journey currently being shown, from the URL — or null.
 *
 * Read via `useSearchParams` (not `currentDock`) because the home root `/` is
 * not a dock URL and has no DockPointer; on dock surfaces this returns exactly
 * the same value as `currentDock.journeyId`. Mirrors `useHighlight()`.
 *
 * This is the ONLY source of "is a journey shown" — there is no in-memory store,
 * so a reload restores the journey exactly where it was.
 */
export function useActiveJourneyId(): string | null {
  const [searchParams] = useSearchParams();
  return searchParams.get(JOURNEY_PARAM);
}
