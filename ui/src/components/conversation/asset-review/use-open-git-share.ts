import { t } from '@lingui/core/macro';
import { useCallback, useRef, useState } from 'react';
import { dataManager, MessageAttachment, TypeId, type OpenSharedResult } from '@sdk';
import { errorMessage } from '@src/lib/error-message';
import { useDockNavigation } from '@src/navigation';
import { openDisplayTarget } from '@src/navigation/open-display-target';
import { notify, registerCommand } from '@src/notifications';

const REQUEST_GIT_ACCESS = 'share.request-git-access';
const REPORT_SHARE_MISMATCH = 'share.report-mismatch';

// The notice's buttons: send the sharer a structured reply about this attachment.
// Registered on first use, not at import (importers that never open a share stay inert).
let registered = false;
function registerReplyCommands(): void {
  if (registered) return;
  registered = true;
  for (const [command, send] of [
    [REQUEST_GIT_ACCESS, (ma: MessageAttachment) => ma.requestGitAccess()],
    [REPORT_SHARE_MISMATCH, (ma: MessageAttachment) => ma.reportShareMismatch()],
  ] as const) {
    registerCommand(command, async (args, ctx) => {
      const ma = await dataManager.getByTypeId<MessageAttachment>(new TypeId(MessageAttachment.type, String(args.id)));
      if (!ma) return;
      try {
        await send(ma);
        notify.dismiss(ctx.id);
        notify.success({ title: t`Sent to the sharer` });
      } catch (e) {
        notify.error({ title: t`Could not send`, message: errorMessage(e, '') });
      }
    });
  }
}

/** Tell the receiver what the open came to, with the reply they may want to send the sharer. */
function noticeFor(ma: MessageAttachment, res: OpenSharedResult): void {
  const id = String(ma.id);
  if (res.git_share_error || res.mismatch) registerReplyCommands();
  if (res.git_share_error) {
    notify.warning({
      id: `no-git-${id}`,
      // The only word on why the copy opened instead of Git; it stays in the warnings list too.
      forceToast: true,
      // Long enough to act on: the reply is the point of this notice.
      durationMs: 15000,
      title: t`No Git access — opened the copy`,
      message: res.git_share_message ?? res.git_share_error,
      actions: [{ label: t`Request access`, command: REQUEST_GIT_ACCESS, args: { id } }],
    });
  }
  if (res.mismatch) {
    notify.warning({
      id: `mismatch-${id}`,
      forceToast: true,
      durationMs: 15000,
      title: t`This conversation's project is not a checkout of the shared repo`,
      actions: [{ label: t`Tell sender`, command: REPORT_SHARE_MISMATCH, args: { id } }],
    });
  }
}

/** What opening a share came to: opened (maybe from the copy, with why), or a question to ask. */
export interface OpenShareOutcome {
  /** It could not open at all. */
  error?: string;
  /** Ask the receiver: which project (`choice`), or clone vs copy (`placement`). */
  needs?: OpenSharedResult['needs'];
  candidates?: OpenSharedResult['candidates'];
}

/**
 * Open a received share and show it. ONE implementation for the 1-click chip
 * and the review's buttons.
 *
 * - A share that carries Git AND a copy (`both`) goes through `openShared`: the
 *   backend picks the receiver's project, or says what to ask.
 * - A Git-only share installs into the conversation's project (a clone of
 *   theirs at the shared commit is reused), else nowhere in particular.
 */
export function useOpenGitShare(attachment: MessageAttachment | undefined, projectId?: string | null) {
  const { navigation } = useDockNavigation();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const run = useCallback(
    async (opts: { projectId?: string; choice?: 'clone' | 'copy' } = {}): Promise<OpenShareOutcome> => {
      if (!attachment || running.current) return {};
      running.current = true;
      setBusy(true);
      try {
        if (attachment.transfer_mode === 'both') {
          const res = await attachment.openShared(opts);
          if (res.needs) return { needs: res.needs, candidates: res.candidates ?? [] };
          openDisplayTarget(res.show ?? null, navigation);
          noticeFor(attachment, res);
          return {};
        }
        const show = projectId ? await attachment.install('project', projectId) : await attachment.install('user');
        openDisplayTarget(show, navigation);
        return {};
      } catch (e) {
        const reason = errorMessage(e, t`Download failed`);
        notify.error({ title: t`Could not open the shared version`, message: reason });
        return { error: reason };
      } finally {
        running.current = false;
        setBusy(false);
      }
    },
    [attachment, projectId, navigation],
  );

  return { run, busy };
}
