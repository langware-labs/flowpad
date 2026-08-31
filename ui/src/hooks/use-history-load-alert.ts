import type { AgenticProcess } from '@sdk';
import { notify } from '@src/notifications';
import { useLingui } from '@lingui/react/macro';
import { useEffect } from 'react';

/**
 * Raise a user-visible alert when a process's history fails to load.
 *
 * `loadHistory()` deliberately swallows its own failure so a bad transcript
 * cannot break the app — but the whole replay is ingested in one loop, so a
 * single malformed row leaves the stream EMPTY. The pane then looks identical
 * to a session with nothing in it, and the user is given no reason to reload,
 * report it, or even suspect their conversation is still on disk.
 *
 * `loadHistory` RESOLVES in that case, so the callers' `.catch()` handlers
 * never run; the SDK announces it as a `history-error` event instead and this
 * hook is what turns it into a popup.
 *
 * `forceToast` is the documented case, not decoration: without it the alert is
 * Dev-mode-only, and in every other mode an emptied chat would stay exactly as
 * silent as it is today.
 *
 * Safe to mount from more than one surface — `notify` dedupes on `id`, so the
 * chat pane and the vibe workspace observing the same process replace one
 * another's toast rather than stacking two.
 */
export function useHistoryLoadAlert(process: AgenticProcess | null | undefined): void {
  const { t } = useLingui();

  useEffect(() => {
    // Mounted from `useAgenticProcessStream`, which is a pure stream reader and
    // has always accepted a duck-typed `{ flowDataStream }` — the render-budget
    // tests drive it that way. Such a stand-in cannot emit, so subscribing to it
    // threw `process.on is not a function` and took the whole render down. A real
    // AgenticProcess always can: `on` comes from APIEntity. So this guard only
    // ever skips objects that have no events to give, never a live process.
    if (typeof process?.on !== 'function') return;

    const onHistoryError = ({ error }: { error: unknown }) => {
      const detail = error instanceof Error ? error.message : String(error);
      notify.error({
        // Keyed by process so two open sessions failing don't overwrite each
        // other, and so repeated retries on ONE session collapse to one toast.
        id: `history-error:${process.id}`,
        title: t`Chat history failed to load`,
        message: t`This conversation is still saved, but part of it could not be read, so the chat is showing empty. Reloading may help. Details: ${detail}`,
        forceToast: true,
      });
    };

    return process.on('history-error', onHistoryError);
  }, [process?.id, t]);
}
