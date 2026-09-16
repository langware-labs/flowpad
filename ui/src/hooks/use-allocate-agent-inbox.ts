import { type Agent, type AgentInboxState } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { useCallback } from 'react';

import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

/**
 * Give an agent its email address: the cloud allocates the mailbox (idempotent — asking
 * twice never buys twice) and the local source is wired with it. Signs in to the cloud
 * first when needed. Resolves to the inbox state, or `null` after telling the person why not.
 *
 * The one allocation path for every surface that offers "create an email" — the agent
 * inbox and the add-channel picker — so they cannot drift on the login gate or the error.
 */
export function useAllocateAgentInbox(): (agent: Agent) => Promise<AgentInboxState | null> {
  const { t } = useLingui();
  const ensureCloudLogin = useCloudLoginGate();
  return useCallback(
    async (agent: Agent) => {
      try {
        const gate = await ensureCloudLogin();
        if (!gate.ok) throw new Error(gate.error);
        return await agent.allocateInbox();
      } catch (error) {
        // `forceToast` because this is a button the person just pressed: an alert-level
        // notification is otherwise filed into the footer popover and never shown outside
        // Dev mode, so the click appeared to do nothing.
        notify.error({
          title: t`Could not allocate an inbox`,
          message: errorMessage(error, t`Email settings could not be saved.`),
          forceToast: true,
        });
        return null;
      }
    },
    [ensureCloudLogin, t],
  );
}
