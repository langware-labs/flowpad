/**
 * `docs/snippets/project-git-share.md` §6, the TypeScript fence, run as written.
 *
 * The real `Project` and the real `dataManager` — only `callAction` is answered,
 * by a double that plays the desk's `project/<id>/git_share` route and checks each
 * request: the action, the verb, the target. The first share asks for the GitHub
 * App install; the fence opens the install page and shares again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionInfo, Project, dataManager } from '@sdk';
import { runTsFence, snippetDoc, tsFenceUnder } from '../utils/ts-snippets';

const PROJECT_ID = '3f0c2b1a-0000-4000-8000-0000000000a1';
const CLONE_URL = 'https://hub.test/api/v1/graph/git_repo/77/git';

function deskDouble() {
  const seen: string[] = [];
  let posts = 0;
  let shared = false;
  const spy = vi.spyOn(dataManager, 'callAction').mockImplementation(async (info: ActionInfo) => {
    expect(info.name).toBe('git_share');
    expect(info.targetEntity?.toString()).toBe(`project-${PROJECT_ID}`);
    seen.push(info.method);
    if (info.method === 'POST') {
      posts += 1;
      if (posts === 1) {
        return { status: 'install_required', repo: 'acme/api', install_url: 'https://github.com/apps/flowpad/installations/new' };
      }
      shared = true;
    }
    if (info.method === 'DELETE') shared = false;
    return shared
      ? { status: 'shared', repo: 'acme/api', git_repo: 'git_repo-77', clone_url: CLONE_URL, default_branch: 'main' }
      : { status: 'not_shared', repo: 'acme/api' };
  });
  return { seen, spy };
}

describe('project git share — the TypeScript fence', () => {
  afterEach(() => vi.restoreAllMocks());

  it('runs as written: install step, share, status, unshare', async () => {
    const { seen } = deskDouble();
    const project = new Project({ id: PROJECT_ID, name: 'api' } as never);
    vi.spyOn(Project, 'getById').mockResolvedValue(project as never);
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const ns = await runTsFence(tsFenceUnder(snippetDoc('project-git-share.md'), '6.'), {
      Project,
      projectId: PROJECT_ID,
    });

    expect(open).toHaveBeenCalledWith('https://github.com/apps/flowpad/installations/new', '_blank');
    expect(log).toHaveBeenCalledWith('shared', CLONE_URL);
    expect(ns.status).toMatchObject({ status: 'shared', clone_url: CLONE_URL, repo: 'acme/api' });
    expect(ns.stopped).toMatchObject({ status: 'not_shared', clone_url: null });
    expect(seen).toEqual(['POST', 'POST', 'GET', 'DELETE']);
  });

  it('reads an unknown or empty answer as not shared', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({ status: 'surprise' } as never);
    const project = new Project({ id: PROJECT_ID, name: 'api' } as never);
    expect(await project.gitShare()).toEqual({
      status: 'not_shared',
      repo: '',
      git_repo: null,
      clone_url: null,
      install_url: null,
      default_branch: 'main',
    });
  });
});
