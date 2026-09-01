import { AuthError, TypeId, User } from '@sdk';
import { useContext } from './useContext';

export interface UseAuthResult {
  /** Local desktop user — historical alias of `localUser`. Auth principal for local API calls. */
  user: User | null;
  /** Display-bound identity: cloud user when logged in, otherwise local. */
  currentUser: User | null;
  /** Cloud user, or null when not cloud-logged-in. */
  cloudUser: User | null;
  /** Local desktop user (always present after bootstrap). */
  localUser: User | null;
  visitor: TypeId | null;
  someone: TypeId | null;
  /** Bootstrap error (network, auth, service unavailable, etc.) - not just auth errors */
  error: AuthError | null;
  /** Whether SDK bootstrap is still in progress */
  isBootstrapping: boolean;
}
export function useAuth(): UseAuthResult {
  const context = useContext();
  return {
    user: context.user,
    currentUser: context.currentUser,
    cloudUser: context.cloudUser,
    localUser: context.localUser,
    visitor: context.visitorTypeId,
    someone: context.someone,
    error: context.bootstrapError,
    isBootstrapping: context.isBootstrapping,
  };
}
