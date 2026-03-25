import { NotFoundError } from '@src/errors/NotFoundError';
import {
  dataContext,
  Flow,
  FlowAccessDeniedError,
  FlowAuthenticationError,
  FlowNotFoundError,
  navigator,
  TypeId,
} from '@sdk';
import { DockPointer, buildDockUrl } from '@src/navigation';

type LoaderArgs = {
  params: { agentId?: string; processId?: string };
};

export async function loadFlowFromParams(args: LoaderArgs): Promise<Flow> {
  const { params } = args;
  const { processId } = params;
  console.log('[FLOW_LOADER] loadFlowFromParams called with processId:', processId);

  if (!processId) {
    throw new NotFoundError('Flow ID is missing');
  }

  const flowTypeId = new TypeId(Flow.type, processId);

  try {
    console.log('[FLOW_LOADER] Calling dataContext.loadFlow');
    return await dataContext.loadFlow(flowTypeId);
  } catch (error) {
    console.log('[FLOW_LOADER] Error caught:', error);

    if (error instanceof FlowNotFoundError) {
      console.error('[FLOW_LOADER] Flow not found:', error);
      throw new NotFoundError('Flow not found');
    }

    if (error instanceof FlowAccessDeniedError) {
      console.error('[FLOW_LOADER] Flow not found or access denied:', error);
      throw new NotFoundError('Flow not found or access denied');
    }

    if (error instanceof FlowAuthenticationError) {
      console.log('[FLOW_LOADER] FlowAuthenticationError - REDIRECTING TO LOGIN');
      navigator.navigateToLogin();
      return new Promise(() => {});
    }

    if (error && typeof error === 'object' && 'status' in error && error.status === 302) {
      console.log('[FLOW_LOADER] 302 redirect error, rethrowing');
      throw error;
    }

    console.error('[FLOW_LOADER] Unknown error loading flow:', error);
    throw new NotFoundError('Error loading flow');
  }
}

export function getBrokenViewUrl(args: LoaderArgs): string {
  const defaultPointer = new DockPointer();
  const { params } = args;
  const { agentId, processId } = params;
  const { viewType: defaultViewType, pointer: defaultPointerValue } = defaultPointer.toUrlSegments();
  const searchParams = defaultPointer.toSearchParams();

  // Build the current URL path with agent and flow IDs
  const currentUrl = `/agent/${agentId}/flow/${processId}`;

  const redirectUrl = buildDockUrl(
    currentUrl,
    defaultViewType,
    defaultPointerValue,
    Object.fromEntries(searchParams.entries()),
  );
  return redirectUrl;
}
