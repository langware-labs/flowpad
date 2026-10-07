/**
 * The data sources view's pointer: `[drivers[/<driverName>]]`.
 *
 *   /dock/data-sources                 the configured sources (instances)
 *   /dock/data-sources/drivers         the installed drivers (templates)
 *   /dock/data-sources/drivers/whatsapp one driver's page
 *   /dock/data-sources/<id>[/<tab>]     one configured source's page: messages | events | settings
 *
 * The drivers live UNDER the sources on purpose: a driver is what a source is an
 * instance of, so the address reads `Data sources › Drivers › WhatsApp` and every
 * level is a real, reloadable URL. `foldsPointer` on the registry entry keeps
 * all three in one tab chip. A driver is addressed by its `name` — the registry
 * key, the folder name and the asset id are one noun (see `useSourceSpecs`).
 *
 * No React here: the parser is shared by the view and the address bar.
 */
import { isValidUUIDv4, PageId, ViewType } from '@sdk';
import type { NavigationActions } from '@src/navigation/NavigationActions';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';

export const DRIVERS_SEGMENT = 'drivers';

/** A source page's tabs. What went through the source, what it announced, how it is set up. */
export const SOURCE_TABS = ['messages', 'events', 'settings'] as const;
export type SourceTab = (typeof SOURCE_TABS)[number];

export type DataSourcesRoute =
  | { section: 'sources' }
  | { section: 'drivers'; driver: string | null }
  /** One configured source. `tab` null = its default (Messages for a message source, else Events). */
  | { section: 'source'; id: string; tab: SourceTab | null };

export function dataSourcesPointer(route: DataSourcesRoute = { section: 'sources' }): string | undefined {
  if (route.section === 'sources') return undefined;
  if (route.section === 'source') return route.tab ? `${route.id}/${route.tab}` : route.id;
  return route.driver ? `${DRIVERS_SEGMENT}/${encodeURIComponent(route.driver)}` : DRIVERS_SEGMENT;
}

export function parseDataSourcesPointer(pointer?: string | null): DataSourcesRoute {
  const [head, next] = (pointer ?? '').split('/').filter(Boolean);
  if (head === DRIVERS_SEGMENT) return { section: 'drivers', driver: next ? decodeURIComponent(next) : null };
  // A source is addressed by its id: a uuid can never be `drivers`, and anything else is the list.
  if (head && isValidUUIDv4(head)) {
    const tab = (SOURCE_TABS as readonly string[]).includes(next ?? '') ? (next as SourceTab) : null;
    return { section: 'source', id: head, tab };
  }
  return { section: 'sources' };
}

/** The configured source's own file — `data_source.json` in its asset folder. */
export const SOURCE_FILE = 'data_source.json';

/** Open the drivers list, or one driver's page — both nested under the data sources.
 *  Through `openPage`, not `DockPointer.forDataSources`: DockPointer imports this module. */
export function openDriver(navigation: NavigationActions, driver: string | null = null): void {
  navigation.openPage(PageId.DESK, ViewType.DATA_SOURCES, dataSourcesPointer({ section: 'drivers', driver }));
}

/** Open one configured source's page (a tab of it). Same `openPage` shape as `openDriver`, for the same reason. */
export function openSource(navigation: NavigationActions, id: string, tab: SourceTab | null = null): void {
  navigation.openPage(PageId.DESK, ViewType.DATA_SOURCES, dataSourcesPointer({ section: 'source', id, tab }));
}

/** Open a configured source's `data_source.json` in the editor. False when the row names no folder. */
export function openSourceFile(navigation: NavigationActions, assetRef: string | null | undefined): boolean {
  if (!assetRef) return false;
  navigation.openMachinePath(`${assetRef}/${SOURCE_FILE}`, LOCAL_COMPUTE_NODE);
  return true;
}
