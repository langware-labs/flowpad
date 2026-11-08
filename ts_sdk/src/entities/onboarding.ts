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
import type { HubMailboxDescriptor } from './agent';

export type OnboardingChannel = 'email' | 'whatsapp' | 'telegram' | 'slack';
/** `flowpad`: Flowpad's own bot/number/app; `own`: the person's own. */
export type OnboardingMethod = 'flowpad' | 'own';

export interface CreatedAgent {
  project: { id: string; name?: string };
  agent: { id: string; name?: string };
  rel_path: string;
  data_source_id: string | null;
  /** The agent's own mailbox, when it was made on the email channel (its address and who may write). */
  mailbox?: HubMailboxDescriptor | null;
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

function call<R>(
  verb: string,
  type: string | null,
  id: string | null,
  method: HttpMethod,
  body?: object,
  subpath?: string,
): Promise<R> {
  const info = new ActionInfo(verb, type, id, method);
  if (body) info.bodyParameters = body as Record<string, unknown>;
  if (subpath) info.subpath = subpath;
  // Every onboarding call is the hub's: through a desktop (dev mode) it must be forwarded, not answered there.
  info.hubReflect = true;
  return dataManager.callAction<unknown, R>(info);
}

export const Onboarding = {
  /** One line → an agent in the caller's personal project, committed to its repo, with its channel source. */
  createAgent(systemPrompt: string, channel: OnboardingChannel, method: OnboardingMethod): Promise<CreatedAgent> {
    return call('create_agent', 'project', null, 'POST', { system_prompt: systemPrompt, channel, method });
  },

  /** A sandbox of the agent's project with the agent as its main agent; answers once it is up and serving it. */
  deploy(projectId: string, agentId: string): Promise<DeployedAgent> {
    return call('deploy', 'project', projectId, 'POST', { provider: 'e2b', main_agent_id: `agent-${agentId}` });
  },

  /** Set up the agent's channel source on its sandbox (config, who may write, a credential, then verify). */
  channelSetup(nodeTypeid: string, body: ChannelSetupBody): Promise<ChannelSetupResult> {
    return call('channel_setup', 'compute_node', new TypeId(nodeTypeid).id, 'POST', body);
  },

  /** Attach the owner's connection of `provider` to a project (what "use in this project" does). */
  attachConnection(projectId: string, provider: string): Promise<unknown> {
    return call('oauth', 'project', projectId, 'POST', undefined, `${provider}/attach`);
  },

  /** Whether the owner holds a connection of `provider` (checked against a project). */
  async connectionStatus(projectId: string, provider: string): Promise<{ has_token: boolean; is_attached: boolean }> {
    return call('oauth', 'project', projectId, 'GET', undefined, `${provider}/status`);
  },

  /** Start connecting `provider`: the vendor's consent URL to open. */
  async startConnection(provider: string): Promise<string> {
    return (await call<{ auth_url: string }>('oauth', null, null, 'GET', undefined, `${provider}/auth`)).auth_url;
  },

  /** Let this deployment's sandbox use the owner's connection of `provider`. */
  authorize(deploymentId: string, provider: string): Promise<unknown> {
    return call('authorize', 'deployment', deploymentId, 'POST', { provider });
  },
};
