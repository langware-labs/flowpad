/**
 * Re-export of the SDK hook — see `@sdk/react/hooks/useProject`.
 *
 * The UI once carried its own copy; the two drifted apart and were both loaded
 * into the same bundle. The SDK module is the single implementation.
 */
export { useProject } from '@sdk/react/hooks/useProject';
