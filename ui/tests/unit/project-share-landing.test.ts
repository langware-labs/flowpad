/**
 * The project share landing's hand-offs: the browser card's hub page, and the
 * desktop path "Open in FlowPad" sends — the `?action=open` link
 * `IncomingDeepLink` reads — plus the clone command both landings show.
 */
import { type GitOrigin, gitCloneCommand } from '@sdk';
import { describe, expect, it } from 'vitest';
import { projectHubPath, projectOpenTargetPath } from '@src/pages/entry/project-share-landing';

const ID = '3b91d0a8-0080-42b4-a4cf-d3ed9967678e';
const ORIGIN: GitOrigin = {
  kind: 'git',
  provider: 'github',
  owner: 'langware-labs',
  name: 'hello-flowpad-task',
  branch: 'main',
  rel_path: '.',
};

describe('projectHubPath', () => {
  it('is the project on the hub page', () => {
    expect(projectHubPath(ID)).toBe(`/dock/hub/project/${ID}`);
  });
});

describe('gitCloneCommand', () => {
  it('clones the branch the origin names', () => {
    expect(gitCloneCommand(ORIGIN)).toBe('git clone -b main https://github.com/langware-labs/hello-flowpad-task.git');
  });

  it('leaves the branch to the remote default when the origin names none', () => {
    expect(gitCloneCommand({ ...ORIGIN, branch: '' })).toBe(
      'git clone https://github.com/langware-labs/hello-flowpad-task.git',
    );
  });
});

describe('projectOpenTargetPath', () => {
  const target = projectOpenTargetPath({ id: ID, name: 'hello-flowpad-task-2', gitOrigin: ORIGIN });
  const [path, query] = target.split('?');
  const params = new URLSearchParams(query);

  it('lands on the desktop home, where IncomingDeepLink reads it', () => {
    expect(path).toBe('/');
  });

  it('asks for the git setup of THIS shared project, by id', () => {
    expect(params.get('action')).toBe('open');
    expect(params.get('setup_git')).toBe('1');
    expect(params.get('project_id')).toBe(ID);
    expect(params.get('title')).toBe('hello-flowpad-task-2');
  });

  it('carries the git origin as the JSON IncomingDeepLink parses', () => {
    expect(JSON.parse(params.get('git_origin') ?? 'null')).toEqual(ORIGIN);
  });
});
