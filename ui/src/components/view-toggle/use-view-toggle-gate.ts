import { AgenticProcess, TypeId } from '@sdk';
import { useEntity } from '@src/hooks/entity-hooks';
import { sessionIdForDock, type ViewMode } from '@src/contexts/view-mode-context';
import { surfaceTransportGate } from '@src/components/terminal/interactive-terminal/use-process-surface';
import { useCurrentDock } from '@src/navigation/useDockNavigation';
import { useMemo } from 'react';

/** Ask, per mode, whether picking it right now would actually take effect. */
export type ViewToggleGate = (mode: ViewMode) => boolean;

/**
 * Which mode segments must be greyed out, because the transport change they
 * imply is refused while a turn is in flight.
 *
 * The control has to answer this, not just the reconciler. Mode selection is
 * URL-first — the click only navigates — so with no gate here the click
 * SUCCEEDS at everything it does: the URL moves, the segment lights up, the
 * preference is adopted, the session's `last_mode` is stamped. Only the
 * transport silently stays put, because `useProcessSurface` declines and waits
 * for idle. The user is left looking at a footer that says Terminal over a
 * headless pane with nothing anywhere explaining why, and the only tell that
 * anything is pending is that it eventually fixes itself minutes later.
 *
 * Reads the SAME `surfaceTransportGate` the effect does, so a greyed segment is
 * by construction exactly the pick the effect would refuse.
 *
 * Only a session dock has a transport at all; everywhere else every mode is a
 * pure skin change and nothing is ever gated.
 */
export function useViewToggleGate(): ViewToggleGate {
  const currentDock = useCurrentDock();
  const sessionId = currentDock ? sessionIdForDock(currentDock) : null;
  // Held as a TypeId built from the id, so the subscription follows the URL to
  // another session instead of re-subscribing on every cache identity change.
  const typeId = useMemo(
    () => (sessionId ? new TypeId(AgenticProcess.type, sessionId) : null),
    [sessionId],
  );
  const { data: process } = useEntity<AgenticProcess>(typeId);
  return (mode: ViewMode) => surfaceTransportGate(process, mode).blocked;
}
