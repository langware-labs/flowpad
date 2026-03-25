import { ViewType } from '@src/types/ViewType';
import { redirect } from 'react-router';
import { NotFoundError } from '@src/errors/NotFoundError';
import { loadFlowFromParams } from './loaders';

// Get allowed view types from the ViewType enum
const ALLOWED_VIEWS = new Set(Object.values(ViewType));

type LoaderArgs = {
  params: { agentId?: string; processId?: string; viewType?: string };
};

export async function validateDockLoader(args: LoaderArgs) {
  const { params } = args;
  const { agentId, processId, viewType } = params;

  if (!agentId || !processId) throw new NotFoundError('Agent ID or Flow ID is missing');

  const v = String(viewType ?? '').toLowerCase();
  if (!ALLOWED_VIEWS.has(v as ViewType)) {
    // Redirect back to the flow root when view type is invalid
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect(`/agent/${agentId}/flow/${processId}`);
  }

  // Load the flow to ensure it exists and is ready
  await loadFlowFromParams(args);

  // If you need to expose anything to the route component, return it here.
  // Otherwise null is fine; the presence of a redirect is the main behavior.
  return null;
}
