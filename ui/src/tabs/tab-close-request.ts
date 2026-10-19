import { useEffect, useRef } from 'react';

/**
 * Let content close the tab it is shown in, without owning the close.
 *
 * Closing is the strip's job: it knows where to land afterwards (a sibling chip,
 * the workspace Display, the project home). A viewer that wants to dismiss
 * itself -- e.g. a web page that can't be embedded, once it has been handed to
 * the real browser -- asks here, and whichever mounted strip owns the tab key
 * closes it exactly as its X button would.
 */
type TabCloser = (key: string) => boolean;

const closers = new Set<TabCloser>();

/** A strip registers a closer that returns true when it owned and closed `key`. */
export function registerTabCloser(closer: TabCloser): () => void {
  closers.add(closer);
  return () => {
    closers.delete(closer);
  };
}

/** Close the tab with this key through its strip. False when no strip owns it. */
export function requestTabClose(key: string | null | undefined): boolean {
  if (!key) return false;
  for (const closer of closers) {
    if (closer(key)) return true;
  }
  return false;
}

/**
 * A strip's registration: it closes any key in `owns` with its own `close` (the
 * one its X button uses). Registers once per mount and reads the latest values.
 */
export function useTabCloser(owns: ReadonlyMap<string, unknown>, close: (key: string) => void): void {
  const latest = useRef({ owns, close });
  latest.current = { owns, close };
  useEffect(
    () =>
      registerTabCloser((key) => {
        if (!latest.current.owns.has(key)) return false;
        latest.current.close(key);
        return true;
      }),
    [],
  );
}
