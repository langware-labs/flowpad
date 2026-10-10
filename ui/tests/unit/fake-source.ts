/**
 * A real `DataSource` for a channel test — real, so the status getters under test
 * (`needsSetup`, `isParked`, `isHeld`, …) are the SDK's own.
 */
import { DataSource } from '@sdk';

export const LOCAL_OWNER = 'user-11111111-1111-4111-8111-111111111111';

/** One source named `name` on `provider` (its channel too), active unless `fields` says otherwise.
 *  The id comes from the name's first letter, so give sources in one test distinct initials. */
export function fakeSource(name: string, provider: string, fields: Partial<Record<keyof DataSource, unknown>> = {}) {
  const id = `${name.charCodeAt(0).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
  return new DataSource({ id, name, provider, channel: provider, owner: LOCAL_OWNER, status: 'active', ...fields } as never);
}
