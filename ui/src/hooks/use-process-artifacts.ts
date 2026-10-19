import type { AgenticProcess, Artifact } from '@sdk';
import { useOnTag } from '@sdk/react/hooks';
import { useEffect, useState } from 'react';

function artifactTimestamp(artifact: Artifact): number {
  const timestamp = new Date(artifact.created_date || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/** Newest-first, with a stable id tie-break. */
export function compareArtifactsNewest(a: Artifact, b: Artifact): number {
  return artifactTimestamp(b) - artifactTimestamp(a) || String(b.id).localeCompare(String(a.id));
}

/**
 * The newest artifact in a list, or null.
 *
 * A pure function of the list it is handed — it holds no memory of a previous
 * winner, because a remembered winner could re-crown itself off a stale row.
 *
 * Ties (two registrations in the same clock tick) break on id so the focused
 * artifact cannot flicker between renders. A row with no `created_date` sorts
 * oldest rather than winning on NaN.
 */
export function latestArtifact(artifacts: Artifact[] | undefined | null): Artifact | null {
  let best: Artifact | null = null;
  for (const artifact of artifacts ?? []) {
    if (best === null || compareArtifactsNewest(artifact, best) < 0) {
      best = artifact;
    }
  }
  return best;
}

/**
 * The artifacts a given agentic process produced.
 *
 * A thin READER of `proc.artifacts` — the process owns the list, this hook only
 * mirrors it into React state. There is no query here: an artifact is not
 * graph-scoped under its producer and a `generated_by` watched query re-fetched
 * the whole list on every unrelated entity write, which is exactly the second
 * source of truth this replaces.
 *
 * ORDER IS THE CONTRACT: the bus subscription is declared BEFORE the load
 * effect, so it is live before the REST GET is even issued. Fetch-then-subscribe
 * loses any event landing in the gap — and loses it silently, leaving the list
 * permanently short a row with nothing to notice. `loadArtifacts` merges its
 * snapshot into whatever the deltas already applied.
 */
export function useProcessArtifacts(proc: AgenticProcess | null | undefined) {
  const [artifacts, setArtifacts] = useState<Artifact[]>(() => proc?.artifacts ?? []);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Subscribed first, and deliberately unfiltered: the lane's `ctx.scope`
  // filter would silently drop an event that reached us without scope, and the
  // process already rejects an event whose `generated_by` is someone else's.
  useOnTag('artifact.*', (event) => {
    if (proc && proc.applyArtifactEvent(event)) setArtifacts(proc.artifacts);
  });

  useEffect(() => {
    if (!proc) {
      setArtifacts([]);
      setError(null);
      return;
    }
    let live = true;
    setArtifacts(proc.artifacts);
    setIsLoading(true);
    proc
      .loadArtifacts()
      .then((rows) => {
        if (live) {
          setArtifacts(rows);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (live) setIsLoading(false);
      });
    return () => {
      live = false;
    };
  }, [proc]);

  return { data: artifacts, latest: latestArtifact(artifacts), isLoading, error };
}
