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
    if (!host.current) return;
    void ctx
      .render(host.current, { kind, value: JSON.parse(content) })
      .catch((err: unknown) => console.error('[kind-value] cannot show', kind, err));
  }, [ctx, kind, content]);
  return <div ref={host} data-testid={testId} />;
}
