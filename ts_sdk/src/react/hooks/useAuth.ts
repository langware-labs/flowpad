import { AuthError, TypeId, User } from '@sdk';
import { useContext } from './useContext';

interface UseAuthResult {
  user: User | null;
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
    visitor: context.visitorTypeId,
    someone: context.someone,
    error: context.bootstrapError,
    isBootstrapping: context.isBootstrapping,
  };
}
