import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Project, type ProjectLoadResult } from '@sdk';
import { claimAskRun, openQuestionOf } from '@src/components/ask/ask-claims';
import { SETUP_POLL_MS } from './use-setup-run';

export const projectLoadKey = (projectId: string, display = '') => ['project-load', projectId, display] as const;

/** Projection of the backend lifecycle. Polling only refreshes progress; it never retries Load. */
export function useProjectLoad(projectId: string, initial?: ProjectLoadResult | null, display = '', claimQuestions = true) {
  const client = useQueryClient();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [questionId, setQuestionId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: projectLoadKey(projectId, display),
    queryFn: () => Project.loadState(projectId),
    initialData: initial ?? undefined,
    refetchInterval: (q) => (q.state.data?.state === 'running' ? SETUP_POLL_MS : false),
  });
  const result = query.data;
  const tree = useQuery({
    queryKey: ['project-load-tree', projectId, result?.run, result?.state],
    queryFn: () => Project.setupRun(projectId),
    enabled: !!result?.run,
    refetchInterval: result?.state === 'running' ? SETUP_POLL_MS : false,
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
      try {
        await client.cancelQueries({ queryKey: projectLoadKey(projectId, display) });
        const next = await Project.load(projectId, { approved, ...(display ? { display } : {}) });
        client.setQueriesData({ queryKey: ['project-load', projectId] }, next);
        await client.invalidateQueries({ queryKey: ['project-load-tree', projectId] });
        return next;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setStarting(false);
      }
    },
    [client, projectId, display],
  );

  return {
    result,
    starting,
    error: error ?? (query.error ? String(query.error) : null),
    load,
    tree: tree.data?.tree ?? null,
    questionId,
    settleQuestion: () => setQuestionId(null),
  };
}
