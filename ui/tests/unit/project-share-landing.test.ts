/**
 * The project share landing (FLOWPAD-2177, part 2) — the paths it is built on.
 *
 * `projectShareLandingPath` is what `Project.share` sends as the invitation's
 * `callback_override` (its Python twin is `project_share_landing_path`), and
 * `projectOpenTargetPath` is what "Open in FlowPad" hands the desktop: the
 * `?action=open` link `IncomingDeepLink` reads. These pin both ends of that
 * hand-off, so a rename on either side fails here instead of in an inbox.
 */
import { type GitOrigin } from '@sdk';
import { describe, expect, it } from 'vitest';
import { hubProjectPath, projectOpenTargetPath, projectShareLandingPath } from '@src/pages/entry/project-share-landing';

const ID = '3b91d0a8-0080-42b4-a4cf-d3ed9967678e';
const ORIGIN: GitOrigin = {
  kind: 'git',
  provider: 'github',
  owner: 'langware-labs',
  name: 'hello-flowpad-task',
  branch: 'main',
  rel_path: '.',
};

describe('projectShareLandingPath', () => {
  it('is the path the share sends and the SPA routes to ProjectShareLanding', () => {
    expect(projectShareLandingPath(ID)).toBe(`/project/${ID}`);
  });
});

describe('hubProjectPath', () => {
  it('is the project on the hub page', () => {
    expect(hubProjectPath(ID)).toBe(`/dock/hub/project/${ID}`);
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
