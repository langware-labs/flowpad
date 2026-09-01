import { MicroApp, QueryRequest, TypeId, kindMatches } from '@sdk';
import { useMemo } from 'react';
import { useEntitiesQuery } from '../entity-hooks';

/** Apps whose `kind` says they edit the asset they are nested inside. */
export const EDITOR_APP_KIND = 'application.web.editor';

/**
 * ONE query for every webapp asset, module-scope so it is byte-identical for
 * every caller.
 *
 * `dataManager.watchQuery` reuses an existing watch for an equivalent request,
 * so N components asking for their own asset's apps collapse to one fetch and
 * one live watch — the same trade `use-source-specs.ts` makes for definitions,
 * and for the same reason: the set is bounded by what is INSTALLED, not by
 * anything ingested. Matching per parent instead would be a query per rendered
 * card, most of them for a menu nobody opens.
 */
const appsQuery = new QueryRequest({
  type: MicroApp.type,
  scope: [],
  name: 'asset-apps',
});

/** Stable while loading — a fresh `[]` per render would change every caller's memo. */
const EMPTY: MicroApp[] = [];

/**
 * The apps an asset ships — its child `micro_app` rows.
 *
 * A webapp nested inside an asset is that asset's child like any other nested
 * asset, so "what apps does this thing have" is a QUERY over containment, not a
 * registry the type has to declare. That is the whole difference from what this
 * replaced: an editor no longer has to be enumerated anywhere to be offered, and
 * dropping one into a folder is enough to make it appear.
 *
 * `kindMatches` rather than a raw prefix test: it NORMALIZES both sides, so a
 * hand-written manifest whose kind differs only in case matches here exactly as
 * it does everywhere else that reads a kind. It is also exact-or-descendant, so
 * `application.web.editor.advanced` still counts as an editor.
 */
export function useAssetApps(parent: TypeId | null | undefined): MicroApp[] {
  const { data: apps = EMPTY } = useEntitiesQuery<MicroApp>(appsQuery);
  const parentKey = parent?.toString() ?? '';
  return useMemo(
    () =>
      parentKey
        ? apps.filter((app) => app.parent_type_id === parentKey && kindMatches(EDITOR_APP_KIND, app.kind ?? ''))
        : EMPTY,
    [apps, parentKey],
  );
}
