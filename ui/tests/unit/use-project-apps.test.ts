/** Which app a project opens for each audience, and the address it opens at. */
import { describe, expect, it } from 'vitest';
import { WebApp } from '@sdk';
import { pickProjectApps, projectAppDock } from '@src/components/top-nav-bar/use-project-apps';
import { CONSUMER_PROJECT_PARAM, PROVIDER_PROJECT_PARAM } from '@src/project-home-page/dependency-home';

const id = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const app = (n: number, fields: Record<string, unknown>) =>
  new WebApp({ id: id(n), type: 'micro_app', name: `app${n}`, ...fields });

const names = (picked: ReturnType<typeof pickProjectApps>) => picked.map((entry) => entry.app.name);

describe('pickProjectApps', () => {
  it('reads an app with no mounts as a user app, and an admin mount as an admin app', () => {
    const picked = pickProjectApps(
      [app(2, { project_id: 'p1', mounts: [{ audience: 'admin', path: '' }] }), app(1, { project_id: 'p1' })],
      ['p1'],
    );
    expect(picked.map((entry) => [entry.app.name, entry.app.audience])).toEqual([
      ['app1', 'app'],
      ['app2', 'admin'],
    ]);
  });

  it('never counts an editor or a viewer', () => {
    const picked = pickProjectApps(
      [
        app(1, { project_id: 'p1', kind: 'application.web.editor' }),
        app(2, { project_id: 'p1', kind: 'application.web.viewer' }),
        app(3, { project_id: 'p1', kind: 'application.web.editor.advanced' }),
      ],
      ['p1'],
    );
    expect(picked).toEqual([]);
  });

  it("lists the project's apps before a dependency's, each with the project that ships it", () => {
    const picked = pickProjectApps(
      [
        app(1, { project_id: 'dep' }),
        app(2, { project_id: 'dep', mounts: [{ audience: 'admin' }] }),
        app(3, { project_id: 'p1' }),
      ],
      ['p1', 'dep'],
    );
    expect(names(picked)).toEqual(['app3', 'app1', 'app2']);
    expect(picked.map((entry) => entry.providerProjectId)).toEqual(['p1', 'dep', 'dep']);
  });

  it("puts an audience's root app first", () => {
    const picked = pickProjectApps(
      [
        app(1, { project_id: 'p1', mounts: [{ audience: 'app', path: 'docs' }] }),
        app(2, { project_id: 'p1', mounts: [{ audience: 'app', path: '' }] }),
      ],
      ['p1'],
    );
    expect(names(picked)).toEqual(['app2', 'app1']);
  });

  it('ignores apps of other projects', () => {
    expect(pickProjectApps([app(1, { project_id: 'other' })], ['p1'])).toEqual([]);
  });
});

describe('projectAppDock', () => {
  it('opens the app in the project and names it as the provider', () => {
    const dock = projectAppDock({ app: app(1, { project_id: 'p1' }), providerProjectId: 'p1' }, 'p1');
    expect(dock.pointer).toBe(`micro_app-${id(1)}`);
    expect(dock.options?.[PROVIDER_PROJECT_PARAM]).toBe('p1');
    expect(dock.options?.[CONSUMER_PROJECT_PARAM]).toBeUndefined();
  });

  it("opens a dependency's app with both projects named", () => {
    const dock = projectAppDock({ app: app(1, { project_id: 'dep' }), providerProjectId: 'dep' }, 'p1');
    expect(dock.options?.[PROVIDER_PROJECT_PARAM]).toBe('dep');
    expect(dock.options?.[CONSUMER_PROJECT_PARAM]).toBe('p1');
  });
});
