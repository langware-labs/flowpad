import { dataManager, inviteFailure, Project, TypeId, type ShareResult } from '@sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

const PROJECT_ID = '91c340cb-a2cc-4f67-9fe1-f2a0e481a0e3';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('APIEntity.share', () => {
  it('adopts and returns the canonical entity from the share action', async () => {
    const project = new Project({
      type: Project.type,
      id: PROJECT_ID,
      name: 'before-publish',
      remote: false,
    } as Partial<Project>);
    const canonical = {
      type: Project.type,
      id: PROJECT_ID,
      name: 'canonical-project',
      remote: true,
      hub_published_at: '2026-08-03T12:00:00+00:00',
      origin: {
        kind: 'git',
        provider: 'github',
        owner: 'flowpad-test',
        name: 'published-project',
        branch: 'main',
        head_commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        rel_path: '.',
      },
    };
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue(canonical);

    const result = await project.share();

    expect(result).toBe(project);
    expect(project.name).toBe('canonical-project');
    expect(project.remote).toBe(true);
    expect(project.hub_published_at).toBe('2026-08-03T12:00:00+00:00');
    expect(project.origin).toEqual(canonical.origin);
    expect(call.mock.calls[0][0].bodyParameters).toEqual({});
  });

  it('does not manufacture remote state for a non-entity publication receipt', async () => {
    const project = new Project({
      type: Project.type,
      id: '1f1b71f0-a8d8-47be-b82d-d06c6cc4a703',
      name: 'receipt-project',
      remote: false,
    } as Partial<Project>);
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({ git: { changed: true } });

    await project.share();

    expect(project.remote).toBe(false);
  });
});

describe('Project.invite — one share action; the backend orchestrates the invites', () => {
  const THEM = '7c6d5e4f-3a2b-4c1d-9e8f-0a1b2c3d4e5f';
  const ZSCHOOL = '6a6a6a6a-0000-4000-8000-000000000007';
  const outcome: ShareResult = {
    invited: [{ user_id: THEM, email: null, name: 'Them', conversation_id: 'conv-1' }],
    skipped: [{ user_id: null, email: 'owner@example.com', reason: 'self' }],
    failed: [],
    granted_teams: [{ team: `team-${ZSCHOOL}`, name: 'zschool', conversation_id: 'conv-team' }],
    skipped_teams: [],
    failed_teams: [],
  };
  const project = () =>
    new Project({ type: Project.type, id: PROJECT_ID, name: 'p', remote: true } as Partial<Project>);

  it('POSTs the share action once with only the share keys and returns its share_result', async () => {
    const p = project();
    const call = vi
      .spyOn(dataManager, 'callAction')
      .mockResolvedValue({
        type: Project.type,
        id: PROJECT_ID,
        name: 'canonical',
        remote: true,
        share_result: outcome,
      });

    const result = await p.invite([' New@Example.com ', '', { idOrEmail: `user-${THEM}`, role: 'admin' }], {
      teams: [new TypeId('team', ZSCHOOL)],
      note: '  Welcome aboard ',
    });

    expect(call).toHaveBeenCalledTimes(1);
    const info = call.mock.calls[0][0];
    expect(info.name).toBe('share');
    expect(info.method).toBe('POST');
    // Only ShareRequestSpec's keys — never the entity's own JSON.
    expect(info.bodyParameters).toEqual({
      recipients: ['New@Example.com', { idOrEmail: `user-${THEM}`, role: 'admin' }],
      teams: [`team-${ZSCHOOL}`],
      note: 'Welcome aboard',
    });
    expect(result).toEqual(outcome);
    // The canonical row is adopted; `share_result` is not an entity field.
    expect(p.name).toBe('canonical');
    expect((p as unknown as Record<string, unknown>).share_result).toBeUndefined();
  });

  it('sends a team-only share without teams/note keys it was not given, and an empty result when none came back', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ type: Project.type, id: PROJECT_ID });

    const result = await project().invite(['a@example.com']);

    expect(call.mock.calls[0][0].bodyParameters).toEqual({ recipients: ['a@example.com'] });
    expect(result).toEqual({
      invited: [],
      skipped: [],
      failed: [],
      granted_teams: [],
      skipped_teams: [],
      failed_teams: [],
    });
  });
});

describe('Project.share(users) — the invite, or with nobody to invite the publish', () => {
  it('invites through the share action and throws the backend’s sentence when someone failed', async () => {
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({
      type: Project.type,
      id: PROJECT_ID,
      share_result: {
        invited: [],
        skipped: [],
        failed: [{ user_id: null, email: 'eli@example.com', status: 500, message: 'boom' }],
        granted_teams: [],
        skipped_teams: [],
        failed_teams: [],
      },
    });
    const project = new Project({ type: Project.type, id: PROJECT_ID, name: 'p', remote: true } as Partial<Project>);

    await expect(project.share(['eli@example.com'])).rejects.toThrow('Could not invite eli@example.com: boom');
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0].bodyParameters).toEqual({ recipients: ['eli@example.com'] });
  });

  it('with nobody to invite is still the publish', async () => {
    const project = new Project({ type: Project.type, id: PROJECT_ID, name: 'p', remote: false } as Partial<Project>);
    const call = vi
      .spyOn(dataManager, 'callAction')
      .mockResolvedValue({ type: Project.type, id: PROJECT_ID, remote: true });

    await project.share(['  ']);

    expect(call.mock.calls[0][0].name).toBe('share');
    expect(call.mock.calls[0][0].bodyParameters).toEqual({});
  });
});

describe('inviteFailure — an error only when nothing landed', () => {
  const EMPTY: ShareResult = {
    invited: [],
    skipped: [],
    failed: [],
    granted_teams: [],
    skipped_teams: [],
    failed_teams: [],
  };
  const TEAM = 'team-6a6a6a6a-0000-4000-8000-000000000007';
  const failedPerson = { user_id: null, email: 'eli@example.com', status: 403, message: 'nope' };

  it('is null when a team was granted and every person failed', () => {
    expect(
      inviteFailure({
        ...EMPTY,
        failed: [failedPerson],
        granted_teams: [{ team: TEAM, name: 'sandbox-team', conversation_id: 'c' }],
      }),
    ).toBeNull();
  });

  it('is null when one person was invited and another failed', () => {
    expect(
      inviteFailure({
        ...EMPTY,
        invited: [{ user_id: 'u', email: null, name: 'U', conversation_id: 'c' }],
        failed: [failedPerson],
      }),
    ).toBeNull();
  });

  it('is an error naming every failed person and team when nothing succeeded', () => {
    const error = inviteFailure({
      ...EMPTY,
      failed: [failedPerson],
      failed_teams: [{ team: TEAM, name: 'locked', status: 403, message: 'Forbidden' }],
    });
    expect(error?.message).toBe('Could not invite eli@example.com, locked: nope');
  });

  it('is null when nothing was sent and nothing failed', () => {
    expect(inviteFailure({ ...EMPTY, skipped_teams: [{ team: TEAM, name: 't', reason: 'already_granted' }] })).toBeNull();
  });
});
