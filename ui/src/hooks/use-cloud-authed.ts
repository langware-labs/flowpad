import { useAuth, useContext as useSdkContext } from '@sdk/react/hooks';

/**
 * Is the client authenticated to the hub right now? On desktop that means a
 * cloud login is available (or a resolved cloud user); on web the local user
 * suffices. Single source of truth for the desktop-vs-web auth rule — shared by
 * ``useLoginRequired`` (login gate) and ``useMembershipAvailability`` (membership
 * gate) so the two can't drift.
 */
export function useCloudAuthed(): boolean {
  const { user, cloudUser } = useAuth();
  const { cloudLoginAvailable, isDesktop } = useSdkContext();
  return isDesktop ? Boolean(cloudLoginAvailable || cloudUser) : Boolean(user);
}
