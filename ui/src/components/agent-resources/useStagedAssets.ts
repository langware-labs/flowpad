import { useMemo } from 'react';
import { dataContext } from '@sdk';
import type { AssetDescriptor } from '@sdk';
import { useProcessAssets, type UseProcessAssetsResult } from '@src/components/asset-manager';

/** Staging offers exactly the occurrences the backend says can be attached. */
export function useStagedAssets(type: string): UseProcessAssetsResult {
  // The pane rides the active project; `useProcessAssets` falls back to
  // `@local` on its own when there is none, so this stays undefined rather
  // than guessing an id here.
  const projectId = dataContext.project?.typeId?.id;

  // Keyed on the type STRING, not an array literal, so the fetch is rebuilt
  // only when the caller actually asks for a different type.
  const options = useMemo(() => ({ projectId, types: [type] }), [projectId, type]);

  // Destructured, NOT kept as one object: `useProcessAssets` returns a fresh
  // literal every render, so memoizing on it would hand back a new descriptors
  // array each time — and `AgentMcpField` derives `agent.md`'s `mcp_servers`
  // from this list, so churn there is a re-commit, not just a re-render.
  const { descriptors, isLoading, refresh, error, scanIssues, truncated } = useProcessAssets(null, options);

  const attachable = useMemo(
    () => descriptors.filter((d: AssetDescriptor) => d.attachable === true),
    [descriptors],
  );

  return useMemo(
    () => ({ descriptors: attachable, isLoading, refresh, error, scanIssues, truncated }),
    [attachable, isLoading, refresh, error, scanIssues, truncated],
  );
}
