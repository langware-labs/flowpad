import { normalizeEmail } from '@sdk';
import { useAuth } from '@sdk/react/hooks';

/** My email, normalized: the cloud account's when signed in, else the local user's. Null when neither has one. */
export function useMyEmail(): string | null {
  const { cloudUser, currentUser } = useAuth();
  return normalizeEmail(cloudUser?.email || currentUser?.email) || null;
}
