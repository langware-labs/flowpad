import { useEffect } from 'react';
import { useLingui } from '@lingui/react/macro';
import { notify, registerCommand } from '@src/notifications';
import { closeShown } from '@src/notifications/notify';
import { getUpdateReadyApi } from './update-ready';

export const UPDATE_READY_TOAST_ID = 'update-ready';
/** Shown for 30 seconds unless the user acts; the 90-minute reminder (main.js) shows it again while pending. */
export const UPDATE_READY_TOAST_MS = 30_000;

// Restart: applies the ready set (main.js update-activate). Later: only closes the toast — the update stays ready,
// the indicator keeps offering it and the reminder comes back; X and the timeout do the same.
registerCommand('update.restart', (_args, ctx) => {
  closeShown(ctx.id);
  void getUpdateReadyApi()?.activateUpdate?.();
});
registerCommand('update.later', (_args, ctx) => closeShown(ctx.id));

/**
 * The desktop's "Update Ready" toast — a system-status toast, not a conversation notification: main.js asks for it
 * when an update set becomes ready and on each 90-minute reminder, and never two at a time (one id replaces the
 * other). Mounted once; renders nothing.
 */
export function UpdateReadyBridge() {
  const { t } = useLingui();
  useEffect(() => {
    const api = getUpdateReadyApi();
    return api?.onUpdateReadyToast?.(() => {
      notify.info({
        id: UPDATE_READY_TOAST_ID,
        title: t`Update Ready`,
        message: t`A new FlowPad update has been downloaded and is ready to install.`,
        icon: 'Download',
        durationMs: UPDATE_READY_TOAST_MS,
        actions: [
          { label: t`Restart`, command: 'update.restart' },
          { label: t`Later`, command: 'update.later' },
        ],
      });
    });
  }, [t]);
  return null;
}
