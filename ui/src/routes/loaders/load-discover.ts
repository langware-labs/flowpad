import { initSdk } from '@sdk';
import type { LoaderFunctionArgs as LoaderArgs } from 'react-router';
import { DockPointer } from '@src/navigation/DockPointer';
import { adoptScopeProject } from './load-dock-pointer';

/**
 * Loader for `/discover` — a top-level route outside the dock subtree, so
 * none of the dock loaders ever run for it. Every deep link is a hard load,
 * which is exactly the case that used to land on "No project open": the page
 * read `dataContext.project` once on mount and nothing had set it.
 *
 * Two steps, both borrowed from the home loader: make sure the SDK is up, then
 * adopt the project the URL names (`?scope-project=<id>`, the one grammar for
 * "this surface is about project X"). With no scope the active project stays,
 * and a cold start falls back to the default one. Loaders talk through
 * `dataContext`, never `useLoaderData`.
 */
export async function loadDiscover(args: LoaderArgs) {
  await initSdk(args.params);
  const url = new URL(args.request.url);
  const dock = DockPointer.root().withOptionsFromUrl(`${url.pathname}${url.search}`);
  await adoptScopeProject(dock);
  return null;
}
