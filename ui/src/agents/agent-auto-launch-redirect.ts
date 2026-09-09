import apiClient from '@sdk/client';
import { dataContext, isHubOnly } from '@sdk';
import { redirect } from 'react-router';

import { DockPointer } from '@src/navigation/DockPointer';
import { ViewMode } from '@src/contexts/view-mode-context';
import { ambientLoadProjectId, registerLoadRedirect } from '@src/routes/loaders/load-redirects';
import { prepareAgentSession } from '@src/components/agents/use-agent-launcher';
import { stashAgentAutoLaunchWarning } from './agent-auto-launch-warning';

/** Registration IS the switch: `false` takes the resolver out of the chain entirely. */
export const AGENT_AUTO_LAUNCH_ENABLED = true;

/** `POST /api/v1/agents/auto-launch` — `AutoLaunchOutcome.to_payload()` or nulls. */
export interface AgentAutoLaunchResponse {
  agent_id: string | null;
  agent_title?: string | null;
  process_id: string | null;
  process_typeid: string | null;
  cancelled: { agent_id: string; title: string }[];
}

export const AGENT_AUTO_LAUNCH_ENDPOINT = '/api/v1/agents/auto-launch';

/**
 * The project agent auto-launch redirect, or null when there is nothing to enter.
 *
 * Same contract as the journey resolver: runs in the dock loaders after the
 * scope project is adopted, never blocks the load (any failure means no
 * auto-launch), and lands the user on the session as real URL state. The
 * backend owns the policy — which agent, once per project, oldest wins — and
 * queues the prompt; this side embeds the vibe persona BEFORE kicking the
 * queue (the order `useAgentLauncher` guarantees), then redirects into Vibe.
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

  let data: AgentAutoLaunchResponse;
  try {
    data = await apiClient.post<AgentAutoLaunchResponse>(AGENT_AUTO_LAUNCH_ENDPOINT, { project_id: projectId });
  } catch (e) {
    console.warn('[agent-auto-launch] backend call failed; no auto-launch', e);
    return null;
  }
  if (data?.cancelled?.length) {
    stashAgentAutoLaunchWarning({
      winner: data.agent_title || data.agent_id || '',
      cancelled: data.cancelled.map((c) => c.title || c.agent_id),
    });
  }
  if (!data?.process_id) return null;

  try {
    const proc = await prepareAgentSession(data.process_id);
    // The prompt is already queued server-side; this is the kick that runs it,
    // now that the persona stack is complete.
    await proc?.drainQueue().catch((e) => console.warn('[agent-auto-launch] drain kick failed', e));
  } catch (e) {
    console.warn('[agent-auto-launch] pre-turn setup failed; opening the session anyway', e);
  }

  const pointer = data.process_typeid || `agentic_process-${data.process_id}`;
  return redirect(DockPointer.forShell(pointer).withViewMode(ViewMode.Vibe).toUrl());
}

// After journeys on purpose: first redirect wins, so an active journey takes the
// load and the agent auto-launch fires on the next open (its once-only mark is
// taken by the backend call, which never happens on a lost race).
if (AGENT_AUTO_LAUNCH_ENABLED) registerLoadRedirect(agentAutoLaunchRedirect);
