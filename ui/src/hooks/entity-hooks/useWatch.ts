/**
 * Re-export of the SDK hook — see `@sdk/react/hooks/entity-hooks/useWatch`.
 *
 * The UI once carried its own copy; the two drifted apart and were both loaded
 * into the same bundle. The SDK module is the single implementation.
 */
export { useWatch } from '@sdk/react/hooks/entity-hooks/useWatch';
