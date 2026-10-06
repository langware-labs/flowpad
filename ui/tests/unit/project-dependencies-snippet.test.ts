/**
 * `docs/snippets/project-dependencies.md` §7, the TypeScript fence, run as written.
 *
 * The real `Project` and the real `dataManager` — only `callAction` is answered, by a
 * double that plays the desk's project dependency routes and checks each request: the
 * action, the verb, the target and the body.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionInfo, Project, dataManager } from '@sdk';
import { runTsFence, snippetDoc, tsFenceUnder } from '../utils/ts-snippets';

const PROJECT_ID = '3f0c2b1a-0000-4000-8000-0000000000d7';
const OS_SOURCE = 'git+https://github.com/langware-labs/langware-os#main';

const state = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  source: name === 'langware-os' ? OS_SOURCE : `hub:${name}`,
  required: name !== 'policies',
  path: '.',
  state: 'ready',
  local_path: `/work/${name}`,
  reason: null,
  via: null,
  dismissed: false,
  ...extra,
});

function deskDouble() {
  const calls: { name: string; method: string; body: unknown }[] = [];
  vi.spyOn(dataManager, 'callAction').mockImplementation((info: ActionInfo) => {
    expect(info.targetEntity?.toString()).toBe(`project-${PROJECT_ID}`);
    calls.push({ name: info.name, method: info.method, body: info.bodyParameters });
    const context = { include_dirs: ['/work/langware-os'], context_roots: ['/work/site', '/work/langware-os'], context_dir_infos: [] };
    switch (info.name) {
      case 'dependencies':
        return Promise.resolve({
          dependencies: [state('langware-os'), state('gone', { state: 'unreachable', reason: 'repository not found' })],
          warnings: [state('gone', { state: 'unreachable', reason: 'repository not found' })],
          resolving: false,
        });
      case 'add-dependency':
        return Promise.resolve({ dependency: state('langware-os'), ...context });
      case 'install-dependency':
        return Promise.resolve({ dependency: state('policies'), ...context });
      case 'dismiss-dependency-warning':
        return Promise.resolve({ dismissed: (info.bodyParameters as { name: string }).name });
      default:
        throw new Error(`unexpected action ${info.name}`);
    }
  });
  return calls;
}

describe('project dependencies — the TypeScript fence', () => {
  afterEach(() => vi.restoreAllMocks());

  it('runs as written: list, add, install, dismiss every warning', async () => {
    const calls = deskDouble();
    const project = new Project({ id: PROJECT_ID, name: 'site' } as never);
    vi.spyOn(Project, 'getById').mockResolvedValue(project as never);

    const ns = await runTsFence(tsFenceUnder(snippetDoc('project-dependencies.md'), '7.', { lang: 'ts' }), {
      Project,
      projectId: PROJECT_ID,
    });

    expect((ns.added as { state: string }).state).toBe('ready');
    expect(calls.map((c) => `${c.method} ${c.name}`)).toEqual([
      'GET dependencies',
      'POST add-dependency',
      'POST install-dependency',
      'POST dismiss-dependency-warning',
    ]);
    expect(calls[1].body).toMatchObject({ source: OS_SOURCE });
    expect(calls[3].body).toEqual({ name: 'gone' });
    expect(project.context_roots).toEqual(['/work/site', '/work/langware-os']); // adopted from the response
  });
});
