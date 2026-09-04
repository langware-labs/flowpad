import { ContextEntitiesEnum, dataContext, initSdk, isHubOnly, TypeId } from '@sdk';
import { redirect, replace, type LoaderFunctionArgs as LoaderArgs } from 'react-router';
import { TimeIt } from '@src/utils/timeit';
import { adoptScopeProject } from './load-dock-pointer';
import { DockPointer } from '@src/navigation/DockPointer';
import { getViewMode } from '@src/contexts/view-mode-context';
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

  const url = new URL(args.request.url);
  const dock = DockPointer.root().withOptionsFromUrl(`${url.pathname}${url.search}`);

  // `/` arrives bare on every cold load — the browser loads the URL directly, so
  // `openDock`'s viewMode stamping never runs for it. Canonicalize it here so the
  // FIRST history entry states its mode like every other one; otherwise Back onto
  // it re-resolves through the (mutable) preference and renders whatever mode is
  // current, making the step invisible.
  //
  // `replace`, NOT `redirect`: a redirect on the INITIAL document load pushes,
  // which would leave the bare `/` sitting behind home as an entry that re-runs
  // this loader and redirects forward again — the classic redirect trap, i.e.
  // another Back step that does nothing. Measured: with `redirect` the cold load
  // landed at idx=1; with `replace` it lands at idx=0.
  //
  // FIRST, before any awaited work: this throw discards the rest of the pass and
  // the router re-runs the whole matched loader tree on the canonical URL. It
  // fires on every bare cold start, so anything done above it is paid for twice
  // and thrown away once.
  if (dock.viewMode === null) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw replace(dock.withViewMode(getViewMode()).toUrl(url.pathname));
  }

  await ensureComputeNodeLoaded();
  t.time('ensureComputeNode');

  // `/?scope-…` means what `/dock/home?scope-…` meant: the root is an ordinary
  // location now, so a scoped home has to adopt its project like any other
  // scoped dock. Together with the viewMode canonicalization above, these are the
  // only two steps the home loader borrows from the dock loader — the rest (tab
  // setup, the other canonicalizers, page redirects) stays out deliberately,
  // because `/` is every cold start and this is the boot path.
  await adoptScopeProject(dock);
  t.time('adoptScope');

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
