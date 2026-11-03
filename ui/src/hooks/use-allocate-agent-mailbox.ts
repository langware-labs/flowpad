import { type Agent, type AgentMailboxState, type MailboxAllocation } from '@sdk';
import { useLingui } from '@lingui/react/macro';
import { useCallback } from 'react';

import { useCloudLoginGate } from '@src/hooks/use-cloud-login-gate';
import { errorMessage, errorStatus } from '@src/lib/error-message';
import { notify } from '@src/notifications';

/**
 * Give an agent its email address: the cloud allocates the mailbox (idempotent — asking
 * twice never buys twice) and the local source is wired with it. Signs in to the cloud
 * first when needed. Resolves to the mailbox state, or `null` after telling the person why not.
 *
 * The one allocation path for every surface that offers "create an email" — the agent
 * mailbox settings and the add-channel picker — so they cannot drift on the login gate or the error.
 */
export function useAllocateAgentMailbox(): (
  agent: Agent,
  options?: MailboxAllocation,
) => Promise<AgentMailboxState | null> {
  const { t } = useLingui();
  const ensureCloudLogin = useCloudLoginGate();
  return useCallback(
    async (agent: Agent, options: MailboxAllocation = {}) => {
      try {
        const gate = await ensureCloudLogin();
        if (!gate.ok) throw new Error(gate.error);
        return await agent.allocateMailbox(options);
      } catch (error) {
        // `forceToast` because this is a button the person just pressed: an alert-level
        // notification is otherwise filed into the footer popover and never shown outside
        // Dev mode, so the click appeared to do nothing.
        // 503 is the hub's one answer for "the mailbox capability is off" — a fact about that hub, not this
        // request — so it gets the sentence a person can act on, not the hub's own.
        const offered = errorStatus(error) !== 503;
        notify.error({
          title: offered ? t`Could not allocate a mailbox` : t`This hub does not offer agent email`,
          message: offered
            ? errorMessage(error, t`Email settings could not be saved.`)
            : t`Ask whoever runs the hub to turn agent mailboxes on, or use another channel.`,
          forceToast: true,
        });
        return null;
      }
    },
    [ensureCloudLogin, t],
  );
}
