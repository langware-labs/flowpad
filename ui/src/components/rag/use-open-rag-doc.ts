/** Open the document a chunk came from: `doc_ref` is its machine path, so this is a navigation and nothing else. */
import { useCallback } from 'react';
import { LOCAL_COMPUTE_NODE } from '@src/navigation/asset-doc-types';
import { useDockNavigation } from '@src/navigation/useDockNavigation';

export function useOpenRagDoc(): (docRef: string) => void {
  const { navigation } = useDockNavigation();
  return useCallback((docRef: string) => navigation.openMachinePath(docRef, LOCAL_COMPUTE_NODE), [navigation]);
}
