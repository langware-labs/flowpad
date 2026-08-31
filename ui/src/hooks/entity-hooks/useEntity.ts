/**
 * Re-export of the SDK hook — see `@sdk/react/hooks/entity-hooks/useEntity`.
 *
 * The UI copy that used to live here predated two fixes the SDK version
 * carries: an `inputKey` guard that resets state synchronously when the TypeId
 * or query changes (so a stale entity is never exposed for one render during
 * rapid navigation), and a `cancelled` flag checked at every async resume
 * point. Every importer of this path now gets both.
 */
export { useEntity } from '@sdk/react/hooks/entity-hooks/useEntity';
