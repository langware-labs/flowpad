import { useMemo } from 'react';
import { dataContext } from '@sdk';
import { useProcessAssets, type UseProcessAssetsResult } from '@src/components/asset-manager';

/**
 * Assets of one type that a process started in this project would see, via the
 * staging read `useProcessAssets(null, …)` — rows arrive already attributed to
 * a `source`. NOT a type listing: `/graph/<type>` has no location filter and
 * returns everything indexed on the machine (77 skills here, 10 of them real).
 */
export function useStagedAssets(type: string): UseProcessAssetsResult {
  // The pane rides the active project; `useProcessAssets` falls back to
  // `@local` on its own when there is none, so this stays undefined rather
  // than guessing an id here.
  const projectId = dataContext.project?.typeId?.id;

  // Keyed on the type STRING, not an array literal, so the fetch is rebuilt
  // only when the caller actually asks for a different type.
  const options = useMemo(() => ({ projectId, types: [type] }), [projectId, type]);

  // Returned whole: the picker takes the same object as its `assets` prop.
  return useProcessAssets(null, options);
}
