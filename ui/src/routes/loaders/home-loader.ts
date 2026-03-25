import { ContextEntitiesEnum, dataContext, initSdk, TypeId } from '@sdk';
import type { LoaderFunctionArgs as LoaderArgs } from 'react-router';
import { TimeIt } from '@src/utils/timeit';

/**
 * Ensure compute node is loaded for the current project
 * Project setup is handled by initSdk -> initContext -> setupProject
 */
async function ensureComputeNodeLoaded(): Promise<void> {
  if (dataContext.project && !dataContext.computeNode) {
    await dataContext.refreshProject();
  }

  if (!dataContext.computeNode) {
    const bootstrapNode = dataContext.bootstrapInfo?.default_compute_node;
    if (bootstrapNode?.id && bootstrapNode?.type) {
      await dataContext.setContextEntityTypeId(
        ContextEntitiesEnum.CurrentComputeNodeTypeId,
        new TypeId(bootstrapNode.type, bootstrapNode.id),
      );
    }
  }
}

export async function loadHomePage(args: LoaderArgs) {
  const { params } = args;
  const t = new TimeIt('Home load');

  await initSdk(params);
  t.time('initSdk');

  // Check if service is unavailable - throw error so ErrorBoundary catches it
  if (
    dataContext.bootstrapError &&
    (dataContext.bootstrapError as { isServiceUnavailable?: boolean })?.isServiceUnavailable
  ) {
    throw new Error(dataContext.bootstrapError.message || 'Service unavailable');
  }

  await ensureComputeNodeLoaded();
  t.time('ensureComputeNode');

  t.done(0.5); // warn if total > 500ms

  // Project setup is handled by initSdk -> initContext -> setupProject
  // If no projects exist, user will be shown project setup screen
}
