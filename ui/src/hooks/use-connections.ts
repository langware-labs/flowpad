import { useQueryClient } from '@tanstack/react-query';
import { LazyAsset } from '@sdk/lazy';
import { useLazyAsset } from '@sdk/react/hooks/useLazyAsset';
import { useEffect, useRef } from 'react';
import { connectionsService, type TypeId } from '@sdk';

export const CONNECTIONS_KEY = ['lazy', LazyAsset.Connections] as const;

/**
 * Every connection this box has, as one cached read.
 *
 * One request where the screen used to make eight — and, more to the point, one
 * definition of "connected". Folding four shapes in the browser is what let the
 * Connections table and the LLM sources screen disagree about the same key.
 *
 * `null` means the hub: device logins, stored keys and OAuth grants are box
 * facts, so the action does not exist there and the caller renders nothing
 * rather than an empty-looking box.
 */
export function useConnections(projectTypeId?: TypeId | null) {
  const projectId = projectTypeId?.id ?? '';
  const { data, isLoading, reload: refetch } = useLazyAsset(LazyAsset.Connections, { projectId: projectId || undefined });
  return { connections: data ?? null, isLoading, refetch };
}

/**
 * Ask the box to check the harness logins, once per screen visit.
 *
 * A harness login lives on a field that does not survive a backend restart, so
 * the rows read "Not checked" until someone asks the vendor CLIs — and asking
 * is a WRITE (the verdict is mirrored onto the box), which is why it is not
 * folded into the read above.
 *
 * Cheap on repeat: the backend skips a harness it has already asked about, and
 * the ref keeps a double-invoked effect from firing twice. Invalidates the list
 * so the freshly answered rows are what the screen draws.
 */
export function useCheckHarnessLogins() {
  const qc = useQueryClient();
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void connectionsService
      .checkHarnessLogins()
      .then((checked) => {
        // Nothing to redraw when nothing was asked — every harness had already
        // answered, and the rows on screen are already that answer.
        if (Object.keys(checked).length) void qc.invalidateQueries({ queryKey: CONNECTIONS_KEY });
      })
      .catch(() => {
        // A vendor CLI that cannot be reached costs a verdict, not the screen:
        // the rows keep saying "Not checked", which is what is true.
      });
  }, [qc]);
}
