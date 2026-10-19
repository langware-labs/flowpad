import { dataContext, isHubOnly } from '@sdk';
import { redirect } from 'react-router';

import { DockPointer } from '@src/navigation/DockPointer';
import { ViewMode } from '@src/contexts/view-mode-context';
import { ambientLoadProjectId, registerLoadRedirect } from '@src/routes/loaders/load-redirects';
import { AGENT_AUTO_LAUNCH_ENABLED, prepareProjectAutoLaunch } from './agent-auto-launch';

export {
  AGENT_AUTO_LAUNCH_ENABLED,
  AGENT_AUTO_LAUNCH_ENDPOINT,
  prepareProjectAutoLaunch,
  resetAgentAutoLaunchForTests,
} from './agent-auto-launch';
export type { AgentAutoLaunchResponse } from './agent-auto-launch';

/**
 * The project agent auto-launch redirect, or null when there is nothing to enter.
 *
 * Same contract as the journey resolver: runs in the dock loaders after the
 * scope project is adopted, never blocks the load (any failure means no
 * auto-launch), and lands the user on the session as real URL state. The
 * backend owns the policy — which agent, once per project, oldest wins — and
 * queues the auto prompt (as `Agent.use` does for every opted-in session);
 * this side runs `prepareAgentSession`, which embeds the vibe persona BEFORE
 * kicking the queue, then redirects into Vibe.
 */
export async function agentAutoLaunchRedirect(request: Request): Promise<Response | null> {
  if (isHubOnly()) return null;
  const scoped = ambientLoadProjectId(request);
  if (scoped === undefined) return null; // deep link / Hub / inside a session
  // `/` and non-dock routes: the adopted default project — this is how a
  // sandbox's workspace tab, which opens at the root, finds the project the
  // Hub just provisioned.
  const projectId = scoped ?? dataContext.project?.id ?? null;
  if (!projectId) return null;
  const processId = await prepareProjectAutoLaunch(projectId);
  return processId
    ? redirect(DockPointer.forShell(`agentic_process-${processId}`).withViewMode(ViewMode.Vibe).toUrl())
    : null;
}

// After journeys on purpose: first redirect wins, so an active journey takes the
// load and the agent auto-launch fires on the next open (its once-only mark is
// taken by the backend call, which never happens on a lost race).
if (AGENT_AUTO_LAUNCH_ENABLED) registerLoadRedirect(agentAutoLaunchRedirect);
