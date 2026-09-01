/**
 * Re-export of the SDK hook — see `@sdk/react/hooks/useAuth`.
 *
 * The SDK version is a strict superset: it also surfaces `currentUser`,
 * `cloudUser` and `localUser` from the shared context snapshot.
 */
export { useAuth } from '@sdk/react/hooks/useAuth';
export type { UseAuthResult } from '@sdk/react/hooks/useAuth';
