/** React binding for the framework-free markdown sync store. */
import { useSyncExternalStore } from 'react';

import type { MdSyncStatus } from '../../services/md-sync-service';
import { getMdSync, subscribeToMdSync } from '../../stores/md-sync-store';

export function useMdSync(): MdSyncStatus | null {
  return useSyncExternalStore(subscribeToMdSync, getMdSync, getMdSync);
}
