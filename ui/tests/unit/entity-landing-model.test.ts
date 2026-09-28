/**
 * The generic `/<type>/<id>` landing (FLOWPAD-2177) — its view model.
 *
 * The hub sends an invitee to `/<type>/<id>` whenever the invitation carries no
 * `callback_override`, and the SPA used to 404 on it. The page that now renders
 * there must stay generic: everything it shows is derived from the route params,
 * the hub's TypeInfo and the entity row, never from which type it is. These
 * assertions pin that contract, including the card rule the product accepted
 * (desktop card when the entity has a git origin OR its type ships through git).
 */
import { type GitOrigin, TypeId } from '@sdk';
import { describe, expect, it } from 'vitest';
import {
  entityLandingInputFrom,
  entityLandingModel,
  entityLandingProblem,
  hubEntityUrl,
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

describe('hubEntityUrl', () => {
  it('is the hub page generic entity view, as an absolute path', () => {
    expect(hubEntityUrl(new TypeId('agent', AGENT_ID))).toBe(`/dock/hub/entity/agent/${AGENT_ID}`);
    expect(hubEntityUrl(new TypeId('project', PROJECT_ID))).toBe(`/dock/hub/entity/project/${PROJECT_ID}`);
  });
});

describe('entityLandingModel', () => {
  it('offers the desktop card and a clone line when the entity carries a git origin', () => {
    const model = entityLandingModel({
      typeId: new TypeId('project', PROJECT_ID),
      cloudFileTransport: 'embedded',
      displayName: 'testing-flow-again',
      gitOrigin: origin({ branch: 'main', rel_path: '.' }),
    });
    expect(model.showDesktop).toBe(true);
    expect(model.cloneCommand).toBe('git clone -b main https://github.com/langware-ishay-sela/testing-flow-again.git');
    expect(model.repoPath).toBeNull();
    expect(model.hubUrl).toBe(`/dock/hub/entity/project/${PROJECT_ID}`);
  });

  it('names the path inside the repo when the entity is not the repo root', () => {
    const model = entityLandingModel({
      typeId: new TypeId('agent', AGENT_ID),
      cloudFileTransport: 'git',
      displayName: 'crm-manager',
      gitOrigin: origin(),
    });
    expect(model.repoPath).toBe('agentic-assets/agent/crm-manager');
    expect(model.cloneCommand).toContain('-b flow-cloud');
  });

  it('offers the desktop card without a clone line for a git-transport type with no origin', () => {
    const model = entityLandingModel({
      typeId: new TypeId('skill', AGENT_ID),
      cloudFileTransport: 'git',
      displayName: 'release-notes',
    });
    expect(model.showDesktop).toBe(true);
    expect(model.cloneCommand).toBeNull();
  });

  it('offers the browser card alone when there is neither an origin nor a git transport', () => {
    const model = entityLandingModel({
      typeId: new TypeId('team', AGENT_ID),
      cloudFileTransport: 'embedded',
      displayName: 'Langware R&D',
    });
    expect(model.showDesktop).toBe(false);
    expect(model.cloneCommand).toBeNull();
  });

  it('ignores an origin that names no repository', () => {
    const model = entityLandingModel({
      typeId: new TypeId('task', AGENT_ID),
      cloudFileTransport: 'embedded',
      displayName: 'a task',
      gitOrigin: origin({ owner: '', name: '' }),
    });
    expect(model.showDesktop).toBe(false);
  });

  it('decides from the data, not the type name: two types with the same inputs get the same cards', () => {
    const inputs = { cloudFileTransport: 'git', displayName: 'x', gitOrigin: origin() };
    const a = entityLandingModel({ ...inputs, typeId: new TypeId('agent', AGENT_ID) });
    const b = entityLandingModel({ ...inputs, typeId: new TypeId('team', AGENT_ID) });
    expect({ ...a, hubUrl: null }).toEqual({ ...b, hubUrl: null });
  });
});

describe('entityLandingInputFrom', () => {
  it('reads the hub wire name git_origin and a string description', () => {
    const typeId = new TypeId('agent', AGENT_ID);
    const input = entityLandingInputFrom(
      typeId,
      { displayName: 'crm-manager', description: 'Manage the customers', git_origin: origin() },
      'git',
    );
    expect(input.gitOrigin?.name).toBe('testing-flow-again');
    expect(input.description).toBe('Manage the customers');
    expect(input.cloudFileTransport).toBe('git');
  });

  it('falls back to the id when the entity has no display name, and drops a non-string description', () => {
    const typeId = new TypeId('agent', AGENT_ID);
    const input = entityLandingInputFrom(typeId, { displayName: '', description: { rich: true } }, undefined);
    expect(input.displayName).toBe(AGENT_ID);
    expect(input.description).toBeNull();
    expect(input.gitOrigin).toBeNull();
  });
});
