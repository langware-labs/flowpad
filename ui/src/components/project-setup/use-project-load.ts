import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Project, TypeId, WebApp, type ProjectLoadResult } from '@sdk';
import { claimAskRun, openQuestionOf } from '@src/components/ask/ask-claims';
import { errorStatus } from '@src/lib/error-message';
import { SETUP_POLL_MS } from './use-setup-run';

/** The `asset` a Load names for a web app: the one spelling of its typeid, or '' for no app. */
export const webappAsset = (webappId?: string | null) => (webappId ? new TypeId(WebApp.type, webappId).toString() : '');

export const projectLoadKey = (projectId: string, display = '', asset = '') =>
  ['project-load', projectId, display, asset] as const;

/** Apps this tab last saw loaded and answering — the validate phase's verdict, held for the tab's session
 *  (a reload included: a query's cache would drop it, and the open would wait on a check). Only a hint:
 *  every open still checks it behind the app. */
const VALID_LOADS = 'flowpad.valid-loads';
const validLoads = new Set<string>(readValidLoads());
function readValidLoads(): string[] {
  try {
    const kept: unknown = JSON.parse(sessionStorage.getItem(VALID_LOADS) ?? '[]');
    return Array.isArray(kept) ? kept.filter((one): one is string => typeof one === 'string') : [];
  } catch {
    return [];
  }
}
export const validLoad = {
  key: (projectId: string, asset = '', display = '') => `${projectId}|${asset}|${display}`,
  has: (key: string) => validLoads.has(key),
  set: (key: string, up: boolean) => {
    if (up === validLoads.has(key)) return;
    if (up) validLoads.add(key);
    else validLoads.delete(key);
    try {
      sessionStorage.setItem(VALID_LOADS, JSON.stringify([...validLoads]));
    } catch {
      // Storage refused (a private window): the verdict lives in this page alone.
    }
  },
};

/**
 * Projection of the backend lifecycle. Polling only refreshes progress; it never retries Load.
 *
 * `asset` is the app being shown, when the load is for one. It must be named: asked about the project
 * alone, the backend settles without an app that is not installed, starts it uninstalled and calls the
 * failed run ready.
 */
export function useProjectLoad(
  projectId: string,
  initial?: ProjectLoadResult | null,
  display = '',
  claimQuestions = true,
  asset = '',
) {
  const client = useQueryClient();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [questionId, setQuestionId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: projectLoadKey(projectId, display, asset),
    queryFn: () => Project.loadState(projectId, asset || undefined),
    initialData: initial ?? undefined,
    // A seeded verdict is whatever the opener last heard, not what the backend holds now: read it once
    // on mount instead of trusting the seed for the app's five-minute default.
    staleTime: 0,
    refetchInterval: (q) => (q.state.data?.state === 'running' ? SETUP_POLL_MS : false),
    // A run finishes whether or not this window is in front: a hidden window that stopped asking kept
    // showing "Preparing…" over a run that had long failed.
    refetchIntervalInBackground: true,
  });
  const result = query.data;
  const tree = useQuery({
    queryKey: ['project-load-tree', projectId, asset, result?.run, result?.state],
    // Opening an app runs THAT app's setup (rooted at it); with no app, the project's own run.
    queryFn: () => Project.setupRun(projectId, asset),
    enabled: !!result?.run,
    refetchInterval: result?.state === 'running' ? SETUP_POLL_MS : false,
    refetchIntervalInBackground: true,
  });
  useEffect(() => {
    if (!claimQuestions || !result?.run || result.state !== 'running') return;
    let live = true;
    const release = claimAskRun(result.run, setQuestionId);
    void openQuestionOf(result.run).then((id) => {
      if (live) setQuestionId(id);
    });
    return () => {
      live = false;
      release();
      setQuestionId(null);
    };
  }, [result?.run, result?.state, claimQuestions]);

  const load = useCallback(
    async (approved = false) => {
      setStarting(true);
      setError(null);
      setMissing(false);
      try {
        await client.cancelQueries({ queryKey: projectLoadKey(projectId, display, asset) });
        const next = await Project.load(projectId, {
          approved,
          ...(asset ? { asset } : {}),
          ...(display ? { display } : {}),
        });
        client.setQueriesData({ queryKey: ['project-load', projectId] }, next);
        await client.invalidateQueries({ queryKey: ['project-load-tree', projectId] });
        return next;
      } catch (e) {
        // The project itself is gone (a dependency removed and added again gets a new one): loading
        // it again can never work, so it is not reported as an error to retry.
        if (errorStatus(e) === 404) setMissing(true);
        else setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setStarting(false);
      }
    },
    [client, projectId, display, asset],
  );

  return {
    result,
    starting,
    missing,
    error: error ?? (query.error ? String(query.error) : null),
    load,
    // The run's tree while there is a run, else what the check found.
    tree: tree.data?.tree ?? result?.tree ?? null,
    questionId,
    settleQuestion: () => setQuestionId(null),
  };
}
