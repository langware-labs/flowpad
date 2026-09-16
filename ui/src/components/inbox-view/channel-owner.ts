import { Agent, type DataSource, TypeId, User } from '@sdk';

/** The backend's `owner_of` rule (`flow_sdk/inbox/projection.py`), client-side, for a
 *  row written before `owner` existed: the agent its legacy `config.agent_id` names,
 *  else `null` — "the local user's", which the CALLER resolves, so a mount that is
 *  not the local user's never has to know that typeid. */
export function ownerOf(source: Pick<DataSource, 'owner' | 'config'>): string | null {
  if (source.owner) return source.owner;
  const agentId = (source.config as { agent_id?: unknown } | undefined)?.agent_id;
  return typeof agentId === 'string' && agentId ? new TypeId(Agent.type, agentId).toString() : null;
}

/** Whose channels an inbox shows: the agent's on an agent inbox, else the local
 *  user's — `localUser.id`, not the SDK's `userTypeId`, which is the `@local`
 *  pointer while rows carry the user's real id. Null until that id is known. */
export function channelsOwnerFor(agentId: string | undefined, localUserId: string | undefined): TypeId | null {
  if (agentId) return new TypeId(Agent.type, agentId);
  return localUserId ? new TypeId(User.type, localUserId) : null;
}
