/**
 * First-agent onboarding on the hub page — a typed client for the hub calls one card makes:
 * describe an agent (`project/create_agent`), give it its own sandbox (`agent/<id>/deploy`), set up its
 * channel on that sandbox (`compute_node/<id>/channel_setup`), and let it use the owner's Slack connection
 * (`deployment/<id>/authorize`). Linking a Flowpad bot or an own number goes through `InboundWebhooks.chain`.
 */
import { ActionInfo } from '../models/ActionInfo';
import type { HttpMethod } from '../models/ApiUrl';
import { dataManager } from '../APIEntity';
import { TypeId } from '../models/TypeId';

export type OnboardingChannel = 'whatsapp' | 'telegram' | 'slack';
/** `flowpad`: Flowpad's own bot/number/app; `own`: the person's own. */
export type OnboardingMethod = 'flowpad' | 'own';

export interface CreatedAgent {
  project: { id: string; name?: string };
  agent: { id: string; name?: string };
  rel_path: string;
  data_source_id: string | null;
}

export interface DeployedAgent {
  node_typeid: string;
  healthy?: boolean;
  logged_in?: boolean;
  deployment?: { id: string };
}

export interface ChannelSetupResult {
  ok: boolean;
  results: { call: string; ok: boolean; data?: Record<string, unknown> | null; message?: string }[];
}

export interface ChannelSetupBody {
  source: string;
  config?: Record<string, unknown>;
  access?: { open_to_all?: boolean; allowed_senders?: string[] };
  credential?: { name: string; values: Record<string, string> };
  steps?: { step: string; values?: Record<string, string> }[];
  /** Turn off this sandbox's other sources of the same driver (a polled bot is read by one agent only). */
  exclusive?: boolean;
  verify?: boolean;
  /** Answer the channel's latest messages too (the last result's `data.items`). */
  items?: boolean;
}

function call<R>(verb: string, type: string, id: string | null, method: HttpMethod, body?: object): Promise<R> {
  const info = new ActionInfo(verb, type, id, method);
  if (body) info.bodyParameters = body as Record<string, unknown>;
  return dataManager.callAction<unknown, R>(info);
}

export const Onboarding = {
  /** One line → an agent in the caller's personal project, committed to its repo, with its channel source. */
  createAgent(systemPrompt: string, channel: OnboardingChannel, method: OnboardingMethod): Promise<CreatedAgent> {
    return call('create_agent', 'project', null, 'POST', { system_prompt: systemPrompt, channel, method });
  },

  /** The agent's own sandbox; answers once it is up, signed in and serving the agent. */
  deploy(agentId: string): Promise<DeployedAgent> {
    return call('deploy', 'agent', agentId, 'POST', { provider: 'e2b' });
  },

  /** Set up the agent's channel source on its sandbox (config, who may write, a credential, then verify). */
  channelSetup(nodeTypeid: string, body: ChannelSetupBody): Promise<ChannelSetupResult> {
    return call('channel_setup', 'compute_node', new TypeId(nodeTypeid).id, 'POST', body);
  },

  /** Attach the owner's connection of `provider` to a project (what "use in this project" does). */
  attachConnection(projectId: string, provider: string): Promise<unknown> {
    const info = new ActionInfo('oauth', 'project', projectId, 'POST');
    info.subpath = `${provider}/attach`;
    return dataManager.callAction<unknown, unknown>(info);
  },

  /** Whether the owner holds a connection of `provider` (checked against a project). */
  async connectionStatus(projectId: string, provider: string): Promise<{ has_token: boolean; is_attached: boolean }> {
    const info = new ActionInfo('oauth', 'project', projectId, 'GET');
    info.subpath = `${provider}/status`;
    return dataManager.callAction<unknown, { has_token: boolean; is_attached: boolean }>(info);
  },

  /** Start connecting `provider`: the vendor's consent URL to open. */
  async startConnection(provider: string): Promise<string> {
    const info = new ActionInfo('oauth', null, null, 'GET');
    info.subpath = `${provider}/auth`;
    const data = await dataManager.callAction<unknown, { auth_url: string }>(info);
    return data.auth_url;
  },

  /** Let this deployment's sandbox use the owner's connection of `provider`. */
  authorize(deploymentId: string, provider: string): Promise<unknown> {
    return call('authorize', 'deployment', deploymentId, 'POST', { provider });
  },
};
