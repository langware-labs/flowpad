import { useEffect, useMemo, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import type { Agent } from '@sdk';
import type { ItOperation } from '@sdk/entities/agent';
import { NewConversationDialog } from '@src/components/new-conversation-dialog/NewConversationDialog';
import { formatTimeAgo } from '@src/utils/format-time-ago';
import { itMessageRequestOf, opIdOf } from './it-message';

/**
 * "Send IT message": the standard New conversation dialog, its one participant all of this agent's deployments.
 * The title is the OPERATION: every send under one name lands in that operation's one IT conversation, the
 * machines' answers drawn as a table under each send. The agent's operations are offered to continue one.
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
  /** How many of them are IT Disabled. */
  off: number;
}) {
  const { t } = useLingui();
  const name = agent.name || t`agent`;
  const [operations, setOperations] = useState<ItOperation[]>([]);
  useEffect(() => {
    if (!open) return;
    let live = true;
    // A hub without operations answers nothing to offer; the dialog still sends.
    void agent
      .itOperations()
      // Only a NAMED operation can be continued by its name; a send from before operations is a thread of its own.
      .then((ops) => live && setOperations(ops.filter((o) => o.op_id === opIdOf(o.name))))
      .catch(() => live && setOperations([]));
    return () => {
      live = false;
    };
  }, [agent, open]);

  const stamp = new Date().toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const byId = useMemo(() => new Map(operations.map((o) => [o.op_id, o])), [operations]);
  const known = (title: string) => byId.get(opIdOf(title)) ?? null;
  return (
    <NewConversationDialog
      open={open}
      onClose={onClose}
      destination={{
        label:
          machines === 1 ? t`IT · ${name} deployments (1 machine)` : t`IT · ${name} deployments (${machines} machines)`,
        note: off > 0 ? (off === 1 ? t`1 is IT Disabled` : t`${off} are IT Disabled`) : null,
        title: t`IT · ${name} - ${stamp}`,
        titleLabel: t`Operation`,
        titleSuggestions: operations.map((o) => ({
          name: o.name,
          meta:
            o.message_count === 1
              ? t`1 message · ${formatTimeAgo(o.last_message_at) ?? ''}`
              : t`${o.message_count} messages · ${formatTimeAgo(o.last_message_at) ?? ''}`,
        })),
        titleHint: (title) => {
          if (!opIdOf(title)) return t`Name the operation with at least one letter or digit.`;
          const op = known(title);
          return op
            ? t`Continues the operation ${op.name}: your message and the answers are added to its conversation.`
            : t`A new operation. Everything you send under this name, and every machine's answer, lands in one conversation.`;
        },
        sendLabel: t`Send`,
        send: async ({ title, text, files }) => {
          const result = await agent.itMessage({ ...(await itMessageRequestOf(text, files)), op: title });
          return result.conversation_id || null;
        },
      }}
    />
  );
}
