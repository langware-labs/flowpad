import { Agent, type GitOrigin, gitOriginFromUrl, Project, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { useEntity } from '@sdk/react/hooks';
import { errorStatus } from '@src/lib/error-message';
import { useEffect, useMemo, useState } from 'react';

/**
 * What a `/launch` link points at: a repository (`?repo=`), a published agent (`?agent=`) or a
 * project (`?project=`).
 *
 * Decided from the raw query alone, before anything is fetched, so a broken link is refused
 * without a network call. A link naming BOTH is refused rather than resolved by precedence: it
 * was built wrong, and guessing which half the sender meant would launch something nobody
 * approved.
 */
export type LaunchTarget =
  | { kind: 'repo'; repo: string; branch: string }
  | { kind: 'agent'; agentTypeId: TypeId }
  | { kind: 'project'; projectId: string }
  | { kind: 'invalid'; reason: 'both' | 'bad-agent-id' | 'bad-project-id' | 'none' };

export function parseLaunchParams(params: URLSearchParams): LaunchTarget {
  // Presence, not value: `?repo=&agent=<id>` still names two things.
  if (['repo', 'agent', 'project'].filter((k) => params.has(k)).length > 1) return { kind: 'invalid', reason: 'both' };
  if (params.has('project')) {
    try {
      // Same id policy gate as an agent: a non-v4/v5 id never reaches the hub.
      return { kind: 'project', projectId: new TypeId(Project.type, (params.get('project') ?? '').trim()).id };
    } catch {
      return { kind: 'invalid', reason: 'bad-project-id' };
    }
  }
  if (params.has('agent')) {
    try {
      // TypeId is the id policy gate: a non-v4/v5 id throws here instead of reaching the hub.
      return { kind: 'agent', agentTypeId: new TypeId(Agent.type, (params.get('agent') ?? '').trim()) };
    } catch {
      return { kind: 'invalid', reason: 'bad-agent-id' };
    }
  }
  const repo = params.get('repo') ?? '';
  // An unparseable repo stays a repo link: the page shows the raw value it could not launch.
  if (repo) return { kind: 'repo', repo, branch: params.get('branch') ?? '' };
  return { kind: 'invalid', reason: 'none' };
}

export type AgentLoadProblem = 'unavailable' | 'session-expired' | 'failed';

/**
 * Why an agent link could not be opened, or null when nothing went wrong.
 *
 * `unavailable` covers both "no such agent" and "not yours to see" on purpose: the hub answers
 * the two identically (403 `target_not_found`) so an agent's existence cannot be probed, and a
 * message that told them apart would be guessing. 404 folds in for a backend that does send it.
 */
export function agentLoadProblem(state: {
  notFound: boolean;
  error: unknown;
  isError?: boolean;
}): AgentLoadProblem | null {
  if (state.notFound) return 'unavailable';
  // A read can report failure without carrying the error object; that is still a failure, and a
  // card that says nothing at all is the one outcome this page must never show.
  if (!state.error) return state.isError ? 'failed' : null;
  return errorProblem(state.error);
}

/** The problem a failed hub read names, by its status — `agentLoadProblem` for a bare error. */
export function errorProblem(error: unknown): AgentLoadProblem {
  const status = errorStatus(error);
  if (status === 403 || status === 404) return 'unavailable';
  if (status === 401) return 'session-expired';
  return 'failed';
}

/**
 * The agent as the page may see it before the app counts the user as signed in.
 *
 * A public agent (the hub's visibility action stamps it readable by anyone) answers this read,
 * which lets the sign-in card name it. Any refusal is the EXPECTED answer for a private agent:
 * logged to the console and never shown — the signed-in page reports what is wrong.
 *
 * Keyed on the id, so a result that belongs to a previous link is never returned for this one.
 */
function useAnonymousAgent(agentId: string | null): Agent | null {
  const [loaded, setLoaded] = useState<{ id: string; agent: Agent } | null>(null);
  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    apiClient
      .get<Partial<Agent> | null>(`/api/v1/graph/${Agent.type}/${agentId}`)
      .then((data) => {
        if (!cancelled && data) setLoaded({ id: agentId, agent: new Agent(data) });
      })
      .catch((error: unknown) => {
        console.log('[launch] agent is not readable before sign-in (expected unless it is public):', error);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);
  return agentId && loaded?.id === agentId ? loaded.agent : null;
}

export interface LaunchTargetState {
  target: LaunchTarget;
  /** What a `?repo=` link clones; null for any other link. */
  gitOrigin: GitOrigin | null;
  /** The agent an `?agent=` link names, once readable — for the page to name it. */
  agent: Agent | null;
}

export function useLaunchTarget(params: URLSearchParams, signedIn: boolean): LaunchTargetState {
  // Keyed on the query TEXT: a fresh URLSearchParams for the same link is the same target.
  const query = params.toString();
  const target = useMemo(() => parseLaunchParams(new URLSearchParams(query)), [query]);

  const agentTypeId = target.kind === 'agent' ? target.agentTypeId : null;
  // Signed in: the ordinary entity read. Signed out: only the quiet read — a public agent answers it.
  const readAgent = signedIn && agentTypeId !== null;
  const agentQuery = useEntity<Agent>(agentTypeId, { enabled: readAgent });
  const anonymous = useAnonymousAgent(!signedIn && agentTypeId ? agentTypeId.id : null);

  const gitOrigin = useMemo(
    () => (target.kind === 'repo' ? gitOriginFromUrl(target.repo, target.branch) : null),
    [target],
  );
  return { target, gitOrigin, agent: readAgent ? (agentQuery.data ?? null) : anonymous };
}
