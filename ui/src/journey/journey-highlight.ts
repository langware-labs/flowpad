import { useSyncExternalStore } from 'react';

/**
 * The tag word the running journey's current step highlights.
 *
 * The journey used to write `?highlight=` onto the live URL. That was a second
 * copy of a fact the step already carried, and the copy is what went wrong: it
 * was composed onto whatever location was current when it was written, so a
 * write issued during a navigation landed on the location the app had just left,
 * and it outlived the step that set it.
 *
 * The step is addressed by the URL (`?journeyId=` + `?journeyStep=`), so the
 * highlight is derivable — but only after the step document has loaded, which is
 * async for a server journey. This is that derivation, published once by
 * {@link JourneyController} and read by `useHighlight`.
 *
 * The URL stays the source of truth for POSITION; this is a projection of it,
 * with exactly one writer. Consumers subscribe rather than poll, so the tag
 * lights in the same commit the step changes.
 */
let current: string | null = null;
const listeners = new Set<() => void>();

/** Publish the current step's highlight. Called only by the journey controller. */
export function setJourneyHighlight(word: string | null): void {
  if (current === word) return;
  current = word;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => current;

/** The word a running journey wants highlighted, or null when none is running. */
export function useJourneyHighlight(): string | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
