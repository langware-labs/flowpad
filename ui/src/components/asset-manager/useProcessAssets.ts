import { useCallback, useEffect, useRef, useState } from 'react';
import { AgenticProcess, Project, dataContext, type AssetDescriptor } from '@sdk';

/**
 * Read-side hook over `process.getAssets()`.
 *
 * When a process exists: returns the unified descriptor list (EMBEDDED +
 * INLINE + USER_DIR + PROJECT_DIR + WORKDIR + ADDITIONAL_DIR).
 *
 * When `process === null` (pre-first-send staging): calls the project-level
 * counterpart `project/{id}/get-assets` (current project, else `@local`) —
 * the same server-side path-scan a new process in the project would see.
 * NEVER list whole type corpora here: the previous implementation fetched
 * ALL agents + skills + specs + markdown docs (~3.3MB / 3-5s at ~3k docs)
 * on picker open and synthesized descriptors in JS.
 */
export interface UseProcessAssetsResult {
  descriptors: AssetDescriptor[];
  isLoading: boolean;
  refresh: () => Promise<void>;
}

const STAGING_ASSET_LIMIT = 1000;

export function useProcessAssets(
  process: AgenticProcess | null,
  options?: { enabled?: boolean },
): UseProcessAssetsResult {
  const enabled = options?.enabled !== false;

  const [descriptors, setDescriptors] = useState<AssetDescriptor[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(enabled);
  const tickRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const tick = ++tickRef.current;
    setIsLoading(true);

    try {
      if (process) {
        const result = await process.getAssets();
        if (tickRef.current === tick) setDescriptors(result);
      } else {
        // Staging: the active project's discoverable assets, computed
        // server-side; projectless surfaces fall back to the local project.
        const projectId = dataContext.project?.typeId?.id ?? '@local';
        const result = await Project.getAssetsById(projectId, { limit: STAGING_ASSET_LIMIT });
        if (tickRef.current === tick) setDescriptors(result);
      }
    } catch (err) {
      console.error('[useProcessAssets] failed', err);
      if (tickRef.current === tick) setDescriptors([]);
    } finally {
      if (tickRef.current === tick) setIsLoading(false);
    }
  }, [process, enabled]);

  // Re-fetch when the process identity changes (or the hook becomes enabled).
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { descriptors, isLoading, refresh };
}
