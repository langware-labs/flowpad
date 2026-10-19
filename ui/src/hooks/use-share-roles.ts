import { useEffect, useState } from 'react';
import { membershipService } from '@sdk';

/** The roles a share invite may grant, from the backend's `share-roles` action.
 *  Empty until it answers, and on failure — the invite form then shows no picker. */
export function useShareRoles(): string[] {
  const [roles, setRoles] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    void membershipService.fetchShareRoles().then((next) => live && setRoles(next));
    return () => {
      live = false;
    };
  }, []);
  return roles;
}
