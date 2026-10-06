/**
 * TS SDK contract for the project dependency actions (`flow.json`).
 *
 * Each verb posts its action with the documented body, and the ones that change
 * what resolves ADOPT the response's context fields (`include_dirs`,
 * `context_roots`, `context_dir_infos`) rather than guessing locally — the
 * server canonicalizes paths, so a local guess can diverge.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dataManager, onProjectDependenciesChanged, Project, type DependencyState } from '@sdk';

let seq = 0;
function makeProject(dirs: string[] = []): Project {
  // A fresh id each time: the SDK registers every constructed entity by id.
  seq += 1;
  return new Project({
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    type: 'project',
    name: 'deps-proj',
    include_dirs: dirs,
  } as Partial<Project>);
}

const STATE: DependencyState = {
  name: 'notes',
  source: 'file:/users/alice/notes',
  required: true,
  path: '.',
  state: 'ready',
  local_path: '/users/alice/notes',
  reason: null,
  via: null,
  dismissed: false,
};

const CONTEXT = {
  include_dirs: ['/users/alice/notes'],
  context_roots: ['/w/deps-proj', '/users/alice/notes'],
  context_dir_infos: [
    { path: '/users/alice/notes', origin_kind: 'local', typeid: 'folder-1', dependency: 'notes', required: true, via: '' },
  ],
};

type Call = { name?: string; method?: string; bodyParameters?: Record<string, unknown> };
const callOf = (spy: { mock: { calls: unknown[][] } }, i = 0) => spy.mock.calls[i][0] as Call;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Project.dependencies', () => {
  it('GETs dependencies and returns the states with the warnings', async () => {
    const project = makeProject();
    const missing = { ...STATE, name: 'docs', state: 'missing' as const, local_path: null, reason: 'not cloned' };
    const spy = vi
      .spyOn(dataManager, 'callAction')
      .mockResolvedValue({ dependencies: [STATE, missing], warnings: [missing], resolving: true });

    const result = await project.dependencies();

    expect(result).toEqual({ dependencies: [STATE, missing], warnings: [missing], resolving: true });
    expect(callOf(spy).name).toBe('dependencies');
    expect(callOf(spy).method).toBe('GET');
  });

  it('reads an empty answer as no dependencies', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue(undefined);
    await expect(makeProject().dependencies()).resolves.toEqual({ dependencies: [], warnings: [], resolving: false });
  });
});

describe('Project.addDependency', () => {
  it('posts the source with its options and adopts the server-computed context', async () => {
    const project = makeProject();
    const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ dependency: STATE, ...CONTEXT });

    const state = await project.addDependency('/Users/Alice/Notes/', { optional: true, name: 'notes' });

    expect(state).toEqual(STATE);
    expect(callOf(spy).name).toBe('add-dependency');
    expect(callOf(spy).bodyParameters).toEqual({ source: '/Users/Alice/Notes/', optional: true, name: 'notes' });
    expect(project.include_dirs).toEqual(CONTEXT.include_dirs);
    expect(project.context_roots).toEqual(CONTEXT.context_roots);
    expect(project.context_dir_infos).toEqual(CONTEXT.context_dir_infos);
  });

  it('sends only the source when no options are given', async () => {
    const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ dependency: STATE, ...CONTEXT });
    await makeProject().addDependency('hub:00000000-0000-4000-8000-0000000000aa');
    expect(callOf(spy).bodyParameters).toEqual({ source: 'hub:00000000-0000-4000-8000-0000000000aa' });
  });

  it('rejects when the backend refuses the source', async () => {
    vi.spyOn(dataManager, 'callAction').mockRejectedValue(new Error('not a dependency source: ftp://x'));
    await expect(makeProject().addDependency('ftp://x')).rejects.toThrow('not a dependency source');
  });
});

describe('Project.removeDependency', () => {
  it('posts the name and adopts the response instead of filtering locally', async () => {
    const project = makeProject(['/a', '/b']);
    const spy = vi
      .spyOn(dataManager, 'callAction')
      .mockResolvedValue({ dependencies: [], include_dirs: ['/b'], context_roots: ['/w', '/b'], context_dir_infos: [] });

    const states = await project.removeDependency('a');

    expect(states).toEqual([]);
    expect(callOf(spy).name).toBe('remove-dependency');
    expect(callOf(spy).bodyParameters).toEqual({ name: 'a' });
    expect(project.include_dirs).toEqual(['/b']);
  });

  it('keeps the local list untouched when the response carries no context', async () => {
    const project = makeProject(['/existing']);
    vi.spyOn(dataManager, 'callAction').mockResolvedValue(undefined);
    await project.removeDependency('x');
    expect(project.include_dirs).toEqual(['/existing']);
  });
});

describe('Project.resolveDependencies', () => {
  it('posts resolve-dependencies, with update only when asked', async () => {
    const project = makeProject();
    const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ dependencies: [STATE], ...CONTEXT });

    await expect(project.resolveDependencies()).resolves.toEqual([STATE]);
    await project.resolveDependencies({ update: true });

    expect(callOf(spy, 0).name).toBe('resolve-dependencies');
    expect(callOf(spy, 0).bodyParameters).toEqual({});
    expect(callOf(spy, 1).bodyParameters).toEqual({ update: true });
    expect(project.include_dirs).toEqual(CONTEXT.include_dirs);
  });
});

describe('Project.installDependency', () => {
  it('posts the name and adopts the context', async () => {
    const project = makeProject();
    const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ dependency: STATE, ...CONTEXT });

    await expect(project.installDependency('notes')).resolves.toEqual(STATE);

    expect(callOf(spy).name).toBe('install-dependency');
    expect(callOf(spy).bodyParameters).toEqual({ name: 'notes' });
    expect(project.include_dirs).toEqual(CONTEXT.include_dirs);
  });
});

describe('Project.dismissDependencyWarning', () => {
  it('posts the name', async () => {
    const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ dismissed: 'docs' });
    await makeProject().dismissDependencyWarning('docs');
    expect(callOf(spy).name).toBe('dismiss-dependency-warning');
    expect(callOf(spy).bodyParameters).toEqual({ name: 'docs' });
  });
});

describe('Project.adoptHelpdeskFromGit', () => {
  it('posts url, branch and optional — no scope', async () => {
    const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ outcome: 'adopted' });
    await makeProject().adoptHelpdeskFromGit('https://github.com/acme/desk', 'main', true);
    expect(callOf(spy).name).toBe('adopt-helpdesk-from-git');
    expect(callOf(spy).bodyParameters).toEqual({ url: 'https://github.com/acme/desk', branch: 'main', optional: true });
  });
});

describe('onProjectDependenciesChanged', () => {
  it('fires for every dependency verb on that project, failures included, and not for others', async () => {
    const project = makeProject();
    const listener = vi.fn();
    const elsewhere = vi.fn();
    const off = onProjectDependenciesChanged(project.id, listener);
    const offElsewhere = onProjectDependenciesChanged('00000000-0000-4000-8000-00000000ffff', elsewhere);
    const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue({ dependency: STATE, dependencies: [], ...CONTEXT });

    await project.addDependency('/x');
    await project.removeDependency('x');
    await project.installDependency('x');
    await project.resolveDependencies();
    await project.dismissDependencyWarning('x');
    await project.adoptHelpdeskFromGit('https://github.com/acme/desk');
    expect(listener).toHaveBeenCalledTimes(6);

    spy.mockRejectedValue(new Error('refused'));
    await expect(project.addDependency('ftp://x')).rejects.toThrow('refused');
    expect(listener).toHaveBeenCalledTimes(7);

    // Reading is not a change.
    spy.mockResolvedValue({ dependencies: [], warnings: [], resolving: false });
    await project.dependencies();
    expect(listener).toHaveBeenCalledTimes(7);
    expect(elsewhere).not.toHaveBeenCalled();

    off();
    offElsewhere();
    await project.removeDependency('x');
    expect(listener).toHaveBeenCalledTimes(7);
  });
});
