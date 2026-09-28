/**
 * The generic `/<type>/<id>` landing's view model: everything it shows comes from
 * the route params, the hub's TypeInfo and the entity row — never from which
 * type it is.
 */
import { type GitOrigin, TypeId } from '@sdk';
import { describe, expect, it } from 'vitest';
import {
  entityLandingModel,
  entityLandingProblem,
  parseEntityLandingParams,
} from '@src/pages/entry/entity-landing-model';

const AGENT_ID = 'a74e685c-348b-48fa-87fa-f84f742c7e06';
const PROJECT_ID = '793e3708-563d-4f80-9ab1-f542ceb16656';

const origin = (over: Partial<GitOrigin> = {}): GitOrigin => ({
  kind: 'git',
  provider: 'github',
  owner: 'langware-ishay-sela',
  name: 'testing-flow-again',
  branch: 'flow-cloud',
  rel_path: 'agentic-assets/agent/crm-manager',
  ...over,
});

describe('parseEntityLandingParams', () => {
  it('builds the TypeId the hub emitted', () => {
    expect(parseEntityLandingParams('agent', AGENT_ID)?.toString()).toBe(`agent-${AGENT_ID}`);
  });

  it('answers null instead of throwing for an id TypeId rejects', () => {
    expect(parseEntityLandingParams('agent', 'not-a-uuid')).toBeNull();
  });

  it('answers null for missing params', () => {
    expect(parseEntityLandingParams(undefined, AGENT_ID)).toBeNull();
    expect(parseEntityLandingParams('agent', undefined)).toBeNull();
  });
});

describe('entityLandingProblem', () => {
  it('is nothing while there is neither an error nor a not-found', () => {
    expect(entityLandingProblem({ notFound: false, error: null })).toBeNull();
  });

  it('treats the hub 403 target_not_found, 404 and 422 as the same dead link', () => {
    for (const status of [403, 404, 422]) {
      expect(entityLandingProblem({ notFound: false, error: { response: { status } } })).toBe('not-found');
    }
    expect(entityLandingProblem({ notFound: true, error: null })).toBe('not-found');
  });

  it('asks for sign-in on 401', () => {
    expect(entityLandingProblem({ notFound: false, error: { status: 401 } })).toBe('signed-out');
  });

  it('reports anything else as a failure, not as not-found', () => {
    expect(entityLandingProblem({ notFound: false, error: { response: { status: 500 } } })).toBe('failed');
    expect(entityLandingProblem({ notFound: false, error: new Error('network') })).toBe('failed');
  });
});

describe('entityLandingModel', () => {
  it('points the browser at the hub page generic entity view', () => {
    const model = entityLandingModel(new TypeId('agent', AGENT_ID), { displayName: 'crm-manager' }, 'git');
    expect(model.hubUrl).toBe(`/dock/hub/entity/agent/${AGENT_ID}`);
  });

  it('offers the desktop card with the repository when the entity carries a git origin', () => {
    const model = entityLandingModel(
      new TypeId('project', PROJECT_ID),
      { displayName: 'testing-flow-again', git_origin: origin({ branch: 'main', rel_path: '.' }) },
      'embedded',
    );
    expect(model.showDesktop).toBe(true);
    expect(model.gitOrigin?.name).toBe('testing-flow-again');
  });

  it("accepts a project's repo-root origin, whose rel_path is empty", () => {
    const model = entityLandingModel(
      new TypeId('project', PROJECT_ID),
      { displayName: 'p', git_origin: origin({ rel_path: '' }) },
      'embedded',
    );
    expect(model.gitOrigin).not.toBeNull();
  });

  it('offers the desktop card without a repository for a git-transport type with no origin', () => {
    const model = entityLandingModel(new TypeId('skill', AGENT_ID), { displayName: 'release-notes' }, 'git');
    expect(model.showDesktop).toBe(true);
    expect(model.gitOrigin).toBeNull();
  });

  it('offers the browser card alone when there is neither an origin nor a git transport', () => {
    const model = entityLandingModel(new TypeId('team', AGENT_ID), { displayName: 'Langware R&D' }, 'embedded');
    expect(model.showDesktop).toBe(false);
  });

  it('ignores an origin that names no repository', () => {
    const model = entityLandingModel(
      new TypeId('task', AGENT_ID),
      { displayName: 'a task', git_origin: origin({ owner: '', name: '' }) },
      'embedded',
    );
    expect(model.showDesktop).toBe(false);
  });

  it('decides from the data, not the type name: two types with the same inputs get the same cards', () => {
    const entity = { displayName: 'x', git_origin: origin() };
    const a = entityLandingModel(new TypeId('agent', AGENT_ID), entity, 'git');
    const b = entityLandingModel(new TypeId('team', AGENT_ID), entity, 'git');
    expect({ ...a, hubUrl: null }).toEqual({ ...b, hubUrl: null });
  });

  it('falls back to the id when the entity has no display name, and drops a non-string description', () => {
    const model = entityLandingModel(new TypeId('agent', AGENT_ID), { displayName: '', description: { rich: true } });
    expect(model.displayName).toBe(AGENT_ID);
    expect(model.description).toBeNull();
  });

  it('keeps a text description, trimmed', () => {
    const model = entityLandingModel(new TypeId('agent', AGENT_ID), { description: '  Manage customers ' });
    expect(model.description).toBe('Manage customers');
  });
});
