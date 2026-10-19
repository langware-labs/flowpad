import apiClient from '@sdk/client';
import { isHubOnly, launchSurfaceField } from '@sdk';
import { prepareAgentSession } from '@src/components/agents/use-agent-launcher';
import { stashAgentAutoLaunchWarning } from './agent-auto-launch-warning';

/** Enables auto-launch on project entry and after a successful pull. */
export const AGENT_AUTO_LAUNCH_ENABLED = true;

/** `POST /api/v1/agents/auto-launch` — `AutoLaunchOutcome.to_payload()` or nulls. */
export interface AgentAutoLaunchResponse {
  agent_id: string | null;
  agent_title?: string | null;
  process_id: string | null;
  process_typeid: string | null;
  cancelled: { agent_id: string; title: string }[];
  /** Set when the backend tried and failed; the id fields are null alongside it. */
  error?: string;
}

export const AGENT_AUTO_LAUNCH_ENDPOINT = '/api/v1/agents/auto-launch';

/** Projects whose auto-launch answer this session was "nothing to enter". */
const settledProjects = new Set<string>();

export function resetAgentAutoLaunchForTests(): void {
  settledProjects.clear();
}

/** The backend selects once; both project entry and a completed pull open its answer. */
export async function prepareProjectAutoLaunch(projectId: string, refresh = false): Promise<string | null> {
  if (!AGENT_AUTO_LAUNCH_ENABLED || isHubOnly()) return null;
  // A pull changed the project sources, so an earlier empty answer is obsolete.
  if (refresh) settledProjects.delete(projectId);
  // The backend launches once per project; once it answered "nothing to enter"
  // for this project, asking again on every landing only holds the URL on a POST
  // (dock-loading I4). A reload asks again.
  if (settledProjects.has(projectId)) return null;

  let data: AgentAutoLaunchResponse;
  try {
    data = await apiClient.post<AgentAutoLaunchResponse>(AGENT_AUTO_LAUNCH_ENDPOINT, {
      project_id: projectId,
      ...launchSurfaceField(),
    });
  } catch (e) {
    console.warn('[agent-auto-launch] backend call failed; no auto-launch', e);
    return null;
  }
  if (!data?.process_id && !data?.error) settledProjects.add(projectId);
  // A refused launch arrives IN the payload, never as a rejection (see the
  // route). Unreported, it looks exactly like a project with no agent.
  if (data?.error) {
    console.warn('[agent-auto-launch] backend refused the launch', data.error);
    stashAgentAutoLaunchWarning({ winner: '', cancelled: [], error: data.error });
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
    // The auto prompt is already queued server-side; prepareAgentSession embeds
    // the persona stack and then kicks the queue that runs it.
    await prepareAgentSession(data.process_id);
  } catch (e) {
    console.warn('[agent-auto-launch] pre-turn setup failed; opening the session anyway', e);
  }

  return data.process_id;
}
