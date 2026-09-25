/**
 * The data sources view's pointer: `[drivers[/<driverName>]]`.
 *
 *   /dock/data-sources                 the configured sources (instances)
 *   /dock/data-sources/drivers         the installed drivers (templates)
 *   /dock/data-sources/drivers/waha    one driver's page
 *
 * The drivers live UNDER the sources on purpose: a driver is what a source is an
 * instance of, so the address reads `Data sources › Drivers › WAHA` and every
 * level is a real, reloadable URL. `foldsPointer` on the registry entry keeps
 * all three in one tab chip. A driver is addressed by its `name` — the registry
 * key, the folder name and the asset id are one noun (see `useSourceSpecs`).
 *
 * No React here: the parser is shared by the view and the address bar.
 */

export const DRIVERS_SEGMENT = 'drivers';

export type DataSourcesRoute =
  | { section: 'sources' }
  | { section: 'drivers'; driver: string | null };

export function dataSourcesPointer(route: DataSourcesRoute = { section: 'sources' }): string | undefined {
  if (route.section === 'sources') return undefined;
  return route.driver ? `${DRIVERS_SEGMENT}/${encodeURIComponent(route.driver)}` : DRIVERS_SEGMENT;
}

export function parseDataSourcesPointer(pointer?: string | null): DataSourcesRoute {
  const [head, driver] = (pointer ?? '').split('/').filter(Boolean);
  if (head !== DRIVERS_SEGMENT) return { section: 'sources' };
  return { section: 'drivers', driver: driver ? decodeURIComponent(driver) : null };
}
