import { createViewerContext } from '@sdk';
import { useEffect, useMemo, useRef } from 'react';

/** One value of a kind, drawn in place by that kind's data viewer (the generic one else).
 *  Redrawn only when the value's CONTENT changes — a refetch that hands an equal object keeps the
 *  viewer (and whatever the person opened in it) as it is. */
export function KindValue({ kind, value, testId }: { kind: string; value: unknown; testId?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const ctx = useMemo(() => createViewerContext(), []);
  const content = useMemo(() => JSON.stringify(value), [value]);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    // The render is async: draw into a fresh slot and show it only if this run is still the current
    // one — a second run (a re-render, StrictMode's double effect) must replace the view, not add to it.
    let current = true;
    const slot = document.createElement('div');
    void ctx
      .render(slot, { kind, value: JSON.parse(content) })
      .then(() => {
        if (current) el.replaceChildren(slot);
      })
      .catch((err: unknown) => console.error('[kind-value] cannot show', kind, err));
    return () => {
      current = false;
    };
  }, [ctx, kind, content]);
  return <div ref={host} data-testid={testId} />;
}
