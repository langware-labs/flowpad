import { ActionInfo, dataManager } from '@sdk';
import type { GitStatus } from '@sdk';

/**
 * Shared single-flight + short-TTL cache for the ``git-ops status`` action.
 *
 * Why: ``git-ops/status`` fans out to several git subprocesses server-side
 * (branch, ahead/behind, numstat, a full ``--untracked-files=all`` scan), and
 * it is called independently from many per-tab surfaces (footer pill, skill
 * UsagePanel, GitPanel, ...). With ~8 asset-editor tabs open on the same repo,
 * each firing its own request, the backend drowns in duplicate git work.
 *
 * This coalesces concurrent callers on the same ``(computeNodeId, workdir)``
 * onto one in-flight request, and serves the resolved result for a brief TTL so
 * a burst of mounts/re-renders collapses to a single git call. Callers that need
 * fresh state (after a push/commit) pass ``{ force: true }`` or call
 * ``invalidateGitStatus`` first.
 */

// Re-export the SDK's git-status shapes (single source of truth - the same
// types ``GitWorkdir`` returns) so callers can keep importing them from here.
export type { GitStatus, GitStatusFile } from '@sdk';
export type GitStatusData = GitStatus;

/** Coalesce window - long enough to absorb a burst of tab mounts, short enough
 *  that an explicit refresh is rarely needed for routine UI freshness. */
const TTL_MS = 3000;

interface Entry {
  at: number;
  promise: Promise<GitStatusData | null>;
}

const cache = new Map<string, Entry>();

const keyFor = (computeNodeId: string, workdir: string): string =>
  `${computeNodeId} ${workdir}`;

/**
 * Fetch ``git-ops status`` for a working tree, deduped across callers.
 * Returns null when inputs are missing or the request fails.
 */
export function getGitStatus(
  computeNodeId: string | null,
  workdir: string | null,
  opts?: { force?: boolean },
): Promise<GitStatusData | null> {
  if (!computeNodeId || !workdir) return Promise.resolve(null);
  const key = keyFor(computeNodeId, workdir);
  const now = Date.now();
  const hit = cache.get(key);
  if (!opts?.force && hit && now - hit.at < TTL_MS) return hit.promise;

  const action = new ActionInfo('git-ops', 'compute_node', computeNodeId, 'GET');
  action.subpath = 'status';
  action.queryParameters = { workdir };
  const promise = dataManager
    .callAction<null, GitStatusData>(action)
    .catch(() => null);
  cache.set(key, { at: now, promise });
  // Auto-evict after the TTL so the Map stays bounded across a long session
  // that touches many workdirs (the entry is useless once stale anyway).
  setTimeout(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  }, TTL_MS);
  return promise;
}

/** Drop the cached entry so the next ``getGitStatus`` re-fetches (e.g. after a
 *  push/commit that changed the working tree). */
export function invalidateGitStatus(
  computeNodeId: string | null,
  workdir: string | null,
): void {
  if (!computeNodeId || !workdir) return;
  cache.delete(keyFor(computeNodeId, workdir));
}
