import { t } from '@lingui/core/macro';
import { Agent, dataContext, dataManager, TypeId } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { DockLoadError } from './dock-load-error';

/** Resolve only route identity. Polling and Hub email state belong to the mounted view. */
export async function loadAgentStreamInboxRoute(pointer: string | undefined): Promise<void> {
  const { agentId, view } = DockPointer.parseAgentPointer(pointer);
  if (!agentId || view !== 'stream_inbox') {
    throw new DockLoadError(
      'malformed_agent_stream_inbox_pointer',
      'hard',
      { action: 'render_error', title: t`Agent stream inbox not found`, message: t`This Agent stream inbox URL is malformed.` },
      'agent',
    );
  }
  let typeId: TypeId;
  try {
    typeId = new TypeId(Agent.type, agentId);
  } catch (error) {
    throw new DockLoadError(
      'malformed_agent_stream_inbox_pointer',
      'hard',
      { action: 'render_error', title: t`Agent stream inbox not found`, message: t`This Agent stream inbox URL is malformed.` },
      'agent',
      error,
    );
  }
  const agent = await dataManager.getByTypeId<Agent>(typeId).catch(() => null);
  if (!agent) {
    throw new DockLoadError(
      'agent_not_found',
      'hard',
      { action: 'render_error', title: t`Agent not found`, message: t`This Agent no longer exists.` },
      'agent',
    );
  }
  await dataContext.setActiveEntityTypeId(typeId);
}
