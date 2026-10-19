import { t } from '@lingui/core/macro';
import { useCallback, useRef, useState } from 'react';
import type { MessageAttachment } from '@sdk';
import { errorMessage } from '@src/lib/error-message';
import { useDockNavigation } from '@src/navigation';
import { openDisplayTarget } from '@src/navigation/open-display-target';
import { notify } from '@src/notifications';

/**
 * Open a received git share: install it (a pointer — it never touches the
 * receiver's own checkout) and show it. Into the conversation's project when it
 * has one, so a clone of theirs at the shared commit is reused; else nowhere in
 * particular. ONE implementation for the 1-click chip and the review's Download.
 *
 * `run` resolves to an error message when it failed (and says so in a toast),
 * else `null`.
 */
export function useOpenGitShare(attachment: MessageAttachment | undefined, projectId?: string | null) {
  const { navigation } = useDockNavigation();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const run = useCallback(async (): Promise<string | null> => {
    if (!attachment || running.current) return null;
    running.current = true;
    setBusy(true);
    try {
      const show = projectId ? await attachment.install('project', projectId) : await attachment.install('user');
      openDisplayTarget(show, navigation);
      return null;
    } catch (e) {
      const reason = errorMessage(e, t`Download failed`);
      notify.error({ title: t`Could not open the shared version`, message: reason });
      return reason;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, [attachment, projectId, navigation]);

  return { run, busy };
}
