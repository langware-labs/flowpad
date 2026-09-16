import { dataContext, Project, type PublishedDirectory } from '@sdk';
import { isHubOnly } from '@src/navigation/hub-runtime';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fromDirectoryRow, fromPublished, fromUnpublished, type DiscoverItem } from './discover-model';
import { usePublishedManifest } from './usePublishedManifest';

export interface DiscoverDirectory {
  mode: 'hub' | 'desk';
  items: DiscoverItem[];
  /** Desk only: what the active project could still publish. */
  candidates: DiscoverItem[];
  project: { id: string; name: string } | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * The directory in whichever runtime this is: on the hub, everything the
 * signed-in user's projects published (`Project.getPublishedDirectory`); on
 * the desk, the active project's manifest joined with local state
 * (`usePublishedManifest`, unchanged) plus its not-yet-published candidates.
 */
export function useDiscoverDirectory(): DiscoverDirectory {
  const hub = isHubOnly();
  const desk = usePublishedManifest();
  const [directory, setDirectory] = useState<PublishedDirectory | null>(null);
  const [hubLoading, setHubLoading] = useState(hub);
  const [hubError, setHubError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refreshHub = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!hub) return;
    let cancelled = false;
    setHubLoading(true);
    void Project.getPublishedDirectory()
      .then((d) => {
        if (cancelled) return;
        setDirectory(d);
        setHubError(null);
      })
      .catch((err: unknown) => {
        console.error('[useDiscoverDirectory] failed', err);
        if (cancelled) return;
        setDirectory(null);
        setHubError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setHubLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hub, nonce]);

  const project = useMemo(() => {
    const p = dataContext.project;
    return p ? { id: p.id, name: p.displayName ?? p.name ?? p.id } : null;
  }, [desk.projectId]); // eslint-disable-line react-hooks/exhaustive-deps -- the loader sets the project before mount; its id is the change signal

  return useMemo(() => {
    if (hub) {
      return {
        mode: 'hub',
        items: (directory?.rows ?? []).map(fromDirectoryRow),
        candidates: [],
        project,
        isLoading: hubLoading,
        error: hubError,
        refresh: refreshHub,
      };
    }
    return {
      mode: 'desk',
      items: desk.rows.map((r) => fromPublished(r, project)),
      candidates: desk.unpublished.map((r) => fromUnpublished(r, project)),
      project,
      isLoading: desk.isLoading,
      error: desk.error,
      refresh: desk.refresh,
    };
  }, [hub, directory, project, hubLoading, hubError, refreshHub, desk.rows, desk.unpublished, desk.isLoading, desk.error, desk.refresh]);
}
