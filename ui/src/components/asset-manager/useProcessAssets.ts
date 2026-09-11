import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { AgenticProcess, Project, dataContext, type AssetDescriptor, type ProcessAssetUsage } from '@sdk';

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
  unresolvedUsage?: ProcessAssetUsage[];
  isLoading: boolean;
  error?: boolean;
  workerScoped?: boolean;
  assistantEnabled?: boolean;
  refresh: () => Promise<void>;
}

const STAGING_ASSET_LIMIT = 1000;

export function useProcessAssets(
  process: AgenticProcess | null,
  /** `projectId` is for projectless callers: it names the project to ask
   *  instead of the active one (e.g. a drill-down into `@flowpad_assistant`).
   *  `types` narrows the staging scan to those entity types (server-side);
   *  omit it for the default set. */
  options?: { enabled?: boolean; projectId?: string; types?: readonly string[] },
): UseProcessAssetsResult {
  const enabled = options?.enabled !== false;
  const explicitProjectId = options?.projectId;
  // Depend on the CONTENT, not the array identity: a caller passing an inline
  // `['skill']` would otherwise rebuild `refresh` every render, and the layout
  // effect below would re-fetch on each one.
  const typesKey = options?.types?.join(',') ?? '';

  const [descriptors, setDescriptors] = useState<AssetDescriptor[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(enabled);
  const [error, setError] = useState(false);
  const [unresolvedUsage, setUnresolvedUsage] = useState<ProcessAssetUsage[]>([]);
  const [assistantEnabled, setAssistantEnabled] = useState<boolean | undefined>();
  const tickRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const tick = ++tickRef.current;
    setIsLoading(true);
    setError(false);
    setDescriptors([]);
    setUnresolvedUsage([]);
    setAssistantEnabled(undefined);

    try {
      if (process) {
        const result = await process.getAssetInventory();
        if (tickRef.current === tick) {
          setAssistantEnabled(result.assistant_enabled);
          setDescriptors(result.assets);
          setUnresolvedUsage(result.unresolved_usage ?? []);
          setError(!!result.availability_error);
        }
      } else {
        // Staging: the active project's discoverable assets, computed
        // server-side; projectless surfaces fall back to the local project.
        const projectId = explicitProjectId ?? dataContext.project?.typeId?.id ?? '@local';
        const result = await Project.getAssetsById(projectId, {
          limit: STAGING_ASSET_LIMIT,
          ...(typesKey ? { types: typesKey.split(',') } : {}),
        });
        if (tickRef.current === tick) setDescriptors(result);
      }
    } catch (err) {
      console.error('[useProcessAssets] failed', err);
      if (tickRef.current === tick) {
        setDescriptors([]);
        setError(true);
      }
    } finally {
      if (tickRef.current === tick) setIsLoading(false);
    }
  }, [process, enabled, explicitProjectId, typesKey]);

  // Re-fetch when the process identity changes (or the hook becomes enabled).
  // Layout effect, not a passive one: `refresh` sets isLoading synchronously
  // before its first await, and a passive effect can run after paint — which
  // would flash the "no assets" empty state for a frame on first open.
  useLayoutEffect(() => {
    const pendingRequests = tickRef;
    void refresh();
    return () => { ++pendingRequests.current; };
  }, [refresh]);

  return { descriptors, unresolvedUsage, isLoading, error, workerScoped: !!process, assistantEnabled, refresh };
}
