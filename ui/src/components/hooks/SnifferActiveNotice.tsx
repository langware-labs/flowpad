import { useEffect } from 'react';
import { SNIFFER_ACTIVE_WARNING } from '@sdk';
import { useContext } from '@sdk/react/hooks';
import { notify } from '@src/notifications';

/**
 * Startup notice for a live hook sniffer.
 *
 * The sniffer writes catch-all hooks into the harness settings file, so every
 * coding-agent session on the machine reports to Flowpad — and it stays that
 * way across restarts, including hooks installed by a different instance. That
 * is worth saying out loud, with a one-click way out.
 *
 * Copy, id and disable command are shared with the warnings-popover entry
 * (`SNIFFER_ACTIVE_WARNING`); this only makes sure the user sees it without
 * opening anything. `notify` dedupes on id, so re-emitting is inert.
 */
export function SnifferActiveNotice() {
  const { isBootstrapping, snifferInstalled } = useContext();

  useEffect(() => {
    if (isBootstrapping) return;
    if (!snifferInstalled) {
      notify.dismiss(SNIFFER_ACTIVE_WARNING.id);
      return;
    }
    notify.warning({
      id: SNIFFER_ACTIVE_WARNING.id,
      title: SNIFFER_ACTIVE_WARNING.message,
      message: SNIFFER_ACTIVE_WARNING.description,
      icon: SNIFFER_ACTIVE_WARNING.icon,
      durationMs: null,
      actions: [{ label: 'Disable', command: 'sniffer.disable' }],
    });
  }, [isBootstrapping, snifferInstalled]);

  return null;
}
