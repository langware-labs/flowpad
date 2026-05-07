import { ContextEntitiesEnum, dataContext, TypeId } from '@sdk';
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

export async function loadHomePage(_args: LoaderArgs) {
  const t = new TimeIt('Home load');

  // SDK init + bootstrap-error gating now happen in the root loader
  // (`./root-loader.ts`).
  await ensureComputeNodeLoaded();
  t.time('ensureComputeNode');

  t.done(0.5); // warn if total > 500ms

  // Project setup is handled by initSdk -> initContext -> setupProject
  // If no projects exist, user will be shown project setup screen
}
