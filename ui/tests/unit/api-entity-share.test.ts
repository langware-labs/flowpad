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
      git_origin: {
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
    expect(project.git_origin).toEqual(canonical.git_origin);
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
