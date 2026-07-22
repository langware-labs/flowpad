import { ContextEntitiesEnum, dataContext, initSdk, isHubOnly, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { redirect, type LoaderFunctionArgs as LoaderArgs } from 'react-router';
import { TimeIt } from '@src/utils/timeit';
import { JOURNEY_PARAM } from '@src/navigation/DockPointer';

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

/**
 * The `auto_launch` journey redirect, or null when there's nothing to enter.
 *
 * Skipped entirely when the URL already carries a journey, and never blocks the
 * load — any failure here just means no auto-launch. A journey the user already
 * completed is not re-entered.
 */
async function autoLaunchRedirect(request: Request): Promise<Response | null> {
  try {
    const url = new URL(request.url);
    if (url.searchParams.get(JOURNEY_PARAM)) return null; // already showing one

    // One server-side call: the backend picks the auto_launch journey and skips
    // one the user already completed.
    const { journey_id: journeyId } = await apiClient.get<{ journey_id: string | null }>(
      '/api/v1/journeys/auto-launch',
    );
    if (!journeyId) return null;

    url.searchParams.set(JOURNEY_PARAM, journeyId);
    return redirect(`${url.pathname}${url.search}`);
  } catch (e) {
    console.debug('[Journey] auto-launch check skipped', e);
    return null;
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

  // Auto-launch: a journey flagged `auto_launch` is entered on project load by
  // REDIRECTING to `?journeyId=` — done here, at load time, so the journey is a
  // real URL state (reload/back safe) rather than a post-render navigation hijack.
  const autoLaunch = await autoLaunchRedirect(args.request);
  t.time('journeyAutoLaunch');
  if (autoLaunch) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw autoLaunch;
  }

  t.done(1.2); // warn if total > 1200ms

  // Project setup is handled by initSdk -> initContext -> setupProject
  // If no projects exist, user will be shown project setup screen
}
