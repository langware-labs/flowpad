/**
 * Re-export of the SDK hook — see `@sdk/react/hooks/entity-hooks/types`.
 *
 * The UI once carried its own copy; the two drifted apart and were both loaded
 * into the same bundle. The SDK module is the single implementation.
 */
export type { useEntityOptions, UseEntityResult, UseEntitiesQueryResult } from '@sdk/react/hooks/entity-hooks/types';
