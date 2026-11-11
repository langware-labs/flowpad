import { useEffect } from 'react';
import { useLingui } from '@lingui/react/macro';
import { notify, registerCommand } from '@src/notifications';
import { closeShown } from '@src/notifications/notify';
import { activationFailed, getUpdateReadyApi, openVersionPopover } from './update-ready';

export const UPDATE_READY_TOAST_ID = 'update-ready';
/** Shown for 30 seconds unless the user acts; the 90-minute reminder (main.js) shows it again while pending. */
export const UPDATE_READY_TOAST_MS = 30_000;

// Restart: applies the ready set (main.js update-activate). The toast is closed at once, so when the update does not
// apply (busy, no longer ready, a failed install) the version popover opens and says why. Later: only closes the
// toast — the update stays ready, the indicator keeps offering it and the reminder comes back; X and the timeout
// do the same.
registerCommand('update.restart', (_args, ctx) => {
  closeShown(ctx.id);
  const activate = getUpdateReadyApi()?.activateUpdate;
  if (!activate) return;
  activate().then(
    (activation) => {
      if (activationFailed(activation)) openVersionPopover({ activation });
    },
    (err: unknown) =>
      openVersionPopover({ activation: { started: false, error: err instanceof Error ? err.message : String(err) } }),
  );
});
registerCommand('update.later', (_args, ctx) => closeShown(ctx.id));

/**
 * The desktop's "Update Ready" toast — a system-status toast, not a conversation notification (the CLAUDE.md
 * exception): main.js asks for it when an update set becomes ready and on each 90-minute reminder, and never two at
 * a time (one id replaces the other). A toast asked for while this was still mounting is taken on mount — the
 * desktop hands each one out once. Mounted once; renders nothing.
 */
export function UpdateReadyBridge() {
  const { t } = useLingui();
  useEffect(() => {
    const api = getUpdateReadyApi();
    if (!api?.onUpdateReadyToast) return;
    let live = true;
    const show = () =>
      notify.info({
        id: UPDATE_READY_TOAST_ID,
        title: t`Update Ready`,
        message: t`A new FlowPad update has been downloaded and is ready to install.`,
        icon: 'CircleArrowDown', // a served lucide icon (flow_sdk/server/icons/lucide) — the top-bar pill's glyph
        durationMs: UPDATE_READY_TOAST_MS,
        actions: [
          { label: t`Restart`, command: 'update.restart' },
          { label: t`Later`, command: 'update.later' },
        ],
      });
    const take = () => {
      if (!api.takeUpdateReadyToast) return show(); // a desktop without the hand-off: show what it sent
      api.takeUpdateReadyToast().then(
        (state) => {
          if (live && state) show();
        },
        () => {
          /* the desktop is going away */
        },
      );
    };
    if (api.takeUpdateReadyToast) take(); // one asked for before this listened
    const dispose = api.onUpdateReadyToast(take);
    return () => {
      live = false;
      dispose();
    };
  }, [t]);
  return null;
}
