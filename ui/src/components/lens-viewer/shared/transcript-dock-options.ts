import { DockPointer } from '@src/navigation/DockPointer';
import type { NavigationActions } from '@src/navigation/NavigationActions';

/**
 * Re-encode the transcript ref so absolute paths survive buildDockUrl's
 * per-segment encoding. Without this, an absolute ref like "/var/..." joins
 * with the route as "/dock/lens/<worker>/transcript//var/..." — react-router
 * normalises the embedded "//" away, dropping the leading "/" and silently
 * demoting the path to a relative slug the legacy claude resolver then rewrites
 * under ~/.claude/projects/.
 */
function reencodeTranscriptPointer(pointer: string): string {
  const m = /^([^/]+)\/transcript\/(.*)$/.exec(pointer);
  return m ? `${m[1]}/transcript/${encodeURIComponent(m[2])}` : pointer;
}

/**
 * Push a new DockPointer for the current transcript dock with `patch` merged
 * into its query options (an `undefined` value deletes that key). The URL stays
 * shareable and back/forward-restorable; option keys aren't part of `tabHash`,
 * so no new tab is minted. The single writer for transcript-view URL state
 * (`?transcriptMode`, `?zoom`, …).
 */
export function patchTranscriptDockOptions(
  navigation: NavigationActions,
  currentDock: DockPointer | null | undefined,
  patch: Record<string, string | undefined>,
): void {
  if (!currentDock) return;
  const nextOptions: Record<string, string> = { ...(currentDock.options ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete nextOptions[k];
    else nextOptions[k] = v;
  }
  navigation.openDock(
    new DockPointer(
      currentDock.viewType,
      reencodeTranscriptPointer(currentDock.pointer ?? ''),
      nextOptions,
      currentDock.layout,
    ),
  );
}
