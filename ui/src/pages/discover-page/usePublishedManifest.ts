import { dataContext, EMPTY_PUBLISHED_VIEW, type Project, type PublishedRow, type PublishedView, type UnpublishedRow } from '@sdk';
import { useCallback, useEffect, useState } from 'react';

/**
 * Read-side model for the Discover page: what the current project has
 * PUBLISHED (its manifest, joined with local state) and — on the desk — what it
 * could still publish. One call, `project.getPublished()`, the same contract on
 * the hub (where `unpublished` is always empty).
 *
 * The project is read once on mount from `dataContext`, which the route's
 * loader (`loadDiscover`) has already set from `?scope-project=` — so a hard
 * load, a bookmark and the project-home button all resolve the same project.
 */

export interface UsePublishedManifestResult {
  project: Project | null;
  projectId: string | null;
  projectName: string | null;
  view: PublishedView | null;
  rows: PublishedRow[];
  unpublished: UnpublishedRow[];
  isLoading: boolean;
  error: string | null;
  /** Re-fetch after a toggle changed the manifest. */
  refresh: () => void;
}

export function usePublishedManifest(): UsePublishedManifestResult {
  const project = dataContext.project ?? null;
  const projectId = project?.typeId?.id ?? null;
  // ``displayName`` is the composed label; ``getDisplayName()`` alone is the
  // subclass hook and answers null for a plain name.
  const projectName = project?.displayName ?? null;

  const [view, setView] = useState<PublishedView | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(!!projectId);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!project || !projectId) {
      setView(null);
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    void (async () => {
      try {
        const next = await project.getPublished();
        if (!cancelled) {
          setView(next ?? EMPTY_PUBLISHED_VIEW);
          setError(null);
        }
      } catch (err) {
        console.error('[usePublishedManifest] failed', err);
        if (!cancelled) {
          setView(EMPTY_PUBLISHED_VIEW);
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project, projectId, nonce]);

  return {
    project,
    projectId,
    projectName,
    view,
    rows: view?.rows ?? [],
    unpublished: view?.unpublished ?? [],
    isLoading,
    error,
    refresh,
  };
}
