import { useCallback, useState } from 'react';
import { useLingui } from '@lingui/react/macro';
import { Agent, AgenticProcess } from '@sdk';

import { notify } from '@src/notifications';
import { ViewMode } from '@src/contexts/view-mode-context';
import { useDockNavigation } from '@src/navigation/useDockNavigation';
import { embedVibeSubagent } from '@src/pages/flow-page/use-start-vibe-session';

/**
 * Launch an agent: open a NEW session as it, in Vibe mode, starting with the
 * agent's auto prompt when it has one.
 *
 *   agent.use()  →  the process (built from the agent's deployment: worker,
 *                   model, permissions, system prompt, dirs, deployment_id),
 *                   with the auto prompt queued (`autoPrompt`)
 *   prepare      →  the vibe SubAgent persona layered UNDER the agent, so the
 *                   vibe pane's `flow show` / mcp-ui contract still applies —
 *                   the agent stays the principal, vibe stays the display
 *                   contract (same call every vibe start path makes) — then
 *                   the queue kick that runs the auto prompt as turn 1. Awaited
 *                   BEFORE the pane opens, so turn 1 is already running.
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
/**
 * Resolve a freshly `use()`d process, make it ready for turn 1, and start it:
 * watch it (watcher-scoped events reach the pane only for a watched process),
 * embed the vibe persona UNDER the agent, then kick the prompt queue — the
 * "session is set up, start" signal that runs the auto prompt `use()` queued.
 * Shared by every opener of an agent session (launcher hook, home page,
 * project auto-launch, deployed panel) so all open with the same stack.
 * Null when the process is not readable — the caller opens it anyway.
 */
export async function prepareAgentSession(processId: string): Promise<AgenticProcess | null> {
  // The queue kick never throws: a refused kick must not read as a failed open.
  const errLog = (e: unknown) => console.warn('[agent-launcher] queue kick failed; auto prompt not started', e);
  const proc = await AgenticProcess.getById<AgenticProcess>(processId);
  if (!proc) {
    console.warn('[agent-launcher] process not readable after use(); vibe persona not embedded', processId);
    // Left queued, the auto prompt would run only after the human's first turn.
    await new AgenticProcess({ id: processId }).drainQueue().catch(errLog);
    return null;
  }
  void proc.watch().catch((e) => console.warn('[agent-launcher] watch failed; live updates degraded', e));
  // A layer, not the persona: the agent's own system prompt is the identity.
  await embedVibeSubagent(proc, { asPersona: false });
  await proc.drainQueue().catch(errLog);
  return proc;
}

/**
 * A NEW session of `agent` acting in `projectId`, ready and started: `use()` with its auto
 * prompt queued, then `prepareAgentSession`. Returns the process id; the caller opens it.
 * For an opener that was asked to START one (the launcher, a launch link) — never a resume.
 */
export async function startAgentSession(agent: Agent, projectId: string | null): Promise<string> {
  const { process_id } = await agent.use(projectId, true);
  await prepareAgentSession(process_id);
  return process_id;
}

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
        const processId = await startAgentSession(agent, projectId ?? null);
        await navigation.openShellProcess(processId, { viewMode: ViewMode.Vibe });
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
