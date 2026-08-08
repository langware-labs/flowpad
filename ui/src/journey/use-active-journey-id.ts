import { useCurrentDock } from '@src/navigation/useDockNavigation';

/**
 * The journey currently being shown, from the URL — or null.
 *
 * Read through the pointer's typed accessor. This used to go around it via
 * `useSearchParams`, because the home root was not a DockPointer and the param
 * was unreachable there; the root is an ordinary location now, so the detour
 * is gone and there is one reader of `?journeyId=`.
 *
 * This is the ONLY source of "is a journey shown" — there is no in-memory store,
 * so a reload restores the journey exactly where it was.
 */
export function useActiveJourneyId(): string | null {
  return useCurrentDock()?.journeyId ?? null;
}
