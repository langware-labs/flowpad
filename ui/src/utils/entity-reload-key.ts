/**
 * Coerce an entity's `updated_date` into a stable scalar suitable for
 * `useFSRefContent`'s `reloadKey` — so an out-of-band reindex (which bumps
 * `updated_date`) re-reads the file body. Returns undefined when there's no
 * usable timestamp, which disables the reload trigger.
 *
 * Scalar (not the Date object) so it stays referentially stable across the
 * identity-only entity-ref churn that `useEntity`/`useEntityByPath` produce.
 */
export function entityReloadKey(updatedDate: unknown): string | number | undefined {
  if (updatedDate instanceof Date) return updatedDate.getTime();
  if (typeof updatedDate === 'string' || typeof updatedDate === 'number') return updatedDate;
  return undefined;
}
