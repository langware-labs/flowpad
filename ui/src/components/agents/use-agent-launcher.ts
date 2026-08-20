import { useCallback, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Agent, AgenticProcess } from '@sdk';

import { notify } from '@src/notifications';
import { ViewMode } from '@src/contexts/view-mode-context';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { embedVibeSubagent } from '@src/pages/flow-page/use-start-vibe-session';

/**
 * Launch an agent: open a NEW session as it, in Vibe mode, and let the human
 * type the first message.
 *
 *   agent.use()  →  the process (built from the agent's deployment: worker,
 *                   model, permissions, system prompt, dirs, deployment_id)
 *   embed vibe   →  the vibe SubAgent persona layered UNDER the agent, so the
 *                   vibe pane's `flow show` / mcp-ui contract still applies —
 *                   the agent stays the principal, vibe stays the display
 *                   contract (same call every vibe start path makes). Awaited
 *                   BEFORE the pane opens: here the human types turn 1, so
 *                   nothing else stands between "open" and "first prompt".
 *   open         →  the vibe workspace for that process
 *
 * No prompt dialog: using an agent is starting a conversation with it. Every
 * call mints a fresh session — there is deliberately no reuse key, so clicking
 * an agent twice gives two conversations, the way "New chat" does.
 *
 * The agent is a PARAMETER, not a closure: a list of agent tiles needs one
 * controller for the whole list rather than a hook per row, so `busy` is the
 * id of the agent being launched (the shape `VibeAgentsCard` already uses).
 */
export function useAgentLauncher(): {
  launch: (agent: Agent, projectId?: string | null) => Promise<void>;
  busyId: string | null;
} {
  const { t } = useLingui();
  const { navigation } = useDockNavigation();
  const [busyId, setBusyId] = useState<string | null>(null);

  const launch = useCallback(
    async (agent: Agent, projectId?: string | null) => {
      setBusyId(agent.id);
      try {
        const result = await agent.use(projectId ?? null);
        const proc = await AgenticProcess.getById<AgenticProcess>(result.process_id);
        if (proc) {
          // Watcher-scoped events (status, turns) reach the pane only for a
          // watched process — same as every other vibe start path.
          void proc.watch().catch((e) => console.warn('[agent-launcher] watch failed; live updates degraded', e));
          await embedVibeSubagent(proc);
        } else {
          console.warn(
            '[agent-launcher] process not readable after use(); vibe persona not embedded',
            result.process_id,
          );
        }
        await navigation.openShellProcess(result.process_id, { viewMode: ViewMode.Vibe });
      } catch (e) {
        notify.error({
          title: t`Could not use ${agent.displayName}`,
          message: e instanceof Error ? e.message : t`Starting the session failed.`,
        });
      } finally {
        setBusyId(null);
      }
    },
    [navigation, t],
  );

  return { launch, busyId };
}
