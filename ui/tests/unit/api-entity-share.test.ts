import { dataManager, Project } from '@sdk';
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

describe('Project.share(users) — invites are membership grants, not a publish', () => {
  const ME = '3b0e1c2d-4f5a-4b6c-8d7e-9f0a1b2c3d4e';
  const THEM = '7c6d5e4f-3a2b-4c1d-9e8f-0a1b2c3d4e5f';

  it('POSTs one reflected members call per new recipient and never hits the share action', async () => {
    const project = new Project({ type: Project.type, id: PROJECT_ID, name: 'p', remote: true } as Partial<Project>);
    const call = vi.spyOn(dataManager, 'callAction').mockImplementation((info) =>
      Promise.resolve(info.method === 'GET' ? [{ user_id: ME, email: 'owner@example.com', role: 'owner' }] : undefined),
    );

    await project.share(['New@Example.com', { idOrEmail: `user-${THEM}`, role: 'admin' }, 'owner@example.com']);

    const infos = call.mock.calls.map(([info]) => info);
    expect(infos.every((info) => info.name === 'members')).toBe(true);
    const posts = infos.filter((info) => info.method === 'POST');
    expect(posts.map((info) => info.hubReflect)).toEqual([true, true]);
    expect(posts.map((info) => info.bodyParameters)).toEqual([
      { recipient_email: 'new@example.com', invitation_targets: [{ typeid: `project-${PROJECT_ID}`, role: 'member' }] },
      { recipient_user_id: THEM, invitation_targets: [{ typeid: `project-${PROJECT_ID}`, role: 'admin' }] },
    ]);
  });

  it('with nobody to invite is still the publish', async () => {
    const project = new Project({ type: Project.type, id: PROJECT_ID, name: 'p', remote: false } as Partial<Project>);
    const call = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ type: Project.type, id: PROJECT_ID, remote: true });

    await project.share();

    expect(call.mock.calls[0][0].name).toBe('share');
  });
});
