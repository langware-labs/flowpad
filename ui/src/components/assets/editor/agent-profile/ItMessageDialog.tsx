import { useLingui } from '@lingui/react/macro';
import type { Agent } from '@sdk';
import { NewConversationDialog } from '@src/components/new-conversation-dialog/NewConversationDialog';
import { itMessageRequest } from './it-message';

/**
 * "Send IT message": the standard New conversation dialog, its one participant all of this agent's deployments.
 * Send runs the message once on each machine; the answers come back as one IT conversation in the StreamInbox.
 */
export function ItMessageDialog({
  agent,
  open,
  onClose,
  machines,
  off,
}: {
  agent: Agent;
  open: boolean;
  onClose: () => void;
  machines: number;
  /** How many of them report IT Sessions off. */
  off: number;
}) {
  const { t } = useLingui();
  const name = agent.name || t`agent`;
  const stamp = new Date().toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <NewConversationDialog
      open={open}
      onClose={onClose}
      destination={{
        label:
          machines === 1 ? t`IT · ${name} deployments (1 machine)` : t`IT · ${name} deployments (${machines} machines)`,
        note: off > 0 ? (off === 1 ? t`1 has IT Sessions off` : t`${off} have IT Sessions off`) : null,
        title: t`IT · ${name} - ${stamp}`,
        sendLabel: t`Send`,
        send: async ({ text, files }) => {
          const drafts = await Promise.all(
            files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
          );
          const result = await agent.itMessage(itMessageRequest(text, drafts));
          return result.conversation_id || null;
        },
      }}
    />
  );
}
