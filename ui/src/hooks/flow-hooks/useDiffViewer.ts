import { useCallback } from 'react';
import { useDockNavigation } from '../../navigation/useDockNavigation';

/**
 * Hook for opening diff viewer with checkpoint hash
 */
export function useDiffViewer() {
  const { navigation } = useDockNavigation();

  const openDiffViewer = useCallback(
    (checkpointHash?: string) => {
      if (checkpointHash) {
        navigation.openDiff(checkpointHash);
      }
    },
    [navigation],
  );

  return { openDiffViewer };
}
