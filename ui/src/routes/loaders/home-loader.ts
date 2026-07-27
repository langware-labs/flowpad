import { ContextEntitiesEnum, dataContext, initSdk, isHubOnly, TypeId } from '@sdk';
import { redirect, type LoaderFunctionArgs as LoaderArgs } from 'react-router';
import { TimeIt } from '@src/utils/timeit';
import { runLoadRedirects } from './load-redirects';
// Side-effect import: features register their load-redirect resolvers here.
import '@src/journey/journey-load-redirect';

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

  // React Router runs root + child loaders in parallel; this idempotent
  // re-await on the memoised `initPromise` (see ts_sdk/src/main.ts:25-30)
  // guarantees schemas are registered before any entity construction in
  // the home view. Cheap on warm calls, the actual gate on cold load.
  await initSdk(params);
  t.time('initSdk');

  // Hub page has no desktop home. When the served backend serves only the hub
  // (no `desk`), the index route lands on the hub home instead of HomeLanding.
  if (isHubOnly()) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw redirect('/dock/hub/home');
  }

  await ensureComputeNodeLoaded();
  t.time('ensureComputeNode');

  // Feature load-redirects (journey auto-launch et al) — done here, at load
  // time, so the destination is real URL state (reload/back safe) rather than
  // a post-render navigation hijack. The loader stays feature-agnostic:
  // features register resolvers from their own modules.
  const loadRedirect = await runLoadRedirects(args.request);
  t.time('loadRedirects');
  if (loadRedirect) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw loadRedirect;
  }

  t.done(1.2); // warn if total > 1200ms

  // Project setup is handled by initSdk -> initContext -> setupProject
  // If no projects exist, user will be shown project setup screen
}
