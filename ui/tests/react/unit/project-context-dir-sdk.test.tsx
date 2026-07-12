/**
 * TS SDK contract for project context-dir actions.
 *
 * The backend derives `include_dirs` from Folder context links (computed
 * field) — the SDK must ADOPT the action response's list rather than
 * optimistically mutating its local copy (the server canonicalizes paths, so
 * a local guess can diverge). Also: the `scope` param (private default /
 * shared) must reach the POST body.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataManager, Project } from '@sdk';

function makeProject(dirs: string[] = []): Project {
  return new Project({
    id: '00000000-0000-4000-8000-000000000001',
    type: 'project',
    name: 'ctx-proj',
    include_dirs: dirs,
  } as Partial<Project>);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Project.addContextDir', () => {
  it('adopts the server-computed include_dirs (canonicalized), not the raw input', async () => {
    const project = makeProject();
    const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue({
      id: project.id,
      include_dirs: ['/users/alice/notes'], // server canonical form
    });

    await project.addContextDir('/Users/Alice/Notes/');

    expect(project.include_dirs).toEqual(['/users/alice/notes']);
    const actionInfo = spy.mock.calls[0][0] as { bodyParameters?: Record<string, unknown> };
    expect(actionInfo.bodyParameters).toEqual({ path: '/Users/Alice/Notes/', scope: 'private' });
  });

  it('plumbs scope="shared" into the POST body', async () => {
    const project = makeProject();
    const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue({
      include_dirs: ['/x'],
    });

    await project.addContextDir('/x', 'shared');

    const actionInfo = spy.mock.calls[0][0] as { bodyParameters?: Record<string, unknown> };
    expect(actionInfo.bodyParameters).toEqual({ path: '/x', scope: 'shared' });
  });

  it('keeps the local list untouched when the response carries no include_dirs', async () => {
    const project = makeProject(['/existing']);
    vi.spyOn(dataManager, 'callAction').mockResolvedValue(undefined);

    await project.addContextDir('/y');

    expect(project.include_dirs).toEqual(['/existing']);
  });
});

describe('Project.removeContextDir', () => {
  it('adopts the server response instead of filtering locally', async () => {
    const project = makeProject(['/a', '/b']);
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({
      include_dirs: ['/b'],
    });

    await project.removeContextDir('/a');

    expect(project.include_dirs).toEqual(['/b']);
  });
});

describe('Project.resolveContextFolders', () => {
  it('posts resolve-context-folders and adopts the server-computed include_dirs', async () => {
    const project = makeProject([]);
    const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue({
      include_dirs: ['/cloned/repo/ctx'],
      context_folder_results: [{ kind: 'ready', path: '/cloned/repo/ctx' }],
    });

    const results = await project.resolveContextFolders();

    expect(project.include_dirs).toEqual(['/cloned/repo/ctx']);
    expect(results).toEqual([{ kind: 'ready', path: '/cloned/repo/ctx' }]);
    const actionInfo = spy.mock.calls[0][0] as { name?: string; bodyParameters?: unknown };
    expect(actionInfo.name).toBe('resolve-context-folders');
    expect(actionInfo.bodyParameters).toEqual({});
  });
});
