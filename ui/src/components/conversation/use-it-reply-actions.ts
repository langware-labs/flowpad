import { useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Agent } from '@sdk';
import type { ItReplyMeta } from '@sdk/entities/agent';
import { errorMessage } from '@src/lib/error-message';
import { notify } from '@src/notifications';

/**
 * What a machine's IT reply offers: "Open machine", and "Enable and run" when it was IT Disabled -- enable it for
 * that one machine, then ask it its send's request again (text, files, answer shape) into the same conversation;
 * the new answer names the same send, so it replaces the machine's line under that request.
 */
export function useItReplyActions(reply: ItReplyMeta, agentId: string, conversationId: string) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  // Built once: constructing an entity registers it in the shared cache.
  const [agent] = useState(() => new Agent({ id: agentId }));

  const turnOnAndRun = async () => {
    setBusy(true);
    try {
      await agent.setItSessions([reply.node_typeid], true);
      await agent.itRerun(conversationId, [reply.node_typeid], reply.send_id ?? null);
    } catch (e) {
      notify.error({ title: t`Could not run it there`, message: errorMessage(e, ''), forceToast: true });
    } finally {
      setBusy(false);
    }
  };

  const openMachine = async () => {
    // Opened in the click, filled after the call: a window opened after an await is eaten by popup blockers.
    const tab = window.open('about:blank', '_blank');
    try {
      const result = await agent.managePublicDeployment(reply.node_typeid, 'open');
      if (result.workspace_url && tab) tab.location.href = result.workspace_url;
      else tab?.close();
    } catch (e) {
      tab?.close();
      notify.error({ title: t`Could not open the machine`, message: errorMessage(e, ''), forceToast: true });
    }
  };

  return { busy, turnOnAndRun, openMachine };
}
