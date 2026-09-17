import { Agent, type GitOrigin, gitOriginFromUrl, TypeId } from '@sdk';
import apiClient from '@sdk/client';
import { gitOriginOf, isCompleteGitOrigin } from '@sdk/models/GitOrigin';
import { useEntity } from '@sdk/react/hooks';
import { errorStatus } from '@src/lib/error-message';
import { useEffect, useMemo, useState } from 'react';

/**
 * What a `/launch` link points at: a repository (`?repo=`) or a published agent (`?agent=`).
 *
 * Decided from the raw query alone, before anything is fetched, so a broken link is refused
 * without a network call. A link naming BOTH is refused rather than resolved by precedence: it
 * was built wrong, and guessing which half the sender meant would launch something nobody
 * approved.
 */
export type LaunchTarget =
  | { kind: 'repo'; repo: string; branch: string }
  | { kind: 'agent'; agentTypeId: TypeId }
  | { kind: 'invalid'; reason: 'both' | 'bad-agent-id' | 'none' };

export function parseLaunchParams(params: URLSearchParams): LaunchTarget {
  // Presence, not value: `?repo=&agent=<id>` still names two things.
  if (params.has('repo') && params.has('agent')) return { kind: 'invalid', reason: 'both' };
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

/**
 * The repository a published agent launches from, addressed at the repo ROOT.
 *
 * The hub stores an agent's `git_origin` as the repo, the branch it was published to
 * (`flow-cloud`) and — as `rel_path` — the agent's own folder (`agentic-assets/agent/<name>`).
 * The sandbox clones the whole repository, so the folder is dropped: kept, it would only relabel
 * the repo card with a path the clone never uses. The branch is kept, because that is where the
 * published agent actually lives. `head_commit` is dropped too: the launch clones the branch tip.
 */
export function launchOriginFromAgent(agent: Pick<Agent, 'git_origin'> | null | undefined): GitOrigin | null {
  const origin = gitOriginOf(agent);
  if (!isCompleteGitOrigin(origin)) return null;
  return {
    kind: 'git',
    provider: origin.provider,
    owner: origin.owner,
    name: origin.name,
    branch: origin.branch,
    head_commit: null,
    rel_path: '.',
  };
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
  const status = errorStatus(state.error);
  if (status === 403 || status === 404) return 'unavailable';
  if (status === 401) return 'session-expired';
  return 'failed';
}

interface AnonymousAgentRead {
  agent: Agent | null;
  problem: AgentLoadProblem | null;
  error: unknown;
}

const NOTHING_READ: AnonymousAgentRead = { agent: null, problem: null, error: null };

/**
 * The agent as the page may see it before the app counts the user as signed in.
 *
 * A public agent (the hub's visibility action stamps it readable by anyone) answers this read,
 * which lets the sign-in card name it. A 401 is the EXPECTED answer for a private agent and a
 * truly anonymous caller: logged to the console below, not surfaced as an error.
 *
 * A 403/404 is different. The hub only answers `target_not_found` to a caller it has identified —
 * the browser is signed in to the hub even if the app has not caught up — so the agent really is
 * missing or not theirs, and that is reported like the signed-in read reports it.
 *
 * Keyed on the id, so a result that belongs to a previous link is never returned for this one.
 */
function useAnonymousAgent(agentId: string | null): AnonymousAgentRead {
  const [loaded, setLoaded] = useState<{ id: string; read: AnonymousAgentRead } | null>(null);
  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    apiClient
      .get<Partial<Agent> | null>(`/api/v1/graph/${Agent.type}/${agentId}`)
      .then((data) => {
        if (!cancelled && data) setLoaded({ id: agentId, read: { agent: new Agent(data), problem: null, error: null } });
      })
      .catch((error: unknown) => {
        const status = errorStatus(error);
        if (status === 403 || status === 404) {
          if (!cancelled) setLoaded({ id: agentId, read: { agent: null, problem: 'unavailable', error } });
          return;
        }
        console.log('[launch] agent is not readable before sign-in (expected unless it is public):', error);
      });
    return () => {
      cancelled = true;
    };
  }, [agentId]);
  return agentId && loaded?.id === agentId ? loaded.read : NOTHING_READ;
}

export interface LaunchTargetState {
  target: LaunchTarget;
  /** What would be cloned. Known up front for a repo link; for an agent link only once it loads. */
  gitOrigin: GitOrigin | null;
  agent: Agent | null;
  agentLoading: boolean;
  agentProblem: AgentLoadProblem | null;
  agentError: unknown;
}

export function useLaunchTarget(params: URLSearchParams, signedIn: boolean): LaunchTargetState {
  // Keyed on the query TEXT: a fresh URLSearchParams for the same link is the same target.
  const query = params.toString();
  const target = useMemo(() => parseLaunchParams(new URLSearchParams(query)), [query]);

  const agentTypeId = target.kind === 'agent' ? target.agentTypeId : null;
  // Signed in: the ordinary entity read, whose failures ARE the user's business (reported below).
  const readAgent = signedIn && agentTypeId !== null;
  const agentQuery = useEntity<Agent>(agentTypeId, { enabled: readAgent });
  // Signed out: only the quiet read — a public agent answers it, a 401 is silent, a 403 is reported.
  const anonymous = useAnonymousAgent(!signedIn && agentTypeId ? agentTypeId.id : null);
  const agent = readAgent ? (agentQuery.data ?? null) : anonymous.agent;

  const repoOrigin = useMemo(
    () => (target.kind === 'repo' ? gitOriginFromUrl(target.repo, target.branch) : null),
    [target],
  );
  // Not memoized: the store updates an entity IN PLACE (same object reference), so a memo keyed
  // on `agent` would keep serving the origin it had before a refresh. Rebuilding it is trivial.
  const agentOrigin = launchOriginFromAgent(agent);

  return {
    target,
    gitOrigin: target.kind === 'repo' ? repoOrigin : agentOrigin,
    agent,
    agentLoading: readAgent && agentQuery.isLoading,
    agentProblem: readAgent
      ? agentLoadProblem({ notFound: agentQuery.notFound, error: agentQuery.error, isError: agentQuery.isError })
      : anonymous.problem,
    agentError: readAgent ? agentQuery.error : anonymous.error,
  };
}
