/**
 * `launch-target.ts` — what a `/launch` link names, decided before anything is fetched.
 *
 * Pure functions, so the refusals (several targets, a bad id) and the classification of a failed
 * hub read are pinned without rendering the page: the page test only has to prove it SHOWS them.
 */
import { describe, expect, it } from 'vitest';
import { agentLoadProblem, errorProblem, parseLaunchParams } from '@src/pages/entry/launch-target';

// Real v4 ids (version nibble 4, variant 8): TypeId validates the shape.
const AGENT_ID = '11111111-2222-4333-8444-555555555555';


const parse = (query: string) => parseLaunchParams(new URLSearchParams(query));

describe('parseLaunchParams', () => {
  it('keeps a repo link a repo link, with its branch', () => {
    expect(parse('repo=https://github.com/acme/site&branch=dev')).toEqual({
      kind: 'repo',
      repo: 'https://github.com/acme/site',
      branch: 'dev',
    });
  });

  it('keeps an unparseable repo a repo link, so the page can show what it could not launch', () => {
    expect(parse('repo=not-a-url')).toEqual({ kind: 'repo', repo: 'not-a-url', branch: '' });
  });

  it('reads an agent link as an agent TypeId', () => {
    const target = parse(`agent=${AGENT_ID}`);
    expect(target.kind).toBe('agent');
    if (target.kind !== 'agent') return;
    expect(target.agentTypeId.type).toBe('agent');
    expect(target.agentTypeId.id).toBe(AGENT_ID);
  });

  it('refuses a link that names both, even when one of them is empty', () => {
    expect(parse(`repo=https://github.com/acme/site&agent=${AGENT_ID}`)).toEqual({ kind: 'invalid', reason: 'both' });
    expect(parse(`repo=&agent=${AGENT_ID}`)).toEqual({ kind: 'invalid', reason: 'both' });
  });

  it('refuses an agent id the id policy would never accept', () => {
    expect(parse('agent=not-an-id')).toEqual({ kind: 'invalid', reason: 'bad-agent-id' });
    expect(parse('agent=')).toEqual({ kind: 'invalid', reason: 'bad-agent-id' });
  });

  it('reads a project link as its id, and refuses one the id policy would never accept', () => {
    expect(parse(`project=${AGENT_ID}`)).toEqual({ kind: 'project', projectId: AGENT_ID });
    expect(parse('project=nope')).toEqual({ kind: 'invalid', reason: 'bad-project-id' });
  });

  it('refuses a link that names a project AND something else', () => {
    expect(parse(`project=${AGENT_ID}&agent=${AGENT_ID}`)).toEqual({ kind: 'invalid', reason: 'both' });
    expect(parse(`project=${AGENT_ID}&repo=https://github.com/acme/site`)).toEqual({ kind: 'invalid', reason: 'both' });
  });

  it('names nothing when neither is given', () => {
    expect(parse('')).toEqual({ kind: 'invalid', reason: 'none' });
  });
});

describe('errorProblem', () => {
  it('classifies a bare hub error the way a read does', () => {
    expect(errorProblem({ response: { status: 403 } })).toBe('unavailable');
    expect(errorProblem({ response: { status: 401 } })).toBe('session-expired');
    expect(errorProblem(new Error('boom'))).toBe('failed');
  });
});

describe('agentLoadProblem', () => {
  it('reads "missing" and "not yours" as the one thing the hub lets us know', () => {
    expect(agentLoadProblem({ notFound: true, error: null })).toBe('unavailable');
    expect(agentLoadProblem({ notFound: false, error: { response: { status: 403 } } })).toBe('unavailable');
    expect(agentLoadProblem({ notFound: false, error: { response: { status: 404 } } })).toBe('unavailable');
  });

  it('tells an expired session apart, because signing in again fixes it', () => {
    expect(agentLoadProblem({ notFound: false, error: { response: { status: 401 } } })).toBe('session-expired');
  });

  it('passes anything else through as a failure', () => {
    expect(agentLoadProblem({ notFound: false, error: { response: { status: 500 } } })).toBe('failed');
    // The client interceptor stamps a network failure as 503 with no response.
    expect(agentLoadProblem({ notFound: false, error: { status: 503 } })).toBe('failed');
  });

  it('still reports a failure the read flagged without an error object', () => {
    expect(agentLoadProblem({ notFound: false, error: undefined, isError: true })).toBe('failed');
  });

  it('is null when the agent loaded', () => {
    expect(agentLoadProblem({ notFound: false, error: null })).toBeNull();
  });
});
